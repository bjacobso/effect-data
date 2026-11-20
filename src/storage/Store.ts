import { randomBytes } from "node:crypto";
import { Context, Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import { SqlError } from "effect/sql/SqlError";
import { Engine, type ApplyMode, type Compiled } from "../core/engine.ts";
import { cells } from "./cells.ts";
import { liveRefs } from "./liveRefs.ts";
import { Clock } from "./Clock.ts";
import {
  type Registry,
  type Entity,
  type Facts,
  type Doc,
  type Action,
  canonical,
  compare,
  findShape,
  issue,
  decodeIssues,
} from "../core/model.ts";
import { merge } from "../core/engine.ts";
import { attributeEdges } from "../core/kinds.ts";
import { registryImpact, slotChanges, possibleRestorations, type RegistryImpact } from "../core/registryImpact.ts";
import { registryReview } from "../core/registryReview.ts";
import { ensure, ensureApplicable, NotFound, Conflict } from "../Errors.ts";
import { encodeValue, decodeValue } from "./encoding.ts";
import { liveUnique, type Slot } from "./liveUnique.ts";
import { violations, type ViolationChange, type ViolationRecord } from "./violations.ts";
import { rollouts } from "./rollouts.ts";
export { encodeValue, decodeValue } from "./encoding.ts";
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
type Step = { entity: Entity; keys: string[]; before: Facts; actor: string; reason: string; kind: string; resolved: ViolationRecord[] };
type Delivery = { index: number; entity_id: string; automation_id: string; action: Doc };
type Candidate = { id: string; shape: string; document: string | null; deleted?: boolean };
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
    const typed = cells(sql);
    const unique = liveUnique(sql, hashOverride);
    const records = violations(sql);
    const jobs = rollouts(sql, unique, records, clock.reserve);
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
    const affected = (account: string, impact: RegistryImpact) =>
      Effect.gen(function* () {
        const entities: Entity[] = [],
          targets = new Map<string, string>();
        if (!impact.shapes.size) return { entities, targets };
        const shapes = [...new Set([...impact.shapes.keys(), ...impact.targets])];
        const rows = yield* sql<Candidate>`
          SELECT c.entity_id AS id,c.shape,CASE WHEN c.shape IN ${sql.in([...impact.shapes.keys()])} THEN e.document END AS document
          FROM events c JOIN entities e ON e.account_id=c.account_id AND e.id=c.entity_id
          WHERE c.account_id=${account} AND c.kind='create' AND c.shape IN ${sql.in(shapes)} AND NOT e.deleted`;
        for (const row of rows) {
          if (row.document !== null) entities.push(JSON.parse(row.document) as Entity);
          if (impact.targets.has(row.shape)) targets.set(row.id, row.shape);
        }
        return { entities, targets };
      });
    const candidatePage = (account: string, shape: string, document: boolean, after: string) => sql<Candidate>`
      SELECT c.entity_id AS id,c.shape,${document ? sql`e.document` : sql`NULL::text`} AS document
      FROM events c JOIN entities e ON e.account_id=c.account_id AND e.id=c.entity_id
      WHERE c.account_id=${account} AND c.kind='create' AND c.shape=${shape} AND NOT e.deleted
        AND c.entity_id COLLATE "C">${after}
      ORDER BY c.entity_id COLLATE "C" LIMIT 5000`;
    const changedSince = (account: string, position: string, impact: RegistryImpact) => sql<Candidate>`
      SELECT d.entity_id AS id,d.shape,e.deleted,CASE WHEN NOT e.deleted AND d.shape IN ${sql.in([...impact.shapes.keys()])}
        THEN e.document END AS document
      FROM (SELECT DISTINCT entity_id,shape FROM events
        WHERE account_id=${account} AND tx>${position}::bigint
          AND shape IN ${sql.in([...new Set([...impact.shapes.keys(), ...impact.targets])])}) d
      JOIN entities e ON e.account_id=${account} AND e.id=d.entity_id`;
    const getStored = (account: string, id: string, mode?: "write" | "delete" | "reference") =>
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
    const readEntity = (account: string, id: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* lock(account);
            const stored = yield* getStored(account, id);
            const { version, registry } = yield* getRegistry(account);
            const config = compiled(account, version, registry);
            const open = yield* records.openFor(account, [id]);
            return {
              entity: {
                ...stored,
                facts: config.visible(stored.shape, stored.facts),
                violations: open.map(({ attribute, issue }) => ({ attribute, issue })),
              },
              registry,
              config,
            };
          }),
        )
        .pipe(Effect.provideService(SqlClient.BeginTransaction, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
    const getLive = (account: string, id: string) => readEntity(account, id).pipe(Effect.map(({ entity }) => entity));
    const stage = (
      steps: Step[],
      account: string,
      before: Entity | undefined,
      entity: Entity,
      config: Compiled,
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
        const probe = yield* StoreProbe;
        probe?.phase("uniqueness");
        const relevant = kind === "delete" ? keys : keys.filter((key) => config.unique.has(key));
        const claims: Slot[] = [];
        const oldValues: Slot[] = [];
        for (const attribute of relevant) {
          if (attribute in next.facts) claims.push({ entity_id: next.id, attribute, encoded: encodeValue(next.facts[attribute]) });
          if (before && attribute in before.facts)
            oldValues.push({ entity_id: next.id, attribute, encoded: encodeValue(before.facts[attribute]) });
        }
        yield* unique.lock(account, [...claims, ...oldValues]);
        const freed =
          before && relevant.length ? (yield* unique.get(account, [next.id])).filter((slot) => relevant.includes(slot.attribute)) : [];
        const resolved = [...(yield* records.markResolved(account, next.id, kind === "delete" ? undefined : keys))];
        yield* unique.release(account, freed);
        for (const slot of claims) yield* unique.claim(account, slot);
        for (const slot of freed) {
          const candidate = yield* records.promote(account, slot, config);
          if (candidate) {
            yield* unique.claim(account, candidate);
            resolved.push(...(yield* records.markResolved(account, candidate.entity_id, [candidate.attribute], "duplicate")));
          }
        }
        probe?.phase("edge update");
        if (config.edges.size) yield* refs.update(account, next, keys, config);
        probe?.phase("staging and automations");
        steps.push({ entity: next, keys, before: before?.facts ?? {}, actor, reason, kind, resolved });
        return next;
      });
    const flush = (account: string, steps: Step[], config: Compiled, deliveries: Delivery[] = []) =>
      Effect.gen(function* () {
        const projections = new Map<string, Entity>();
        if (!steps.length) return projections;
        const probe = yield* StoreProbe;
        const cellWrites = new Map<string, { entity: Entity; keys: Set<string>; deleted: boolean }>();
        for (const { entity, keys, kind } of steps) {
          const changed = cellWrites.get(entity.id)?.keys ?? new Set<string>();
          for (const key of keys) changed.add(key);
          cellWrites.set(entity.id, { entity, keys: changed, deleted: kind === "delete" });
        }
        yield* typed.write(account, cellWrites.values(), config.cells);
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
        const changes: ViolationChange[] = steps.flatMap((step, i) =>
          step.resolved.map((record) => ({ ...record, tx: events[i]!.tx, at: events[i]!.at, status: "resolved" as const })),
        );
        yield* records.resolve(account, changes);
        const outboxRows = [
          ...deliveries.map((d) => ({
            account_id: account,
            at: events[d.index]!.at,
            entity_id: d.entity_id,
            automation_id: d.automation_id,
            document: JSON.stringify(d.action),
          })),
          ...changes.map((v) => ({
            account_id: account,
            at: v.at,
            entity_id: v.entity_id,
            automation_id: null,
            document: JSON.stringify({ op: "violation_resolved", violation_id: Number(v.id), attribute: v.attribute, issue: v.issue }),
          })),
        ].sort((a, b) => compare(a.at, b.at));
        for (const batch of insertBatches(outboxRows)) yield* sql`INSERT INTO outbox ${batch}`;
        return projections;
      });
    const validate = (c: Compiled, shape: string, facts: Facts) => {
      const schema = c.schemas.get(shape);
      return schema ? decodeIssues(schema, facts).map((x) => issue(`facts.${x.field}`, x.issue)) : [issue("shape", "Unknown shape")];
    };
    const changedRefs = (config: Compiled, entity: Entity, before?: Entity) => ({
      ...entity,
      facts: Object.fromEntries(
        Object.entries(config.visible(entity.shape, entity.facts)).filter(
          ([key, value]) => config.edges.has(key) && value !== before?.facts[key],
        ),
      ),
    });
    const mutate = (account: string, actor: string, body: Mutation, id?: string) =>
      writeTransaction(
        Effect.gen(function* () {
          const probe = yield* StoreProbe;
          probe?.phase("account lock");
          yield* lock(account);
          probe?.phase("entity read");
          const before = id ? yield* getStored(account, id, "write") : undefined;
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
          yield* ensure([...validate(c, shape, c.visible(shape, facts)), ...(findShape(registry, shape) ? unknown : [])]);
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
          if (c.edges.size) yield* refs.validate(account, changedRefs(c, initial, before), c.edges);
          probe?.phase("staging");
          let entity = yield* stage(steps, account, before, initial, c, actor, "api", before ? "write" : "create");
          const changed = Object.keys({ ...before?.facts, ...facts }).filter(
            (k) => canonical(before?.facts[k] ?? null) !== canonical(facts[k] ?? null),
          );
          const candidates = new Set(changed.flatMap((k) => (c.reactions.get(k) ?? []).map((a) => a.id)));
          for (const a of registry.automations)
            if (
              a.shape === shape &&
              candidates.has(a.id) &&
              (a.when === undefined || c.rules.get(canonical(a.when))!(c.visible(shape, entity.facts)) === "T")
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
                  yield* ensure(validate(c, shape, c.visible(shape, updated.facts)));
                  if (c.edges.size) yield* refs.validate(account, changedRefs(c, updated, entity), c.edges);
                  entity = yield* stage(steps, account, entity, updated, c, `automation:${a.id}`, "automation");
                } else deliveries.push({ index: steps.length - 1, entity_id: entity.id, automation_id: a.id, action: instruction.payload });
              }
          const committed = yield* flush(account, steps, c, deliveries);
          probe?.phase("transaction completion");
          return { ...(committed.get(entity.id) ?? entity), facts: c.visible(shape, entity.facts), effects };
        }),
      );
    const inspectRegistry = (account: string, current: Registry, desired: Registry, mode: ApplyMode, planning = false) =>
      Effect.gen(function* () {
        const candidates = possibleRestorations(current, desired);
        const history = candidates.size
          ? yield* sql<{ document: string }>`SELECT document FROM registry_versions WHERE account_id=${account} ORDER BY version DESC`
          : [];
        const seen = new Map<string, Set<string>>();
        for (const { document } of history) {
          for (const shape of (JSON.parse(document) as Registry).shapes ?? []) {
            const possible = candidates.get(shape.key);
            if (!possible) continue;
            for (const key of shape.attributes)
              if (possible.delete(key)) {
                const members = seen.get(shape.key) ?? new Set<string>();
                members.add(key);
                seen.set(shape.key, members);
              }
            if (!possible.size) candidates.delete(shape.key);
          }
          if (!candidates.size) break;
        }
        const restored = (shape: string, key: string) => seen.get(shape)?.has(key) ?? false;
        const impact = registryImpact(current, desired, restored);
        const pending = yield* jobs.get(account, true);
        const previous = app.compile(current);
        const definitionKeys = new Set(current.attributes.map(({ key }) => key));
        const slots = slotChanges(current, desired, restored);
        const changedKeys = new Set([...slots.values()].flatMap(({ release, claim }) => [...release, ...claim]));
        const work = new Set([...slots.keys(), ...(pending?.shapes ?? [])]);
        for (const shape of desired.shapes) if (shape.attributes.some((key) => changedKeys.has(key))) work.add(shape.key);
        for (const [shape, checks] of impact.shapes) if (checks.refs.size) work.add(shape);
        for (const shape of current.shapes) {
          const next = findShape(desired, shape.key);
          if (shape.attributes.some((key) => previous.edges.has(key) && !next?.attributes.includes(key))) work.add(shape.key);
        }
        if (mode === "strict" || planning) {
          const open = yield* sql<{ shape: string; attribute: string; issue: "duplicate" | "dangling_reference" }>`
            SELECT DISTINCT c.shape,v.attribute,v.issue FROM violations v
            JOIN events c ON c.account_id=v.account_id AND c.entity_id=v.entity_id AND c.kind='create'
            WHERE v.account_id=${account} AND v.status='open'`;
          const desiredEdges = attributeEdges(desired.attributes);
          const desiredUnique = new Set(desired.attributes.filter(({ unique }) => unique).map(({ key }) => key));
          const uniqueKeys = new Set(open.filter((v) => v.issue === "duplicate").map((v) => v.attribute));
          const pendingShapes = new Set(pending?.shapes);
          for (const shape of desired.shapes)
            if (pendingShapes.has(shape.key)) for (const key of shape.attributes) if (desiredUnique.has(key)) uniqueKeys.add(key);
          for (const shape of desired.shapes) {
            const check = impact.shapes.get(shape.key) ?? { fields: new Set<string>(), unique: new Set<string>(), refs: new Set<string>() };
            for (const key of shape.attributes) {
              if (desiredUnique.has(key) && uniqueKeys.has(key)) check.unique.add(key);
              const edge = desiredEdges.get(key);
              if (
                edge &&
                (pendingShapes.has(shape.key) ||
                  open.some((v) => v.shape === shape.key && v.attribute === key && v.issue === "dangling_reference"))
              ) {
                check.refs.add(key);
                impact.targets.add(edge.target);
              }
            }
            if (check.unique.size || check.refs.size) impact.shapes.set(shape.key, check);
          }
        } else {
          // Duplicate checks and newly exposed dangling refs can't reject a
          // rollout. Their records come from the committed-data worker.
          for (const [shape, check] of impact.shapes) {
            check.unique.clear();
            for (const key of check.refs) if (!previous.members.get(shape)?.has(key)) check.refs.delete(key);
            if (findShape(desired, shape) && !check.fields.size && !check.refs.size) impact.shapes.delete(shape);
          }
        }
        return { impact, pending, previous, definitionKeys, slots, work: [...work].sort(compare) };
      });

    const apply = (account: string, _actor: string, desired: Registry, base: number, mode: ApplyMode = "rollout") =>
      Effect.gen(function* () {
        const probe = yield* StoreProbe;
        desired = app.normalize(desired);
        const version = base + 1;
        const snapshot = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              probe?.phase("preflight registry read");
              const current = yield* getRegistry(account);
              if (base !== current.version) return yield* Effect.fail(new Conflict({ issues: [] }));
              const {
                impact,
                pending,
                previous: previousConfig,
                definitionKeys,
                slots,
                work,
              } = yield* inspectRegistry(account, current.registry, desired, mode);
              const plan = app.preparePlan(current.registry, desired, base, probe?.phase, impact, mode);
              const review = registryReview(plan.inspect);
              const previous = previousConfig.edges;
              // The desired version is not committed yet, so keep it out of the cache.
              const config = plan.issues.length ? previousConfig : app.compile(desired);
              const edges = config.edges;
              const addedEdges = [...definitionKeys].filter((key) => edges.has(key) && !previous.has(key));
              const inherited = new Set(pending?.shapes);
              const reviewShapes = new Set(impact.shapes.keys());
              if (addedEdges.length || (mode === "strict" && inherited.size))
                for (const shape of current.registry.shapes) {
                  if (!addedEdges.length && !inherited.has(shape.key)) continue;
                  if (!impact.shapes.has(shape.key))
                    impact.shapes.set(shape.key, { fields: new Set(), unique: new Set(), refs: new Set() });
                }
              const edgeSources = new Map<string, Entity>();
              const uniqueSlots = new Map<string, Slot[]>();

              const accept = (row: Candidate) => {
                if (impact.targets.has(row.shape)) review.setTarget(row.id, row.deleted ? undefined : row.shape);
                if (!impact.shapes.has(row.shape)) return;
                const e = row.document === null ? undefined : (JSON.parse(row.document) as Entity);
                if (reviewShapes.has(row.shape)) review.setEntity(row.id, e);
                edgeSources.delete(row.id);
                uniqueSlots.delete(row.id);
                if (!e) return;
                if (addedEdges.some((key) => key in e.facts)) edgeSources.set(row.id, e);
                if (mode === "strict") {
                  const keys = inherited.has(row.shape)
                    ? [...(config.members.get(row.shape) ?? [])].filter((key) => config.unique.has(key))
                    : (slots.get(row.shape)?.claim ?? []);
                  const claims = keys
                    .filter((key) => key in e.facts)
                    .map((key) => ({ entity_id: row.id, attribute: key, encoded: encodeValue(e.facts[key]) }));
                  if (claims.length) uniqueSlots.set(row.id, claims);
                }
              };
              let position: string | undefined;
              if (!plan.issues.length && impact.shapes.size) {
                probe?.phase("snapshot position");
                const [watermark] = yield* sql<{ tx: string }>`SELECT tx::text FROM account_clocks WHERE account_id=${account}`;
                position = watermark?.tx ?? "0";
                for (const shape of new Set([...impact.shapes.keys(), ...impact.targets])) {
                  let after = "";
                  while (true) {
                    probe?.phase("preflight load");
                    const rows = yield* candidatePage(account, shape, impact.shapes.has(shape), after);
                    if (!rows.length) break;
                    probe?.phase("preflight validation and staging");
                    for (const row of rows) accept(row);
                    after = rows.at(-1)!.id;
                  }
                }
              }
              probe?.phase("preflight validation and staging");
              const violations = plan.finish(review.finish()).violations;
              probe?.phase("snapshot completion");
              return {
                impact,
                plan,
                position,
                accept,
                review,
                violations,
                previous,
                edges,
                slots,
                pending,
                work,
                config,
                edgeSources,
                previousCells: previousConfig.cells,
                uniqueSlots,
              };
            }),
          )
          .pipe(Effect.provideService(SqlClient.BeginTransaction, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            probe?.phase("account lock");
            yield* lock(account, true);
            probe?.phase("registry read");
            const [current] = yield* sql<{ version: number }>`SELECT version FROM registries WHERE account_id=${account}`;
            if ((current?.version ?? 0) !== base) return yield* Effect.fail(new Conflict({ issues: [] }));
            yield* ensure(snapshot.plan.issues);
            probe?.phase("recheck concurrent writes");
            let violations = snapshot.violations;
            if (snapshot.position !== undefined) {
              const touched = yield* changedSince(account, snapshot.position, snapshot.impact);
              if (touched.length) {
                for (const row of touched) snapshot.accept(row);
                violations = snapshot.plan.finish(snapshot.review.finish()).violations;
              }
            }
            yield* ensureApplicable(violations.filter((v) => v.blocking).map((v) => issue(`${v.entity_id}.${v.field}`, v.issue)));

            probe?.phase("staging, uniqueness and edges");
            if (mode === "strict") {
              for (const [shape, { release }] of snapshot.slots)
                if (release.length)
                  yield* sql`DELETE FROM live_unique u USING events c
                    WHERE u.account_id=${account} AND c.account_id=u.account_id AND c.entity_id=u.entity_id
                      AND c.kind='create' AND c.shape=${shape} AND u.attribute IN ${sql.in(release)}`;
              // An inherited slot can have an obsolete value as well as
              // obsolete membership. Rebuild its scope from desired facts.
              for (const shape of snapshot.pending?.shapes ?? [])
                yield* sql`DELETE FROM live_unique u USING events c
                  WHERE u.account_id=${account} AND c.account_id=u.account_id AND c.entity_id=u.entity_id
                    AND c.kind='create' AND c.shape=${shape}`;
              let batch: Slot[] = [],
                encodedLength = 0;
              for (const slots of snapshot.uniqueSlots.values()) {
                for (const slot of slots) {
                  batch.push(slot);
                  encodedLength += slot.encoded.length;
                  if (batch.length === 5_000 || encodedLength >= 1_000_000) {
                    yield* unique.insert(account, batch);
                    batch = [];
                    encodedLength = 0;
                  }
                }
              }
              if (batch.length) yield* unique.insert(account, batch);
            }
            if (snapshot.previous.size || snapshot.edges.size)
              yield* refs.reconcile(account, snapshot.previous, snapshot.config, snapshot.edgeSources.values());
            for (const [attribute, type] of snapshot.config.cells) {
              const previous = snapshot.previousCells.get(attribute);
              if (previous && previous.type !== type.type) yield* typed.rebuild(account, snapshot.config.cells, attribute);
            }
            probe?.phase("registry write");
            const job =
              mode === "rollout"
                ? {
                    shapes: snapshot.work,
                    release: snapshot.pending !== undefined || [...snapshot.slots.values()].some(({ release }) => release.length),
                  }
                : undefined;
            const [position] = yield* sql<{ tx: string; at: string }>`
              WITH reservation AS (${clock.allocate(account, 1)}),
              installed AS (
                INSERT INTO registries(account_id,version,document)
                VALUES (${account},${version},${JSON.stringify(desired)})
                ON CONFLICT(account_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document
                RETURNING account_id,version,document
              ), history AS (
                INSERT INTO registry_versions(account_id,version,document,at)
                SELECT i.account_id,i.version,i.document,
                  to_char(to_timestamp((r.ms::bigint+1)/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                FROM installed i CROSS JOIN reservation r RETURNING at
              )
              ${job || snapshot.pending ? jobs.replace(account, version, job) : sql``}
              SELECT history.at,(reservation.tx::bigint+1)::text AS tx FROM history CROSS JOIN reservation`;
            const { at, tx } = position!;
            const resolved =
              mode === "strict"
                ? yield* sql<ViolationRecord>`SELECT id::text,entity_id,attribute,issue,value::text AS encoded FROM violations
                WHERE account_id=${account} AND status='open'`
                : yield* records.validRetargets(account, snapshot.previous, snapshot.config);
            const changes = resolved.map((row) => ({ ...row, at, tx: Number(tx), status: "resolved" as const }));
            yield* records.resolve(account, changes);
            yield* records.deliver(account, changes);
            probe?.phase("transaction completion");
            return { version, ...desired };
          }),
        );
      });
    const history = (account: string, id: string) =>
      Effect.gen(function* () {
        const exists = yield* sql`SELECT 1 FROM events WHERE account_id=${account} AND entity_id=${id} LIMIT 1`;
        if (!exists.length) return yield* Effect.fail(new NotFound());
        const rows =
          yield* sql<Fact>`SELECT tx,at,attribute,op,value,reason,actor FROM facts WHERE account_id=${account} AND entity_id=${id} ORDER BY tx,attribute`;
        return { data: rows.map((r) => ({ ...r, tx: Number(r.tx), value: decodeValue(r.value) })) };
      });
    const asOf = (account: string, id: string, at: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const probe = yield* StoreProbe;
            probe?.phase("as_of SQL");
            const events =
                yield* sql<Event>`SELECT * FROM events WHERE account_id=${account} AND entity_id=${id} AND at<=${at} ORDER BY tx`,
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
            const [registry] = yield* sql<{ version: number; document: string }>`SELECT version,document
          FROM registry_versions WHERE account_id=${account} AND at<=${at} ORDER BY at DESC,version DESC LIMIT 1`;
            return {
              id,
              shape: last.shape,
              facts: registry
                ? compiled(account, registry.version, app.normalize(JSON.parse(registry.document))).visible(last.shape, facts)
                : facts,
              version: last.version,
              registry_version: last.registry_version,
              created_at: last.created_at,
              updated_at: last.at,
              violations: yield* records.atTime(account, id, at),
            };
          }),
        )
        .pipe(Effect.provideService(SqlClient.BeginTransaction, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
    const remove = (account: string, actor: string, id: string) =>
      writeTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          const before = yield* getStored(account, id, "delete"),
            { version, registry } = yield* getRegistry(account),
            config = compiled(account, version, registry),
            steps: Step[] = [];
          const incoming = config.edges.size
            ? (yield* refs.incoming(account, id, before.shape, config)).filter((row) => row.entity_id !== id)
            : [];
          yield* ensureApplicable(
            incoming
              .filter((row) => row.on_delete === "block")
              .map((row) => issue(`${row.entity_id}.facts.${row.attribute}`, "Referenced")),
          );
          yield* stage(steps, account, before, { ...before, facts: {}, registry_version: version }, config, actor, "api", "delete");
          let referrer: Entity | undefined;
          for (const row of incoming) {
            if (referrer?.id !== row.entity_id) {
              referrer = yield* getStored(account, row.entity_id, "write").pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              );
            }
            // A concurrent writer may have retracted or redirected this edge
            // while we waited for the referrer's row lock.
            if (referrer?.facts[row.attribute] !== id) continue;
            const after = { ...referrer, facts: merge(referrer.facts, { [row.attribute]: null }), registry_version: version };
            referrer = yield* stage(steps, account, referrer, after, config, `reference:${id}`, "reference");
          }
          yield* flush(account, steps, config);
        }),
      );
    const referrers = (account: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          const entity = yield* getStored(account, id, "reference");
          const { version, registry } = yield* getRegistry(account);
          return { data: yield* refs.incoming(account, id, entity.shape, compiled(account, version, registry)) };
        }),
      );
    const plan = (account: string, desired: Registry, mode: ApplyMode = "rollout") =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          const current = yield* getRegistry(account);
          const { impact } = yield* inspectRegistry(account, current.registry, desired, mode, true);
          const { entities, targets } = yield* affected(account, impact);
          return app.plan(current.registry, desired, entities, current.version, undefined, { impact, targets }, mode);
        }),
      );
    const outbox = (account: string, after: number, limit: number) =>
      sql<{
        seq: string;
        at: string;
        entity_id: string;
        automation_id: string | null;
        document: string;
      }>`SELECT seq::text,at,entity_id,automation_id,document FROM outbox WHERE account_id=${account} AND seq>${after} ORDER BY outbox.seq LIMIT ${limit}`.pipe(
        Effect.map((rows) => ({
          data: rows.map(({ document, seq, ...r }) => ({ seq: Number(seq), ...r, ...(JSON.parse(document) as Doc) })),
          next_after: rows.length ? Number(rows.at(-1)!.seq) : null,
        })),
      );
    const rolloutStatus = (account: string, version: number) =>
      jobs
        .get(account)
        .pipe(
          Effect.map((job) =>
            job?.version === version ? { version, status: job.status, total: job.total ?? 0, processed: job.processed } : null,
          ),
        );

    const runRolloutBatch = (account: string, limit = 1_000) =>
      writeTransaction(
        Effect.gen(function* () {
          yield* lock(account);
          const job = yield* jobs.claim(account);
          if (!job) return false;
          const { version, registry } = yield* getRegistry(account);
          yield* jobs.step(account, job, compiled(account, version, registry), limit);
          return true;
        }),
      );

    const runRollouts = Effect.gen(function* () {
      let previous = "";
      while (true) {
        const progressed = yield* Effect.gen(function* () {
          const account = yield* jobs.nextAccount(previous);
          if (!account) return false;
          previous = account;
          return yield* runRolloutBatch(account);
        }).pipe(Effect.catch((error) => Effect.logError("Registry rollout batch failed", error).pipe(Effect.as(false))));
        if (!progressed) yield* Effect.sleep("50 millis");
      }
    });
    return {
      getRegistry,
      compiled,
      live,
      getLive,
      readEntity,
      mutate,
      apply,
      history,
      asOf,
      remove,
      referrers,
      plan,
      outbox,
      sql,
      rolloutStatus,
      runRolloutBatch,
      runRollouts,
      listViolations: records.list,
    };
  });
export type StoreValue = Effect.Success<ReturnType<typeof makeStore>>;
export class Store extends Context.Service<Store, StoreValue>()("data/Store") {
  static layer = Layer.effect(Store, makeStore());
}
