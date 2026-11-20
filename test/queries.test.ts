import { afterAll, beforeAll, expect, test } from "vitest";
import fc from "fast-check";
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { dataLayer } from "../src/composition.ts";
import { compare, type Condition, type Entity, type Facts, type Registry, type Rule, type Value } from "../src/core/model.ts";
import type { Query } from "../src/core/queryKind.ts";
import { evaluator } from "../src/core/rules.ts";
import { migrate } from "../src/Migrations.ts";
import { Store, type StoreValue } from "../src/storage/Store.ts";

const runtime = ManagedRuntime.make(
  dataLayer([]).pipe(
    Layer.provideMerge(
      PgClient.layer({
        url: Redacted.make(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/onb_data_test"),
      }),
    ),
  ),
);
const run = Effect.runPromise;
const account = () => `acct_query_${randomBytes(8).toString("hex")}`;
let store: StoreValue;
beforeAll(async () => {
  await runtime.runPromise(migrate);
  store = await runtime.runPromise(Store);
}, 30_000);
afterAll(() => runtime.dispose());

const fields = [
  {
    key: "x/text",
    type: "string",
    values: ["", "é", "É", "İ", "i\u0307", "ΟΣ", "ος", "οσ", "𐐀", "𐐨", "🧪", "a%_", "a".repeat(1600) + "x", "a".repeat(1600) + "y"],
  },
  { key: "x/integer", type: "integer", values: [Number.MIN_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER] },
  {
    key: "x/number",
    type: "number",
    values: [-Number.MAX_VALUE, -Number.MIN_VALUE, 0, Number.MIN_VALUE, 0.3, 0.1 + 0.2, Number.MAX_VALUE],
  },
  { key: "x/boolean", type: "boolean", values: [false, true] },
  { key: "x/date", type: "date", values: ["0000-02-29", "0001-01-01", "1900-03-01", "2000-02-29", "9999-12-31"] },
  { key: "x/enum", type: "enum", values: ["É", "é", "İ", "i", "i\u0307"] },
];
const orderable = fields.filter(({ type }) => type !== "boolean").map(({ key }) => key);
const factRows = fc.array(fc.tuple(...fields.map(({ values }) => fc.option(fc.constantFrom<Value>(...values), { nil: undefined }))), {
  minLength: 5,
  maxLength: 7,
});
const comparisons = ["equal", "notEqual", "in", "notIn", "exists", "doesNotExist"];
const ranges = ["lessThan", "lessThanInclusive", "greaterThan", "greaterThanInclusive"];
const condition = fc.oneof(
  ...fields.map(({ key, type, values }) => {
    const value = fc.constantFrom<Value>(...values, ...(type === "integer" ? [0.25, 2 ** 53] : []));
    const ops = [...comparisons, ...(["integer", "number", "date"].includes(type) ? ranges : [])];
    if (type === "string") ops.push("contains", "doesNotContain");
    return fc.tuple(fc.constantFrom(...ops), value, value, fc.boolean()).map(
      ([operator, a, b, ignoreCase]): Condition => ({
        fact: key,
        operator,
        ...(!["exists", "doesNotExist"].includes(operator) && { value: ["in", "notIn"].includes(operator) ? [a, b] : a }),
        ...(["string", "enum"].includes(type) && { ignore_case: ignoreCase }),
      }),
    );
  }),
);
const rule: fc.Arbitrary<Rule> = fc.letrec<{ rule: Rule }>((tie) => ({
  rule: fc.oneof(
    { depthSize: "small", maxDepth: 5 },
    condition,
    fc.boolean(),
    fc.array(tie("rule"), { maxLength: 4 }).map((all) => ({ all })),
    fc.array(tie("rule"), { maxLength: 4 }).map((any) => ({ any })),
    tie("rule").map((not) => ({ not })),
  ),
})).rule;
const sort = fc.uniqueArray(fc.tuple(fc.constantFrom(...orderable), fc.constantFrom("asc" as const, "desc" as const)), {
  maxLength: 3,
  selector: ([attribute]) => attribute,
});
const deep = (leaf: Rule) => Array.from({ length: 19 }).reduce<Rule>((child) => ({ not: child }), leaf);
const guaranteed: Rule[] = [
  { fact: "x/text", operator: "in", value: ["é", "ΟΣ"] },
  { fact: "x/text", operator: "notIn", value: ["é", "ΟΣ"] },
  { fact: "x/text", operator: "equal", value: "ος", ignore_case: true },
  { fact: "x/text", operator: "contains", value: "𐐨", ignore_case: true },
  { fact: "x/text", operator: "doesNotContain", value: "%_" },
  { fact: "x/text", operator: "equal", value: "a".repeat(1600) + "y" },
  { fact: "x/integer", operator: "lessThanInclusive", value: Number.MAX_SAFE_INTEGER },
  { fact: "x/number", operator: "lessThan", value: Number.MIN_VALUE },
  { fact: "x/date", operator: "greaterThan", value: "0000-02-29" },
  deep({ fact: "x/integer", operator: "notIn", value: [Number.MIN_SAFE_INTEGER] }),
  { all: [] },
  { any: [] },
];
const boundaryRows: Facts[] = [
  {},
  Object.fromEntries(fields.map(({ key, values }) => [key, values[0]!])),
  Object.fromEntries(fields.map(({ key, values }) => [key, values.at(-1)!])),
  { "x/text": "ΟΣ", "x/enum": "É", "x/date": "0001-01-01" },
  { "x/text": "𐐀", "x/integer": 0, "x/number": 0.3 },
  { "x/text": "a%_", "x/boolean": false, "x/number": 0.1 + 0.2 },
];

function sortEntities(query: Query, a: Entity, b: Entity) {
  for (const { attribute, direction } of query.order_by) {
    const aValue = a.facts[attribute],
      bValue = b.facts[attribute];
    if (aValue === bValue) continue;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;
    const order =
      typeof aValue === "number" && typeof bValue === "number" ? (aValue < bValue ? -1 : 1) : compare(String(aValue), String(bValue));
    return direction === "asc" ? order : -order;
  }
  return compare(a.id, b.id);
}

test("220 generated registries, datasets and rules agree with SQL T, F, U and randomized keyset walks", async () => {
  let caseIndex = 0;
  await fc.assert(
    fc.asyncProperty(
      rule,
      factRows,
      sort,
      fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 8 }),
      fc.boolean(),
      async (generated, rows, ordering, limits, hide) => {
        const i = caseIndex++;
        const a = account();
        const attributes: Registry["attributes"] = fields.map(({ key, type, values }) =>
          type === "enum" ? { key, type, values: i % 2 ? [...(values as string[]), "extra"] : (values as string[]) } : { key, type },
        );
        attributes.push({ key: "x/hidden", type: "string" });
        const shape = { key: "item", attributes: attributes.map(({ key }) => key) };
        const query: Query = {
          id: "differential",
          shape: "item",
          where: guaranteed[i] ?? generated,
          order_by: ordering.map(([attribute, direction]) => ({ attribute, direction })),
        };
        const registry: Registry = { attributes, shapes: [shape], automations: [], queries: [query] };
        await run(store.apply(a, "test", registry, 0));
        const factSet =
          i < guaranteed.length
            ? boundaryRows
            : rows.map((row) => Object.fromEntries(row.flatMap((value, j) => (value === undefined ? [] : [[fields[j]!.key, value]]))));
        const entities = await Promise.all(
          factSet.map((facts) =>
            run(
              store.mutate(a, "test", {
                shape: "item",
                facts: { ...facts, "x/hidden": "retained" },
              }),
            ),
          ),
        );
        if (hide)
          await run(
            store.apply(
              a,
              "test",
              {
                ...registry,
                shapes: [{ ...shape, attributes: shape.attributes.filter((key) => key !== "x/hidden") }],
              },
              1,
            ),
          );
        const byVerdict = (verdict: "T" | "F" | "U") =>
          entities
            .filter(({ facts }) => evaluator(query.where!)(facts) === verdict)
            .sort((a, b) => sortEntities(query, a, b))
            .map(({ id }) => id);
        const truth: string[] = [],
          unknown: string[] = [];
        let cursor: string | null = null,
          pageIndex = 0;
        do {
          const page: Effect.Success<ReturnType<StoreValue["runQuery"]>> = await run(
            store.runQuery(a, query.id, {
              limit: limits[pageIndex++ % limits.length]!,
              ...(cursor === null ? {} : { after: cursor }),
            }),
          );
          if (hide) expect(page.data.every(({ facts }) => !Object.hasOwn(facts, "x/hidden"))).toBe(true);
          truth.push(...page.data.map(({ id }) => id));
          cursor = page.next_after;
          expect(pageIndex).toBeLessThan(entities.length + 2);
        } while (cursor !== null);
        unknown.push(...(await run(store.runQuery(a, query.id, { match: "unknown", limit: 200 }))).data.map(({ id }) => id));
        expect(truth).toEqual(byVerdict("T"));
        expect(unknown).toEqual(byVerdict("U"));
        expect(
          entities
            .filter(({ id }) => !truth.includes(id) && !unknown.includes(id))
            .sort((a, b) => sortEntities(query, a, b))
            .map(({ id }) => id),
        ).toEqual(byVerdict("F"));
      },
    ),
    { numRuns: 220, seed: 703 },
  );
}, 120_000);

