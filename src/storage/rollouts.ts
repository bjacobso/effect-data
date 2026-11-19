import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Compiled } from "../core/engine.ts";
import { compare, type Entity } from "../core/model.ts";
import { encodeValue } from "./encoding.ts";
import { slotKey, type LiveUnique, type Slot } from "./liveUnique.ts";
import { recordKey, type NewViolation, type ViolationChange, type ViolationRecord, type Violations } from "./violations.ts";

export type Rollout = {
  version: number;
  status: "running" | "done" | "superseded";
  processed: number;
  total: number | null;
  shapes: string[];
  phase: "release" | "claim";
  cursor: string;
};
type Reserve = (account: string, count: number) => Effect.Effect<{ tx: number; ms: number }, import("effect/sql/SqlError").SqlError>;

export function rollouts(sql: SqlClient.SqlClient, unique: LiveUnique, violations: Violations, reserve: Reserve) {
  const get = (account: string, running = false) =>
    sql<Rollout>`SELECT registry_version AS version,status,processed,total,shapes,phase,cursor
      FROM rollouts WHERE account_id=${account} ${running ? sql`AND status='running'` : sql``}
      ORDER BY registry_version DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]));

  const replace = (account: string, version: number, plan: { shapes: string[]; release: boolean } | undefined) => sql`
    , superseded AS (
      UPDATE rollouts SET status='superseded',finished_at=history.at FROM history
      WHERE account_id=${account} AND status='running' RETURNING 1
    )
    ${
      plan
        ? sql`
    , started AS (
      INSERT INTO rollouts(account_id,registry_version,status,shapes,phase,total,started_at,finished_at)
      SELECT ${account},${version},${plan.shapes.length ? "running" : "done"},
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(plan.shapes)}::jsonb)),
        ${plan.release ? "release" : "claim"},${plan.shapes.length ? null : 0},at,${plan.shapes.length ? sql`NULL` : sql`at`}
      FROM history WHERE (SELECT count(*) FROM superseded) <= 1
    )`
        : sql``
    }`;
  const nextAccount = (after: string) =>
    sql<{ account_id: string }>`SELECT account_id FROM rollouts WHERE status='running'
      ORDER BY (account_id<=${after}),account_id LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.account_id));

  const claim = (account: string) =>
    sql<Rollout>`SELECT registry_version AS version,status,processed,total,shapes,phase,cursor
      FROM rollouts WHERE account_id=${account} AND status='running' FOR UPDATE SKIP LOCKED`.pipe(Effect.map((rows) => rows[0]));

  const page = (account: string, shapes: string[], cursor: string, limit: number) =>
    sql<{ id: string; document: string; deleted: boolean }>`
      WITH candidates AS MATERIALIZED (
        SELECT c.entity_id FROM jsonb_array_elements_text(${JSON.stringify(shapes)}::jsonb) AS s(shape)
        CROSS JOIN LATERAL (
          SELECT entity_id FROM events WHERE account_id=${account} AND kind='create' AND shape=s.shape
            AND entity_id COLLATE "C">${cursor} ORDER BY entity_id COLLATE "C" LIMIT ${limit}
        ) c ORDER BY c.entity_id COLLATE "C" LIMIT ${limit}
      )
      SELECT e.id,e.document,e.deleted FROM candidates c JOIN entities e ON e.account_id=${account} AND e.id=c.entity_id
      ORDER BY e.id COLLATE "C" FOR NO KEY UPDATE OF e`;
  const count = (account: string, shapes: string[]) =>
    sql<{ total: number }>`SELECT count(*)::int AS total FROM events c
      JOIN entities e ON e.account_id=c.account_id AND e.id=c.entity_id AND NOT e.deleted
      WHERE c.account_id=${account} AND c.kind='create' AND c.shape IN ${sql.in(shapes)}`.pipe(Effect.map(([row]) => row!.total));

  const record = (account: string, version: number, existing: readonly ViolationRecord[], desired: NewViolation[]) =>
    Effect.gen(function* () {
      const before = new Map(existing.map((row) => [recordKey(row), row]));
      const after = new Map(desired.map((row) => [recordKey(row), row]));
      const resolved = existing.filter((v) => after.get(recordKey(v))?.encoded !== v.encoded);
      const opened = desired.filter((v) => before.get(recordKey(v))?.encoded !== v.encoded);
      if (!resolved.length && !opened.length) return;
      const allocation = yield* reserve(account, resolved.length + opened.length);
      const position = (index: number) => ({ tx: allocation.tx + index + 1, at: new Date(allocation.ms + index + 1).toISOString() });
      const changes: ViolationChange[] = resolved.map((v, index) => ({ ...v, ...position(index), status: "resolved" }));
      yield* violations.resolve(account, changes);
      if (opened.length) {
        const rows = yield* violations.open(
          account,
          version,
          opened.map((v, index) => ({ ...v, ...position(resolved.length + index) })),
        );
        changes.push(...rows.map((row) => ({ ...row, tx: Number(row.tx), status: "open" as const })));
      }
      yield* violations.deliver(account, changes);
    });

  const step = (account: string, job: Rollout, config: Compiled, limit: number) =>
    Effect.gen(function* () {
      const total = job.total ?? (yield* count(account, job.shapes));
      const scanned = yield* page(account, job.shapes, job.cursor, limit);
      const end = scanned.at(-1)?.id;
      if (end === undefined) {
        if (job.phase === "release")
          yield* sql`UPDATE rollouts SET phase='claim',cursor='',total=${total}
            WHERE account_id=${account} AND registry_version=${job.version}`;
        else
          yield* sql`UPDATE rollouts SET status='done',finished_at=${new Date().toISOString()},total=processed
            WHERE account_id=${account} AND registry_version=${job.version}`;
        return;
      }
      const rows = scanned.filter((row) => !row.deleted);
      if (rows.length) {
        const entities = rows.map((row) => JSON.parse(row.document) as Entity);
        const ids = rows.map((row) => row.id);
        const expected: Slot[] = [];
        const edges: (NewViolation & { target: string; targetShape: string })[] = [];
        for (const entity of entities)
          for (const [attribute, value] of Object.entries(config.visible(entity.shape, entity.facts))) {
            const edge = config.edges.get(attribute);
            if (config.unique.has(attribute)) expected.push({ entity_id: entity.id, attribute, encoded: encodeValue(value) });
            if (edge && job.phase === "claim")
              edges.push({
                entity_id: entity.id,
                attribute,
                encoded: encodeValue(value),
                issue: "dangling_reference",
                target: String(value),
                targetShape: edge.target,
              });
          }
        const desiredSlots = new Map(expected.map((slot) => [slotKey(slot.entity_id, slot.attribute), slot.encoded]));
        const storedSlots = yield* unique.get(account, ids);
        const valid = new Set<string>();
        const stale: Slot[] = [];
        for (const slot of storedSlots) {
          const key = slotKey(slot.entity_id, slot.attribute);
          if (desiredSlots.get(key) === slot.encoded) valid.add(key);
          else stale.push(slot);
        }
        if (job.phase === "release") yield* unique.release(account, stale);
        else {
          const missing = expected.filter((slot) => !valid.has(slotKey(slot.entity_id, slot.attribute)));
          // Take the value locks before reading open records. A writer may
          // have promoted this entity after the initial slot read.
          yield* unique.lock(account, missing);
          if (missing.length) {
            yield* unique.insert(account, missing, true);
            for (const slot of yield* unique.get(account, ids))
              if (desiredSlots.get(slotKey(slot.entity_id, slot.attribute)) === slot.encoded)
                valid.add(slotKey(slot.entity_id, slot.attribute));
          }
          const targets = [...new Set(edges.map(({ target }) => target))];
          const live = targets.length
            ? yield* sql<{ id: string; shape: string }>`
            SELECT e.id,c.shape FROM entities e JOIN events c ON c.account_id=e.account_id AND c.entity_id=e.id AND c.kind='create'
            WHERE e.account_id=${account} AND NOT e.deleted
              AND e.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(targets)}::jsonb))`
            : [];
          const targetShapes = new Map(live.map(({ id, shape }) => [id, shape]));
          const desired: NewViolation[] = [
            ...expected.filter((s) => !valid.has(slotKey(s.entity_id, s.attribute))).map((s) => ({ ...s, issue: "duplicate" as const })),
            ...edges.filter((edge) => targetShapes.get(edge.target) !== edge.targetShape),
          ];
          desired.sort((a, b) => compare(recordKey(a), recordKey(b)));
          yield* record(account, job.version, yield* violations.openFor(account, ids), desired);
        }
      }
      const processed = job.processed + (job.phase === "claim" ? rows.length : 0);
      yield* sql`UPDATE rollouts SET cursor=${end},total=${Math.max(total, processed)},processed=${processed}
        WHERE account_id=${account} AND registry_version=${job.version}`;
    });
  return { get, replace, nextAccount, claim, step };
}
