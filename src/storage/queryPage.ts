import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Compiled } from "../core/engine.ts";
import { canonical, compare, type Entity, type Value } from "../core/model.ts";
import type { Query } from "../core/queryKind.ts";
import { conditions, evaluator } from "../core/rules.ts";
import { realDate } from "../core/values.ts";
import { BadCursor } from "../Errors.ts";
import { exceptionalText } from "./cells.ts";
import { querySql } from "./querySql.ts";

export type QueryOptions = { limit?: number; after?: string; match?: "true" | "unknown" };
type Keyset = { id: string; values: (Value | null)[] };
const keyset = (query: Query, entity: Entity): Keyset => ({
  id: entity.id,
  values: query.order_by.map(({ attribute }) => entity.facts[attribute] ?? null),
});
const binding = (account: string, version: number, source: "inline" | "stored", query: Query, match: string) =>
  createHash("sha256")
    .update(canonical([account, version, source, query, match]))
    .digest("base64url");

function decodeCursor(cursor: string, fingerprint: string, query: Query, config: Compiled): Keyset | undefined {
  if (cursor.length > 250_000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return;
    const decoded: unknown = JSON.parse(bytes.toString());
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== fingerprint) return;
    const [, id, values] = decoded;
    if (typeof id !== "string" || !/^en_[A-Za-z0-9_-]{21}$/.test(id) || !Array.isArray(values) || values.length !== query.order_by.length)
      return;
    if (
      !query.order_by.every(({ attribute }, i) => {
        const value: unknown = values[i];
        if (value === null) return true;
        const name = config.cells.get(attribute)!.column;
        return name === "n"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === "string" && (name !== "d" || realDate(value));
      })
    )
      return;
    return { id, values };
  } catch {
    return;
  }
}

export function pageStatement(
  sql: SqlClient.SqlClient,
  account: string,
  query: Query,
  config: Compiled,
  limit: number,
  match: NonNullable<QueryOptions["match"]>,
  after?: Keyset,
) {
  const builder = querySql(sql, account, query.shape, config.cells);
  const predicate = builder.compile(query.where ?? true);
  const seed = match === "true" ? predicate.yes : undefined;
  const indexedOrder =
    seed?.exact && query.order_by.length === 1 && seed.ordered?.attribute === query.order_by[0]!.attribute ? seed.ordered : undefined;
  const order = query.order_by.map(({ attribute, direction }, i) => ({
    value: indexedOrder ? sql`q.sort_value` : builder.orderValue(attribute),
    column: config.cells.get(attribute)!.column,
    direction,
    alias: sql(`key_${i}`),
  }));
  const id = sql`q.entity_id COLLATE "C"`;
  let beyond = after ? sql`${id} > ${after.id}` : sql`TRUE`;
  if (after) {
    for (let i = order.length - 1; i >= 0; i--) {
      const { value, column, direction } = order[i]!;
      const boundary = after.values[i]!;
      if (indexedOrder && boundary === null) beyond = sql`FALSE`;
      else if (boundary === null) beyond = sql`${value} IS NULL AND (${beyond})`;
      else {
        const key = builder.parameter(boundary, column);
        const inequality = direction === "asc" ? sql`${value} > ${key}` : sql`${value} < ${key}`;
        if (indexedOrder && direction === "asc") beyond = sql`(${value},${id}) > (${key},${after.id})`;
        else if (indexedOrder) beyond = sql`${value} <= ${key} AND (${inequality} OR (${value} = ${key} AND (${beyond})))`;
        else beyond = sql`(${value} IS NULL OR ${inequality} OR (${value} = ${key} AND (${beyond})))`;
      }
    }
  }
  // Candidate sets only narrow the scan. A non-exact seed still has to
  // satisfy the full SQL truth table, including every missing cell.
  const verdict = seed?.exact ? sql`TRUE` : match === "true" ? sql`(${predicate.boolean}) IS TRUE` : sql`(${predicate.boolean}) IS NULL`;
  const ordered = order.map(({ alias, direction }) => (direction === "asc" ? sql`${alias} ASC NULLS LAST` : sql`${alias} DESC NULLS LAST`));
  ordered.push(sql`${id} ASC`);
  const columns = order.map(({ alias, value }) => sql`,${value} AS ${alias}`);
  const source = seed
    ? sql`(${indexedOrder?.statement ?? seed.statement}) q JOIN entities e ON e.account_id=${account} AND e.id=q.entity_id COLLATE "default"`
    : sql`events q JOIN entities e ON e.account_id=q.account_id AND e.id=q.entity_id COLLATE "default"`;
  const scope = seed ? sql`TRUE` : sql`q.account_id=${account} AND q.kind='create' AND q.shape=${query.shape}`;
  return sql<{ document: string }>`SELECT e.document ${sql.join("", false)(columns)}
    FROM ${source} WHERE ${scope} AND NOT e.deleted AND (${verdict}) AND (${beyond})
    ORDER BY ${sql.join(",", false)(ordered)} LIMIT ${limit}`;
}

