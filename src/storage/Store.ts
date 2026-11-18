import { randomBytes } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Engine, type Compiled } from "../core/engine.ts";
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
export type Fact = { tx: number; at: string; attribute: string; op: string; value: string; reason: string; actor: string };
type Event = { tx: number; at: string; kind: string; shape: string; version: number; registry_version: number; created_at: string };
type Step = { entity: Entity; keys: string[]; before: Facts; actor: string; reason: string; kind: string };
type Delivery = { index: number; entity_id: string; automation_id: string; action: Doc };
export type Mutation = { shape?: string; facts: Record<string, unknown>; expected_version?: number };
export const makeStore = (hashOverride?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      app = yield* Engine,
      clock = yield* Clock;
    const nonempty = <A>(rows: A[]): [A, ...A[]] => [rows[0]!, ...rows.slice(1)];
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
    const getLive = (account: string, id: string, forUpdate = false) =>
      Effect.gen(function* () {
        const rows = forUpdate
          ? yield* sql<{
              document: string;
            }>`SELECT document FROM entities WHERE account_id=${account} AND id=${id} AND NOT deleted FOR UPDATE`
          : yield* sql<{ document: string }>`SELECT document FROM entities WHERE account_id=${account} AND id=${id} AND NOT deleted`;
        if (!rows[0]) return yield* Effect.fail(new NotFound());
        return JSON.parse(rows[0].document) as Entity;
      });
    const unique = (account: string, entity: Entity, registry: Registry) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM live_unique WHERE account_id=${account} AND entity_id=${entity.id}`;
        for (const [key, value] of Object.entries(entity.facts).sort(([a], [b]) => compare(a, b)))
          if (findAttribute(registry, key)?.unique) {
            const encoded = encodeValue(value);
            const hashes = yield* sql<{ hash: string }>`SELECT coalesce(${hashOverride ?? null},md5(${encoded}::jsonb::text)) AS hash`;
            const hash = hashes[0]!.hash;
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${canonical([account, key, hash])},1))`;
            const existing = yield* sql<{
              id: string;
            }>`SELECT id::text FROM unique_values WHERE account_id=${account} AND attribute=${key} AND hash=${hash} AND value=${encoded}::jsonb`;
            const valueId =
              existing[0]?.id ??
              (yield* sql<{
                id: string;
              }>`INSERT INTO unique_values(account_id,attribute,hash,value) VALUES (${account},${key},${hash},${encoded}::jsonb) RETURNING id::text`)[0]!
                .id;
            yield* sql`INSERT INTO live_unique(account_id,entity_id,attribute,value,value_id) VALUES (${account},${entity.id},${key},${encoded}::jsonb,${valueId})`.pipe(
              Effect.mapError((e) =>
                e.reason._tag === "UniqueViolation" ? new Conflict({ issues: [issue(`facts.${key}`, "Duplicate unique value")] }) : e,
              ),
            );
          }
      });
    const stage = (
      steps: Step[],
      account: string,
      before: Entity | undefined,
      entity: Entity,
      registry: Registry,
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
        if (kind === "delete") yield* sql`DELETE FROM live_unique WHERE account_id=${account} AND entity_id=${next.id}`;
        else yield* unique(account, next, registry);
        steps.push({ entity: next, keys, before: before?.facts ?? {}, actor, reason, kind });
        return next;
      });
    const flush = (account: string, steps: Step[], deliveries: Delivery[] = []) =>
      Effect.gen(function* () {
        const projections = new Map<string, Entity>();
        if (!steps.length) return projections;
        // All validation and unique-value work precedes this short clock critical section.
        const allocation = yield* clock.reserve(account, steps.length);
        const events = steps.map((s, i) => {
          const at = new Date(allocation.ms + i + 1).toISOString(),
            created_at = s.entity.created_at || projections.get(s.entity.id)?.created_at || at;
          projections.set(s.entity.id, { ...s.entity, created_at, updated_at: at });
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
        yield* sql`INSERT INTO events ${sql.insert(nonempty(events))}`;
        if (facts.length) yield* sql`INSERT INTO facts ${sql.insert(nonempty(facts))}`;
        const rows = [...projections.values()].map((e) => ({
          account_id: account,
          id: e.id,
          document: JSON.stringify(e),
          deleted: steps.findLast((s) => s.entity.id === e.id)!.kind === "delete",
        }));
        yield* sql`INSERT INTO entities ${sql.insert(nonempty(rows))} ON CONFLICT(account_id,id) DO UPDATE SET document=EXCLUDED.document,deleted=EXCLUDED.deleted`;
        if (deliveries.length)
          yield* sql`INSERT INTO outbox ${sql.insert(nonempty(deliveries.map((d) => ({ account_id: account, at: events[d.index]!.at, entity_id: d.entity_id, automation_id: d.automation_id, document: JSON.stringify(d.action) }))))}`;
        return projections;
      });
    const validate = (account: string, version: number, registry: Registry, shape: string, facts: Facts) => {
      const schema = compiled(account, version, registry).schemas.get(shape);
      return schema ? decodeIssues(schema, facts).map((x) => issue(`facts.${x.field}`, x.issue)) : [issue("shape", "Unknown shape")];
    };
    const mutate = (account: string, actor: string, body: Mutation, id?: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          const before = id ? yield* getLive(account, id, true) : undefined,
            { version, registry } = yield* getRegistry(account);
          if (before && body.expected_version !== undefined && before.version !== body.expected_version)
            return yield* Effect.fail(new Conflict({ issues: [] }));
          const shape = before?.shape ?? body.shape ?? "",
            facts = merge(before?.facts ?? {}, body.facts);
          const unknown = Object.keys(body.facts)
            .filter((k) => !findShape(registry, shape)?.attributes.includes(k))
            .map((k) => issue(`facts.${k}`, "Unknown attribute"));
          yield* ensure([...validate(account, version, registry, shape, facts), ...(findShape(registry, shape) ? unknown : [])]);
          const steps: Step[] = [],
            deliveries: Delivery[] = [],
            effects: (Action & { automation_id: string })[] = [];
          let entity = yield* stage(
            steps,
            account,
            before,
            {
              id: id ?? `en_${randomBytes(16).toString("base64url").slice(0, 21)}`,
              shape,
              facts,
              version: 0,
              registry_version: version,
              created_at: "",
              updated_at: "",
            },
            registry,
            actor,
            "api",
            before ? "write" : "create",
          );
          const changed = Object.keys({ ...before?.facts, ...facts }).filter(
            (k) => canonical(before?.facts[k] ?? null) !== canonical(facts[k] ?? null),
          );
          const c = compiled(account, version, registry),
            candidates = new Set(changed.flatMap((k) => (c.reactions.get(k) ?? []).map((a) => a.id)));
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
                  const updated = merge(entity.facts, { [instruction.attribute]: instruction.value });
                  yield* ensure(validate(account, version, registry, shape, updated));
                  entity = yield* stage(
                    steps,
                    account,
                    entity,
                    { ...entity, facts: updated, registry_version: version },
                    registry,
                    `automation:${a.id}`,
                    "automation",
                  );
                } else deliveries.push({ index: steps.length - 1, entity_id: entity.id, automation_id: a.id, action: instruction.payload });
              }
          const committed = yield* flush(account, steps, deliveries);
          return { ...(committed.get(entity.id) ?? entity), effects };
        }),
      );
    const apply = (account: string, actor: string, desired: Registry, base: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          desired = app.normalize(desired);
          yield* lock(account, true);
          const current = yield* getRegistry(account);
          if (base !== current.version) return yield* Effect.fail(new Conflict({ issues: [] }));
          const entities = yield* live(account),
            result = app.plan(current.registry, desired, entities, current.version);
          yield* ensure(result.issues);
          yield* ensureApplicable(result.violations.map((v) => issue(`${v.entity_id}.${v.field}`, v.issue)));
          const steps: Step[] = [];
          for (const e of entities) {
            const after = yield* stage(
              steps,
              account,
              e,
              { ...e, facts: retain(e.facts, findShape(desired, e.shape)!), registry_version: current.version + 1 },
              desired,
              actor,
              "migration",
            );
            yield* unique(account, after, desired);
          }
          const version = current.version + 1;
          yield* sql`INSERT INTO registries(account_id,version,document) VALUES (${account},${version},${JSON.stringify(desired)}) ON CONFLICT(account_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document`;
          yield* flush(account, steps);
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
        const events = yield* sql<Event>`SELECT * FROM events WHERE account_id=${account} AND entity_id=${id} AND at<=${at} ORDER BY tx`,
          last = events.at(-1);
        if (!last || last.kind === "delete") return yield* Effect.fail(new NotFound());
        const rows =
            yield* sql<Fact>`SELECT attribute,op,value FROM facts WHERE account_id=${account} AND entity_id=${id} AND tx<=${last.tx} ORDER BY tx,attribute`,
          facts: Facts = {};
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
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          const before = yield* getLive(account, id, true),
            { version, registry } = yield* getRegistry(account),
            steps: Step[] = [];
          yield* stage(steps, account, before, { ...before, facts: {}, registry_version: version }, registry, actor, "api", "delete");
          yield* flush(account, steps);
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
    return { getRegistry, compiled, live, getLive, mutate, apply, history, asOf, remove, plan, outbox, sql };
  });
export type StoreValue = Effect.Success<ReturnType<typeof makeStore>>;
export class Store extends Context.Service<Store, StoreValue>()("data/Store") {
  static layer = Layer.effect(Store, makeStore());
}