test("cell type rebuild, ref operands, hidden legacy data, exceptional text and long sort keys", async () => {
  const a = account();
  const attrs: Registry["attributes"] = [
    { key: "x/value", type: "string" },
    { key: "x/link", type: "ref", target: "item" },
    { key: "x/number", type: "integer" },
  ];
  const r: Registry = { attributes: attrs, shapes: [{ key: "item", attributes: attrs.map(({ key }) => key) }], automations: [] };
  await run(store.apply(a, "test", r, 0));
  const long = "🧪".repeat(2000);
  const source = await run(store.mutate(a, "test", { shape: "item", facts: { "x/value": long, "x/number": 7 } }));
  const nul = await run(store.mutate(a, "test", { shape: "item", facts: { "x/value": "A\0Ω", "x/link": source.id } }));
  const lone = await run(store.mutate(a, "test", { shape: "item", facts: { "x/value": "\ud83e" } }));
  const q: Query = { id: "q", shape: "item", order_by: [{ attribute: "x/value", direction: "asc" }] };
  const first = await run(store.runQuery(a, q, { limit: 2 }));
  expect(first.data.map(({ id }) => id)).toEqual([nul.id, lone.id]);
  expect((await run(store.runQuery(a, q, { after: first.next_after! }))).data.map(({ id }) => id)).toEqual([source.id]);
  for (const [value, ids] of [
    ["a\0ω", [nul.id]],
    ["\ud83e", [lone.id, source.id]],
  ] as const) {
    const query: Query = { ...q, where: { fact: "x/value", operator: "contains", value, ignore_case: true } };
    expect((await run(store.runQuery(a, query, {}))).data.map(({ id }) => id)).toEqual(ids);
  }
  const ref: Query = { ...q, order_by: [], where: { fact: "x/link", operator: "equal", value: source.id } };
  expect((await run(store.runQuery(a, ref, {}))).data.map(({ id }) => id)).toEqual([nul.id]);
  await run(
    store.apply(
      a,
      "test",
      {
        ...r,
        attributes: [{ key: "x/value", type: "boolean" }, attrs[1]!, { key: "x/number", type: "number" }],
        shapes: [{ key: "item", attributes: ["x/link", "x/number"] }],
      },
      1,
    ),
  );
  const hidden = await run(store.sql<{ s: string; exceptional: boolean }>`SELECT s,exceptional FROM cells
    WHERE account_id=${a} AND entity_id=${nul.id} AND attribute='x/value'`);
  expect(hidden).toEqual([{ s: JSON.stringify("A\0Ω"), exceptional: true }]);
  const numeric: Query = {
    ...q,
    order_by: [{ attribute: "x/number", direction: "desc" }],
    where: { fact: "x/number", operator: "greaterThan", value: 6.9 },
  };
  expect((await run(store.runQuery(a, numeric, {}))).data.map(({ id, facts }) => [id, facts])).toEqual([[source.id, { "x/number": 7 }]]);
  await run(store.apply(a, "test", r, 2));
  expect((await run(store.runQuery(a, q, {}))).data.map(({ id }) => id)).toEqual([nul.id, lone.id, source.id]);
  await run(store.remove(a, "test", nul.id));
  expect(await run(store.sql`SELECT 1 FROM cells WHERE account_id=${a} AND entity_id=${nul.id}`)).toEqual([]);
});