function compareKeys(query: Query, a: Keyset, b: Keyset): number {
  for (let i = 0; i < query.order_by.length; i++) {
    const l = a.values[i]!,
      r = b.values[i]!;
    if (l === r) continue;
    if (l === null) return 1;
    if (r === null) return -1;
    const order = typeof l === "number" && typeof r === "number" ? (l < r ? -1 : 1) : compare(String(l), String(r));
    return query.order_by[i]!.direction === "asc" ? order : -order;
  }
  return compare(a.id, b.id);
}

function memoryPage(
  sql: SqlClient.SqlClient,
  account: string,
  query: Query,
  limit: number,
  match: NonNullable<QueryOptions["match"]>,
  after: Keyset | undefined,
) {
  return Effect.gen(function* () {
    const evaluate = evaluator(query.where ?? true);
    const compareRows = (a: { key: Keyset }, b: { key: Keyset }) => compareKeys(query, a.key, b.key);
    let id = query.order_by.length ? "" : (after?.id ?? "");
    let best: { entity: Entity; key: Keyset }[] = [];
    while (true) {
      const rows = yield* sql<{ id: string; document: string }>`
        SELECT e.id,e.document FROM events q JOIN entities e ON e.account_id=q.account_id AND e.id=q.entity_id COLLATE "default"
        WHERE q.account_id=${account} AND q.kind='create' AND q.shape=${query.shape} AND NOT e.deleted
          AND q.entity_id COLLATE "C" > ${id}
        ORDER BY q.entity_id COLLATE "C" LIMIT 2000`;
      if (!rows.length) break;
      for (const { document } of rows) {
        const entity = JSON.parse(document) as Entity;
        const key = keyset(query, entity);
        if ((!after || compareKeys(query, key, after) > 0) && evaluate(entity.facts) === (match === "true" ? "T" : "U"))
          best.push({ entity, key });
      }
      best = best.sort(compareRows).slice(0, limit);
      if (!query.order_by.length && best.length === limit) break;
      id = rows.at(-1)!.id;
    }
    return best.map(({ entity }) => entity);
  });
}

export const queryPage = (
  sql: SqlClient.SqlClient,
  account: string,
  version: number,
  source: "inline" | "stored",
  query: Query,
  config: Compiled,
  { limit = 50, match = "true", after: cursor }: QueryOptions,
) =>
  Effect.gen(function* () {
    const fingerprint = binding(account, version, source, query, match);
    const after = cursor === undefined ? undefined : decodeCursor(cursor, fingerprint, query, config);
    if (cursor !== undefined && after === undefined) return yield* Effect.fail(new BadCursor());
    const leaves = conditions(query.where ?? true).map(({ node }) => node);
    const exceptional = (value: unknown) => typeof value === "string" && exceptionalText(value);
    const attributes = [
      ...new Set([
        ...leaves.filter(({ operator }) => operator !== "exists" && operator !== "doesNotExist").map(({ fact }) => fact),
        ...query.order_by.map(({ attribute }) => attribute),
      ]),
    ];
    const exceptionalOperand = leaves.some(({ value }) => (Array.isArray(value) ? value.some(exceptional) : exceptional(value)));
    // Bound generated SQL for very wide legal rule trees.
    const inMemory = leaves.length > 500 || exceptionalOperand || after?.values.some(exceptional);
    const [check] =
      attributes.length && !inMemory
        ? yield* sql<{ found: boolean }>`SELECT EXISTS (
        SELECT 1 FROM cells WHERE account_id=${account} AND shape=${query.shape} AND attribute IN ${sql.in(attributes)} AND exceptional
      ) AS found`
        : [];
    const entities =
      inMemory || check?.found
        ? yield* memoryPage(sql, account, query, limit + 1, match, after)
        : (yield* pageStatement(sql, account, query, config, limit + 1, match, after)).map(
            ({ document }) => JSON.parse(document) as Entity,
          );
    const data = entities.slice(0, limit);
    const next = entities.length > limit ? keyset(query, data.at(-1)!) : undefined;
    return { data, next_after: next ? Buffer.from(JSON.stringify([fingerprint, next.id, next.values])).toString("base64url") : null };
  });
