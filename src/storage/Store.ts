import { randomBytes } from "node:crypto";
import { Context, Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import { SqlError } from "effect/sql/SqlError";
import { Engine, type Compiled } from "../core/engine.ts";
import { liveRefs } from "./liveRefs.ts";
import { Clock } from "./Clock.ts";
import {
  type Registry,
  type Entity,
  type Facts,
  type Doc,
  type Action,
  type Value,
  canonical,
  compare,
  findShape,
  findAttribute,
  issue,
  decodeIssues,
} from "../core/model.ts";
import { merge, retain } from "../core/engine.ts";
import { ensure, ensureApplicable, NotFound, Conflict } from "../Errors.ts";
// JSON text inside jsonb preserves NUL and lone surrogates.
export const encodeValue = (v: unknown) => JSON.stringify(canonical(v));
export const decodeValue = (v: string): Value => JSON.parse(v);
export type Fact = {
  tx: number;
  at: string;
  attribute: string;
  op: string;
  value: string;
  reason: "api" | "automation" | "migration" | "reference";
  actor: string;
};
type Event = { tx: number; at: string; kind: string; shape: string; version: number; registry_version: number; created_at: string };
type Step = { entity: Entity; keys: string[]; before: Facts; actor: string; reason: string; kind: string };
type Delivery = { index: number; entity_id: string; automation_id: string; action: Doc };
export type Mutation = { shape?: string; facts: Record<string, unknown>; expected_version?: number };
export const StoreProbe = Context.Reference<{ phase: (name: string) => void; rows?: (count: number) => void } | undefined>(
  "data/StoreProbe",
  { defaultValue: () => undefined },
);
export const makeStore = (hashOverride?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      app = yield* Engine,
      clock = yield* Clock;
    const refs = liveRefs(sql);
    // Cascade and mutation row locks can form a cycle. Retry only when SQL
    // reports that the transaction was aborted as the deadlock victim.
    const writeTransaction = <A, E>(work: Effect.Effect<A, E>) =>
      sql.withTransaction(work).pipe(
        Effect.retry({
          while: (error) => error instanceof SqlError && error.reason._tag === "DeadlockError",
          times: 5,
          schedule: Schedule.jittered(Schedule.exponential("10 millis")),
        }),
      );
    function* insertBatches<A extends Record<string, unknown>>(rows: A[]) {
      if (!rows.length) return;
      const size = Math.floor(65_534 / Object.keys(rows[0]!).length);
      for (let i = 0; i < rows.length; i += size) {
        const [first, ...rest] = rows.slice(i, i + size);
        yield sql.insert([first!, ...rest]);
      }
    }
    const cache = new Map<string, Compiled>();
    const compiled = (account: string, version: number, registry: Registry) => {
      const key = canonical([account, version]);
      const c = cache.get(key) ?? app.compile(registry);
      cache.delete(key);
      cache.set(key, c);
      if (cache.size > 1000) cache.delete(cache.keys().next().value!);
      return c;
    };
    const getRegistry = (account: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ version: number; document: string }>`SELECT version,document FROM registries WHERE account_id=${account}`;
        return rows[0]
          ? { version: rows[0].version, registry: app.normalize(JSON.parse(rows[0].document) as Registry) }
          : { version: 0, registry: app.empty() };
      });
    const lock = (account: string, exclusive = false) =>
      exclusive
        ? sql`SELECT pg_advisory_xact_lock(hashtextextended(${account},0))`
        : sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${account},0))`;
    const live = (account: string) =>
      sql<{ document: string }>`SELECT document FROM entities WHERE account_id=${account} AND NOT deleted`.pipe(
        Effect.map((rows) => rows.map((r) => JSON.parse(r.document) as Entity)),
      );
    const getLive = (account: string, id: string, mode?: "write" | "delete" | "reference") =>
      Effect.gen(function* () {
        const locking =
          mode === "write"
            ? sql`FOR NO KEY UPDATE`
            : mode === "delete"
              ? sql`FOR UPDATE`
              : mode === "reference"
                ? sql`FOR KEY SHARE`
                : sql``;
        const rows = yield* sql<{ document: string }>`SELECT document FROM entities
          WHERE account_id=${account} AND id=${id} AND NOT deleted ${locking}`;
        if (!rows[0]) return yield* Effect.fail(new NotFound());
        return JSON.parse(rows[0].document) as Entity;
      });
    const insertUnique = (account: string, id: string, key: string, value: Value, exclusive: boolean) =>
      Effect.gen(function* () {
        const encoded = encodeValue(value);
        const hashes = yield* sql<{ hash: string }>`SELECT coalesce(${hashOverride ?? null},md5(${encoded}::jsonb::text)) AS hash`;
        const hash = hashes[0]!.hash;
        if (!exclusive) yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${canonical([account, key, hash])},1))`;
        const existing = yield* sql<{
          id: string;
        }>`SELECT id::text FROM unique_values WHERE account_id=${account} AND attribute=${key} AND hash=${hash} AND value=${encoded}::jsonb`;
        const valueId =
          existing[0]?.id ??
          (yield* sql<{
            id: string;
          }>`INSERT INTO unique_values(account_id,attribute,hash,value) VALUES (${account},${key},${hash},${encoded}::jsonb) RETURNING id::text`)[0]!
            .id;
        yield* sql`INSERT INTO live_unique(account_id,entity_id,attribute,value,value_id) VALUES (${account},${id},${key},${encoded}::jsonb,${valueId})`.pipe(
          Effect.mapError((e) =>
            e.reason._tag === "UniqueViolation" ? new Conflict({ issues: [issue(`facts.${key}`, "Duplicate unique value")] }) : e,
          ),
        );
      });
    const stage = (
      steps: Step[],
      account: string,
      before: Entity | undefined,
      entity: Entity,
      registry: Registry,
      edges: Compiled["edges"],
      actor: string,
      reason: string,
      kind = "write",
    ) =>
      Effect.gen(function* () {
        const keys = [...new Set([...Object.keys(before?.facts ?? {}), ...Object.keys(entity.facts)])]
          .filter((k) => canonical(before?.facts[k] ?? null) !== canonical(entity.facts[k] ?? null))
          .sort(compare);
        if (before && !keys.length && kind !== "delete") return before;
        const next = { ...entity, version: (before?.version ?? 0) + 1, created_at: before?.created_at ?? "" };
        const probe = reason === "migration" ? undefined : yield* StoreProbe;
        probe?.phase("uniqueness");
        if (reason !== "migration") {
          yield* sql`DELETE FROM live_unique WHERE account_id=${account} AND entity_id=${next.id}`;
          if (kind !== "delete")
            for (const [key, value] of Object.entries(next.facts).sort(([a], [b]) => compare(a, b)))
              if (findAttribute(registry, key)?.unique) yield* insertUnique(account, next.id, key, value, false);
        }
        probe?.phase("edge update");
        if (edges.size) yield* refs.update(account, next, keys, edges);
        probe?.phase("staging and automations");
        steps.push({ entity: next, keys, before: before?.facts ?? {}, actor, reason, kind });
        return next;
      });
    const flush = (account: string, steps: Step[], deliveries: Delivery[] = []) =>
      Effect.gen(function* () {
        const projections = new Map<string, Entity>();
        if (!steps.length) return projections;
        const probe = yield* StoreProbe;
        // All validation and unique-value work precedes this short clock critical section.
        probe?.phase("clock reserve");
        const allocation = yield* clock.reserve(account, steps.length);
        probe?.phase("flush inserts and assembly");
        const deleted = new Set<string>();
        const events = steps.map((s, i) => {
          const at = new Date(allocation.ms + i + 1).toISOString(),
            created_at = s.entity.created_at || projections.get(s.entity.id)?.created_at || at;
          projections.set(s.entity.id, { ...s.entity, created_at, updated_at: at });
          if (s.kind === "delete") deleted.add(s.entity.id);
          else deleted.delete(s.entity.id);
          return {
            account_id: account,
            entity_id: s.entity.id,
            tx: allocation.tx + i + 1,
            at,
            kind: s.kind,
            shape: s.entity.shape,
            version: s.entity.version,
            registry_version: s.entity.registry_version,
            created_at,
          };
        });
        const facts = steps.flatMap((s, i) =>
          s.keys.map((k) => ({
            account_id: account,
            entity_id: s.entity.id,
            tx: events[i]!.tx,
            at: events[i]!.at,
            attribute: k,
            op: k in s.entity.facts ? "assert" : "retract",
            value: encodeValue(k in s.entity.facts ? s.entity.facts[k] : s.before[k]),
            reason: s.reason,
            actor: s.actor,
          })),
        );
        for (const batch of insertBatches(events)) yield* sql`INSERT INTO events ${batch}`;
        for (const batch of insertBatches(facts)) yield* sql`INSERT INTO facts ${batch}`;
        const rows = [...projections.values()].map((e) => ({
          account_id: account,
          id: e.id,
          document: JSON.stringify(e),
          deleted: deleted.has(e.id),
        }));
        for (const batch of insertBatches(rows))
          yield* sql`INSERT INTO entities ${batch} ON CONFLICT(account_id,id) DO UPDATE SET document=EXCLUDED.document,deleted=EXCLUDED.deleted`;
        const outboxRows = deliveries.map((d) => ({
          account_id: account,
          at: events[d.index]!.at,
          entity_id: d.entity_id,
          automation_id: d.automation_id,
          document: JSON.stringify(d.action),
        }));
        for (const batch of insertBatches(outboxRows)) yield* sql`INSERT INTO outbox ${batch}`;
        return projections;
      });
    const validate = (c: Compiled, shape: string, facts: Facts) => {
      const schema = c.schemas.get(shape);
      return schema ? decodeIssues(schema, facts).map((x) => issue(`facts.${x.field}`, x.issue)) : [issue("shape", "Unknown shape")];
    };
    const mutate = (account: string, actor: string, body: Mutation, id?: string) =>
      writeTransaction(
        Effect.gen(function* () {
          const probe = yield* StoreProbe;
          probe?.phase("account lock");
          yield* lock(account);
          probe?.phase("entity read");
          const before = id ? yield* getLive(account, id, "write") : undefined;
          probe?.phase("registry read");
          const { version, registry } = yield* getRegistry(account);
          if (before && body.expected_version !== undefined && before.version !== body.expected_version)
            return yield* Effect.fail(new Conflict({ issues: [] }));
          probe?.phase("decode");
          const shape = before?.shape ?? body.shape ?? "",
            facts = merge(before?.facts ?? {}, body.facts),
            c = compiled(account, version, registry);
          const unknown = Object.keys(body.facts)
            .filter((k) => !findShape(registry, shape)?.attributes.includes(k))
            .map((k) => issue(`facts.${k}`, "Unknown attribute"));
          yield* ensure([...validate(c, shape, facts), ...(findShape(registry, shape) ? unknown : [])]);
          const steps: Step[] = [],
            deliveries: Delivery[] = [],
            effects: (Action & { automation_id: string })[] = [];
          const initial = {
            id: id ?? `en_${randomBytes(16).toString("base64url").slice(0, 21)}`,
            shape,
            facts,
            version: 0,
            registry_version: version,
            created_at: "",
            updated_at: "",
          };
          probe?.phase("ref validation");
          if (c.edges.size) yield* refs.validate(account, initial, c.edges);
          probe?.phase("staging");
          let entity = yield* stage(steps, account, before, initial, registry, c.edges, actor, "api", before ? "write" : "create");
          const changed = Object.keys({ ...before?.facts, ...facts }).filter(
            (k) => canonical(before?.facts[k] ?? null) !== canonical(facts[k] ?? null),
          );
          const candidates = new Set(changed.flatMap((k) => (c.reactions.get(k) ?? []).map((a) => a.id)));
          for (const a of registry.automations)
            if (
              a.shape === shape &&
              candidates.has(a.id) &&
              (a.when === undefined || c.rules.get(canonical(a.when))!(entity.facts) === "T")
            )
              for (const action of a.do) {
                effects.push({ ...action, automation_id: a.id });
                const instruction = app.ops[action.op]!.handler(action);
                if (instruction.type === "set") {
                  const updated = {
                    ...entity,
                    facts: merge(entity.facts, { [instruction.attribute]: instruction.value }),
                    registry_version: version,
                  };
                  yield* ensure(validate(c, shape, updated.facts));
                  if (c.edges.size) yield* refs.validate(account, updated, c.edges);
                  entity = yield* stage(steps, account, entity, updated, registry, c.edges, `automation:${a.id}`, "automation");
                } else deliveries.push({ index: steps.length - 1, entity_id: entity.id, automation_id: a.id, action: instruction.payload });
              }
          const committed = yield* flush(account, steps, deliveries);
          probe?.phase("transaction completion");
          return { ...(committed.get(entity.id) ?? entity), effects };
        }),
      );
    const apply = (account: string, actor: string, desired: Registry, base: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const probe = yield* StoreProbe;
          desired = app.normalize(desired);
          probe?.phase("account lock");
          yield* lock(account, true);
          probe?.phase("registry read");
          const current = yield* getRegistry(account);
          if (base !== current.version) return yield* Effect.fail(new Conflict({ issues: [] }));
          probe?.phase("load and parse");
          const entities = yield* live(account),
            result = app.plan(current.registry, desired, entities, current.version, probe?.phase);
          yield* ensure(result.issues);
          yield* ensureApplicable(result.violations.map((v) => issue(`${v.entity_id}.${v.field}`, v.issue)));
          probe?.phase("staging, uniqueness and edges");
          const steps: Step[] = [];
          const previous = compiled(account, current.version, current.registry).edges;
          // The desired version is not committed yet, so keep it out of the cache.
          const edges = app.compile(desired).edges;
          const previousUnique = new Set(current.registry.attributes.filter((a) => a.unique).map((a) => a.key));
          const desiredUnique = new Set(desired.attributes.filter((a) => a.unique).map((a) => a.key));
          const addedUnique = [...desiredUnique].filter((key) => !previousUnique.has(key)).sort(compare);
          const removedUnique = [...previousUnique].filter((key) => !desiredUnique.has(key));
          if (removedUnique.length)
            yield* sql`DELETE FROM live_unique WHERE account_id=${account} AND attribute IN ${sql.in(removedUnique)}`;
          const members = new Map(desired.shapes.map((s) => [s.key, new Set(s.attributes)]));
          for (const e of entities) {
            const keys = Object.keys(e.facts).filter((key) => !members.get(e.shape)!.has(key));
            let after = e;
            if (keys.length) {
              const released = keys.filter((key) => previousUnique.has(key) && desiredUnique.has(key));
              if (released.length)
                yield* sql`DELETE FROM live_unique WHERE account_id=${account} AND entity_id=${e.id} AND attribute IN ${sql.in(released)}`;
              const facts = { ...e.facts };
              for (const key of keys) delete facts[key];
              after = yield* stage(
                steps,
                account,
                e,
                { ...e, facts, registry_version: current.version + 1 },
                desired,
                edges,
                actor,
                "migration",
              );
            }
            // The exclusive account lock excludes all writers of these values.
            for (const key of addedUnique) if (key in after.facts) yield* insertUnique(account, after.id, key, after.facts[key]!, true);
          }
          function* retained() {
            for (const e of entities) yield { ...e, facts: retain(e.facts, findShape(desired, e.shape)!) };
          }
          if (previous.size || edges.size) yield* refs.reconcile(account, previous, edges, retained());
          const version = current.version + 1;
          probe?.phase("registry write");
          yield* sql`INSERT INTO registries(account_id,version,document) VALUES (${account},${version},${JSON.stringify(desired)}) ON CONFLICT(account_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document`;
          yield* flush(account, steps);
          probe?.phase("transaction completion");
          return { version, ...desired };
        }),
      );
    const history = (account: string, id: string) =>
      Effect.gen(function* () {
        const exists = yield* sql`SELECT 1 FROM events WHERE account_id=${account} AND entity_id=${id} LIMIT 1`;
        if (!exists.length) return yield* Effect.fail(new NotFound());
        const rows =
          yield* sql<Fact>`SELECT tx,at,attribute,op,value,reason,actor FROM facts WHERE account_id=${account} AND entity_id=${id} ORDER BY tx,attribute`;
        return { data: rows.map((r) => ({ ...r, tx: Number(r.tx), value: decodeValue(r.value) })) };
      });
    const asOf = (account: string, id: string, at: string) =>
      Effect.gen(function* () {
        const probe = yield* StoreProbe;
        probe?.phase("as_of SQL");
        const events = yield* sql<Event>`SELECT * FROM events WHERE account_id=${account} AND entity_id=${id} AND at<=${at} ORDER BY tx`,
          last = events.at(-1);
        if (!last || last.kind === "delete") return yield* Effect.fail(new NotFound());
        const rows =
            yield* sql<Fact>`SELECT attribute,op,value FROM facts WHERE account_id=${account} AND entity_id=${id} AND tx<=${last.tx} ORDER BY tx,attribute`,
          facts: Facts = {};
        probe?.rows?.(events.length + rows.length);
        probe?.phase("as_of replay");
        for (const r of rows)
          if (r.op === "assert") facts[r.attribute] = decodeValue(r.value);
          else delete facts[r.attribute];
        return {
          id,
          shape: last.shape,
          facts,
          version: last.version,
          registry_version: last.registry_version,
          created_at: last.created_at,
          updated_at: last.at,
        };
      });
    const remove = (account: string, actor: string, id: string) =>
      writeTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          const before = yield* getLive(account, id, "delete"),
            { version, registry } = yield* getRegistry(account),
            { edges } = compiled(account, version, registry),
            steps: Step[] = [];
          const incoming = edges.size ? (yield* refs.incoming(account, id, edges)).filter((row) => row.entity_id !== id) : [];
          yield* ensureApplicable(
            incoming
              .filter((row) => row.on_delete === "block")
              .map((row) => issue(`${row.entity_id}.facts.${row.attribute}`, "Referenced")),
          );
          yield* stage(
            steps,
            account,
            before,
            { ...before, facts: {}, registry_version: version },
            registry,
            edges,
            actor,
            "api",
            "delete",
          );
          let referrer: Entity | undefined;
          for (const row of incoming) {
            if (referrer?.id !== row.entity_id) {
              referrer = yield* getLive(account, row.entity_id, "write").pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
            }
            // A concurrent writer may have retracted or redirected this edge
            // while we waited for the referrer's row lock.
            if (referrer?.facts[row.attribute] !== id) continue;
            const after = { ...referrer, facts: merge(referrer.facts, { [row.attribute]: null }), registry_version: version };
            referrer = yield* stage(steps, account, referrer, after, registry, edges, `reference:${id}`, "reference");
          }
          yield* flush(account, steps);
        }),
      );
    const referrers = (account: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          yield* getLive(account, id, "reference");
          const { version, registry } = yield* getRegistry(account);
          const { edges } = compiled(account, version, registry);
          return { data: yield* refs.incoming(account, id, edges) };
        }),
      );
    const plan = (account: string, desired: Registry) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          const current = yield* getRegistry(account);
          return app.plan(current.registry, desired, yield* live(account), current.version);
        }),
      );
    const outbox = (account: string, after: number, limit: number) =>
      sql<{
        seq: string;
        at: string;
        entity_id: string;
        automation_id: string;
        document: string;
      }>`SELECT seq::text,at,entity_id,automation_id,document FROM outbox WHERE account_id=${account} AND seq>${after} ORDER BY outbox.seq LIMIT ${limit}`.pipe(
        Effect.map((rows) => ({
          data: rows.map(({ document, seq, ...r }) => ({ seq: Number(seq), ...r, ...(JSON.parse(document) as Doc) })),
          next_after: rows.length ? Number(rows.at(-1)!.seq) : null,
        })),
      );
    return { getRegistry, compiled, live, getLive, mutate, apply, history, asOf, remove, referrers, plan, outbox, sql };
  });
export type StoreValue = Effect.Success<ReturnType<typeof makeStore>>;
export class Store extends Context.Service<Store, StoreValue>()("data/Store") {
  static layer = Layer.effect(Store, makeStore());
}
