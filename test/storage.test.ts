import { beforeAll, afterAll, test, expect } from "vitest";
import fc from "fast-check";
import { Effect, ManagedRuntime, Arbitrary, Schema, Redacted, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Statement } from "effect/sql";
import { randomBytes } from "node:crypto";
import { DataLive } from "../src/composition.ts";
import { Engine, type EngineValue } from "../src/core/engine.ts";
import { makeStore, encodeValue, decodeValue, Store, type StoreValue } from "../src/storage/Store.ts";
import { migrate } from "../src/Migrations.ts";
import { type Entity, type Facts, type Attribute, type Registry, canonical, decodeIssues } from "../src/core/model.ts";
import { valueSchema } from "../src/core/values.ts";
import { fixture } from "./fixtures.ts";
const runtime = ManagedRuntime.make(
  DataLive.pipe(
    Layer.provideMerge(
      PgClient.layer({
        url: Redacted.make(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/onb_data_test"),
        maxConnections: 20,
      }),
    ),
  ),
);
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
let store: StoreValue;
let app: EngineValue;
const account = () => `acct_test_${randomBytes(8).toString("hex")}`;
beforeAll(async () => {
  await runtime.runPromise(migrate);
  store = await runtime.runPromise(Store);
  app = await runtime.runPromise(Engine);
}, 30000);
afterAll(() => runtime.dispose());
const block = "employee/block";
const clear = "employee/clear";
const withRefs = () => {
  const r = fixture();
  r.attributes.push({ key: block, type: "ref", target: "employee" }, { key: clear, type: "ref", target: "employee", on_delete: "clear" });
  r.shapes[0]!.attributes = [...r.shapes[0]!.attributes, block, clear];
  return r;
};
const seed = async () => {
  const a = account();
  await run(store.apply(a, "test", fixture(), 0));
  return a;
};

test("revived Arbitrary schemas: every type decodes and round-trips through real jsonb", async () => {
  const r = withRefs(),
    decoder = app.compile(r).schemas.get("employee")!;
  for (const attr of r.attributes!) {
    const schema = valueSchema(attr as Attribute);
    const samples = await run(
      Arbitrary.sampleEffect(Arbitrary.schema(schema), { count: 40, seed: `value-${attr.type}`, maxDiscards: 10000 }),
    );
    for (const value of samples) {
      expect(decodeIssues(decoder, { "person/email": "sample", [attr.key]: value })).toEqual([]);
      const rows = await run(store.sql<{ value: string }>`SELECT ${encodeValue(value)}::jsonb AS value`);
      expect(decodeValue(rows[0]!.value)).toEqual(value);
    }
  }
  for (const value of ["\u0000", "\ud800", "😀".repeat(10000), -0]) {
    const rows = await run(store.sql<{ value: string }>`SELECT ${encodeValue(value)}::jsonb AS value`);
    expect(JSON.stringify(decodeValue(rows[0]!.value))).toBe(JSON.stringify(value));
  }
}, 30000);

test("projections and edges equal independent fact replay after random operations", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          op: fc.constantFrom("create", "patch", "retract", "automation", "delete", "block", "clear", "unlink"),
          target: fc.nat(20),
          value: fc.integer({ min: -20, max: 20 }),
        }),
        { minLength: 15, maxLength: 35 },
      ),
      async (operations) => {
        const a = account(),
          model = new Map<string, Entity>(),
          snapshots: Entity[] = [],
          ids: string[] = [];
        await run(store.apply(a, "test", withRefs(), 0));
        // Every run covers a blocked delete followed by a successful clear.
        // Generated actions vary order, referrers, and targets after that prefix.
        const actions = [
          { op: "create", target: 0, value: 0 },
          { op: "create", target: 0, value: 0 },
          { op: "create", target: 0, value: 0 },
          { op: "block", target: 0, value: 1 },
          { op: "clear", target: 2, value: 1 },
          { op: "delete", target: 1, value: 0 },
          { op: "unlink", target: 0, value: 0 },
          { op: "delete", target: 1, value: 0 },
          { op: "automation", target: 0, value: 1 },
          { op: "retract", target: 0, value: 0 },
          { op: "patch", target: 0, value: 2 },
          ...operations,
          { op: "delete", target: 0, value: 0 },
        ];
        for (const [index, action] of actions.entries()) {
          const id = ids[action.target % (ids.length || 1)],
            old = id ? model.get(id) : undefined;
          const cleared = new Set<string>();
          if (action.op === "create" || !old) {
            const expected = { "person/email": `e${index}@test`, "employee/state": "CA" };
            const e = await run(store.mutate(a, "human", { shape: "employee", facts: expected }));
            expect(e.facts).toEqual(expected);
            ids.push(e.id);
            model.set(e.id, e);
            snapshots.push(e);
          } else if (action.op === "delete") {
            const blockers = [...model.values()].filter((e) => e.id !== old.id && e.facts[block] === old.id);
            if (blockers.length) {
              const error = await run(Effect.flip(store.remove(a, "human", old.id)));
              expect(error).toMatchObject({
                _tag: "Conflict",
                issues: blockers
                  .map((e) => `${e.id}.facts.${block}`)
                  .sort()
                  .map((field) => ({ field, issue: "Referenced" })),
              });
            } else {
              await run(store.remove(a, "human", old.id));
              model.delete(old.id);
              await expect(run(store.getLive(a, old.id))).rejects.toThrow();
              for (const e of model.values()) {
                if (e.facts[clear] !== old.id) continue;
                const facts = { ...e.facts };
                delete facts[clear];
                model.set(e.id, { ...e, facts });
                cleared.add(e.id);
              }
            }
          } else {
            const target = [...model.keys()][Math.abs(action.value) % model.size]!;
            let patch: Record<string, string | number | null>;
            switch (action.op) {
              case "automation":
                patch = { "employee/state": old.facts["employee/state"] === "CO" ? "CA" : "CO" };
                break;
              case "block":
                patch = { [block]: target };
                break;
              case "clear":
                patch = { [clear]: target };
                break;
              case "unlink":
                patch = { [block]: null, [clear]: null };
                break;
              default:
                patch = { "employee/salary": action.op === "retract" ? null : action.value };
            }
            const expected: Facts = { ...old.facts };
            for (const [k, v] of Object.entries(patch))
              if (v === null) delete expected[k];
              else expected[k] = v;
            if (action.op === "automation" && patch["employee/state"] === "CO") expected["employee/salary"] = 50;
            const e = await run(store.mutate(a, "human", { facts: patch }, old.id));
            expect(e.facts).toEqual(expected);
            model.set(e.id, e);
            snapshots.push(e);
          }
          const projected = await run(store.live(a));
          expect(projected.map((e) => [e.id, e.facts]).sort()).toEqual([...model.values()].map((e) => [e.id, e.facts]).sort());
          const edges = await run(store.sql<{ entity_id: string; attribute: string; target_id: string }>`
            SELECT entity_id,attribute,target_id FROM live_refs WHERE account_id=${a} ORDER BY entity_id COLLATE "C",attribute`);
          expect(edges).toEqual(
            projected
              .toSorted((a, b) => (a.id < b.id ? -1 : 1))
              .flatMap((e) =>
                [block, clear].flatMap((attribute) =>
                  e.facts[attribute] === undefined ? [] : [{ entity_id: e.id, attribute, target_id: e.facts[attribute] }],
                ),
              ),
          );
          for (const e of projected) {
            if (cleared.has(e.id)) snapshots.push(e);
            const replay: Facts = {},
              history = await run(store.history(a, e.id));
            for (const row of history.data)
              if (row.op === "assert") replay[row.attribute] = row.value;
              else delete replay[row.attribute];
            expect(e.facts).toEqual(replay);
          }
        }
        for (const snapshot of snapshots) {
          const { effects: _, ...plain } = snapshot as Entity & { effects?: unknown };
          expect(await run(store.asOf(a, snapshot.id, snapshot.updated_at))).toEqual({ ...plain, violations: [] });
        }
      },
    ),
    { numRuns: 12 },
  );
}, 60000);

test("parallel PATCHes succeed, unique races have one winner, registry CAS", async () => {
  const a = await seed(),
    es = await Promise.all(
      Array.from({ length: 12 }, (_, i) => run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": `${i}@test` } }))),
    );
  const writes = await Promise.all(es.map((e, i) => run(store.mutate(a, "test", { facts: { "employee/level": i } }, e.id))));
  expect(writes.map((e) => e.version)).toEqual(es.map(() => 2));
  const race = await Promise.allSettled(
    [1, 2].map(() => run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "same@test" } }))),
  );
  expect(race.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(race.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason))).toMatchObject([
    expect.stringContaining("Conflict"),
  ]);
  const registryRace = await Promise.allSettled([1, 2, 3].map(() => run(store.apply(a, "test", fixture(), 1))));
  expect(registryRace.filter((x) => x.status === "fulfilled")).toHaveLength(1);
}, 30000);

test("failed automation rolls back facts, projection, and outbox; logs reject mutation", async () => {
  const a = account(),
    r = fixture();
  r.automations![0]!.do = [
    { op: "notify", message: "rollback me" },
    { op: "set", attribute: "person/email", value: "collision" },
  ];
  await run(store.apply(a, "test", r, 0));
  await run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "collision" } }));
  const e = await run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "other", "employee/state": "CA" } }));
  const before = await run(store.history(a, e.id));
  await expect(run(store.mutate(a, "test", { facts: { "employee/state": "CO" } }, e.id))).rejects.toThrow();
  expect(await run(store.history(a, e.id))).toEqual(before);
  expect((await run(store.getLive(a, e.id))).facts).toEqual(e.facts);
  expect((await run(store.outbox(a, 0, 200))).data).toEqual([]);
  await expect(run(store.sql`UPDATE facts SET actor='bad' WHERE account_id=${a}`)).rejects.toThrow();
  await expect(run(store.sql`DELETE FROM facts WHERE account_id=${a}`)).rejects.toThrow();
  const held = await run(
    store.sql.withTransaction(
      Effect.gen(function* () {
        yield* store.sql`SELECT pg_advisory_xact_lock(hashtextextended(${a},0))`;
        const locks = yield* store.sql`SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'`;
        return locks;
      }),
    ),
  );
  expect(held).toHaveLength(1);
});

test("soft removal and deletion replay old state, pagination crosses decimal boundaries", async () => {
  const a = await seed(),
    e = await run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "a", "person/note": "history" } }));
  const desired = fixture();
  desired.shapes![0]!.attributes = desired.shapes![0]!.attributes.filter((k: string) => k !== "person/note");
  await run(store.apply(a, "admin", desired, 1, "strict"));
  expect(await run(store.getLive(a, e.id))).toMatchObject({ registry_version: 1, facts: { "person/email": "a" } });
  expect((await run(store.history(a, e.id))).data.every((fact) => fact.reason !== "migration")).toBe(true);
  expect((await run(store.asOf(a, e.id, e.updated_at))).facts).toEqual(e.facts);
  for (let i = 0; i < 15; i++) await run(store.mutate(a, "test", { facts: { "employee/state": i % 2 ? "CA" : "CO" } }, e.id));
  let after = 0;
  const seqs: number[] = [];
  for (;;) {
    const page = await run(store.outbox(a, after, 2));
    if (!page.data.length) break;
    seqs.push(...page.data.map((x) => x.seq));
    after = page.next_after!;
  }
  expect(seqs).toHaveLength(8);
  expect(new Set(seqs).size).toBe(8);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  await run(store.remove(a, "test", e.id));
  expect((await run(store.asOf(a, e.id, e.updated_at))).facts).toEqual(e.facts);
  await expect(run(store.asOf(a, e.id, "9999-01-01T00:00:00.000Z"))).rejects.toThrow();
});

test("a blocked entity writer does not block a different entity in the same account", async () => {
  const a = await seed();
  const first = await run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "first" } }));
  const second = await run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "second" } }));
  let release!: () => void, acquired!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const holder = run(
    store.sql.withTransaction(
      Effect.gen(function* () {
        yield* store.sql`SELECT 1 FROM entities WHERE account_id=${a} AND id=${first.id} FOR UPDATE`;
        acquired();
        yield* Effect.promise(() => gate);
      }),
    ),
  );
  await ready;
  const blocked = run(store.mutate(a, "test", { facts: { "employee/level": 1 } }, first.id));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Observe the writer's account lock while its entity lock cannot be acquired.
    let modes: string[] = [];
    for (let i = 0; i < 50 && !modes.length; i++) {
      modes = (
        await run(
          store.sql<{
            mode: string;
          }>`SELECT mode FROM pg_locks WHERE locktype='advisory' AND objid=(hashtextextended(${a},0) & 4294967295)::oid AND granted`,
        )
      ).map((x) => x.mode);
      if (!modes.length) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(modes).toEqual(["ShareLock"]);
    const free = await Promise.race([
      run(store.mutate(a, "test", { facts: { "employee/level": 2 } }, second.id)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("other entity blocked by account lock")), 1000);
      }),
    ]);
    expect(free.facts["employee/level"]).toBe(2);
  } finally {
    clearTimeout(timeout);
    release();
    await holder;
    await blocked;
  }
}, 10000);

test("generated concurrent writer counts and unique races", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 16 }), async (n) => {
      const a = await seed();
      const entities = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": `generated${i}` } })),
        ),
      );
      const results = await Promise.all(entities.map((e, i) => run(store.mutate(a, "test", { facts: { "employee/level": i } }, e.id))));
      expect(results.map((e) => e.version)).toEqual(Array(n).fill(2));
      const race = await Promise.allSettled(
        [0, 1].map(() => run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "generated-unique-race" } }))),
      );
      expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(race.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([
        expect.stringContaining("Conflict"),
      ]);
    }),
    { numRuns: 8 },
  );
}, 30000);

test("history and as_of remain independent of a damaged projection", async () => {
  const a = await seed();
  const entity = await run(
    store.mutate(a, "test", { shape: "employee", facts: { "person/email": "source-of-truth", "person/note": "original" } }),
  );
  await run(
    store.sql`UPDATE entities SET document=${JSON.stringify({ ...entity, facts: { "person/email": "damaged" } })} WHERE account_id=${a} AND id=${entity.id}`,
  );
  expect((await run(store.asOf(a, entity.id, entity.updated_at))).facts).toEqual(entity.facts);
  expect((await run(store.history(a, entity.id))).data.find((x) => x.attribute === "person/email")?.value).toBe("source-of-truth");
});

const seedDistinctBatch = async (count: number) => {
  const a = account(),
    attribute = "batch/value",
    initial = {
      attributes: [
        { key: attribute, type: "integer" },
        { key: "batch/keep", type: "string" },
      ],
      shapes: [{ key: "batch", attributes: [attribute, "batch/keep"] }],
      automations: [],
    };
  await run(store.apply(a, "test", initial, 0));
  const sql = store.sql;
  await run(
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO events(account_id,entity_id,tx,at,kind,shape,version,registry_version,created_at)
      SELECT ${a},'en_' || lpad(n::text,21,'0'),n,at,'create','batch',1,1,at
      FROM generate_series(1,${count}::integer) n
      CROSS JOIN LATERAL (SELECT to_char(timestamp '2024-01-01' + n * interval '1 millisecond',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at) t`;
        yield* sql`INSERT INTO facts(account_id,entity_id,tx,at,attribute,op,value,reason,actor)
      SELECT account_id,entity_id,tx,at,${attribute},'assert',to_jsonb(tx::text),'api','test'
      FROM events WHERE account_id=${a}`;
        yield* sql`INSERT INTO entities(account_id,id,document)
      SELECT account_id,entity_id,jsonb_build_object('id',entity_id,'shape',shape,'version',version,
        'registry_version',registry_version,'created_at',created_at,'updated_at',at,
        'facts',jsonb_build_object(${attribute}::text,tx))::text FROM events WHERE account_id=${a}`;
        yield* sql`UPDATE account_clocks SET tx=${count} WHERE account_id=${a}`;
      }),
    ),
  );

  return { a, initial, attribute };
};

test("soft removal leaves every stored projection and fact intact", async () => {
  const count = 10_000;
  const { a, initial, attribute } = await seedDistinctBatch(count);
  const applied = await run(store.apply(a, "admin", { ...initial, shapes: [{ key: "batch", attributes: ["batch/keep"] }] }, 1));
  expect(applied.version).toBe(2);
  const entities = await run(store.live(a));
  expect(entities).toHaveLength(count);
  expect(entities.every((e) => e.registry_version === 1 && e.version === 1 && attribute in e.facts)).toBe(true);
  const [hiddenAt] = await run(store.sql<{ at: string }>`SELECT at FROM registry_versions WHERE account_id=${a} AND version=2`);
  for (const e of [entities[0]!, entities.at(-1)!]) {
    expect((await run(store.history(a, e.id))).data).toHaveLength(1);
    expect((await run(store.asOf(a, e.id, e.updated_at))).facts).toEqual(e.facts);
    expect((await run(store.asOf(a, e.id, hiddenAt!.at))).facts).toEqual({});
    expect((await run(store.getLive(a, e.id))).facts).toEqual({});
  }
}, 30000);

test("apply enables uniqueness beyond the shared advisory lock table without writing migration events", async () => {
  const count = 30_000;
  const { a, initial, attribute } = await seedDistinctBatch(count);
  const desired = { ...initial, attributes: initial.attributes.map((attr) => (attr.key === attribute ? { ...attr, unique: true } : attr)) };
  expect((await run(store.apply(a, "admin", desired, 1, "strict"))).version).toBe(2);
  const sql = store.sql;
  const [counts] = await run(sql<{ slots: string; events: string }>`SELECT
    (SELECT count(*) FROM live_unique WHERE account_id=${a})::text AS slots,
    (SELECT count(*) FROM events WHERE account_id=${a})::text AS events`);
  expect(counts).toMatchObject({ slots: String(count), events: String(count) });
  const duplicate = await run(Effect.flip(store.mutate(a, "test", { shape: "batch", facts: { [attribute]: count } })));
  expect(duplicate).toMatchObject({ _tag: "Conflict", issues: [{ field: `facts.${attribute}`, issue: "Duplicate unique value" }] });
}, 30000);

async function duringPreflight<A>(apply: Effect.Effect<A, unknown>, write: () => Promise<unknown>) {
  const scanned = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let paused = false;
  const applied = run(
    apply.pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        if (paused || !statement.compile()[0].includes('ORDER BY c.entity_id COLLATE "C"')) return Effect.succeed(statement);
        paused = true;
        scanned.resolve();
        return Effect.promise(() => resume.promise).pipe(Effect.as(statement));
      }),
      Effect.exit,
    ),
  );
  try {
    await Promise.race([
      scanned.promise,
      applied.then(() => {
        throw new Error("Apply exited before its scan");
      }),
    ]);
    await write();
  } finally {
    resume.resolve();
  }
  return run(
    Effect.flatMap(
      Effect.promise(() => applied),
      (exit) => exit,
    ),
  );
}

test("apply rechecks uniqueness groups when a writer changes a scanned value", async () => {
  const a = account(),
    attribute = "test/value";
  const initial = {
    attributes: [{ key: attribute, type: "integer" }],
    shapes: [{ key: "item", attributes: [attribute] }],
    automations: [],
  };
  const desired = { ...initial, attributes: [{ key: attribute, type: "integer", unique: true }] };
  const patch = (id: string, value: number) => run(store.mutate(a, "writer", { facts: { [attribute]: value } }, id));
  await run(store.apply(a, "test", initial, 0));
  const first = await run(store.mutate(a, "test", { shape: "item", facts: { [attribute]: 1 } }));
  const second = await run(store.mutate(a, "test", { shape: "item", facts: { [attribute]: 2 } }));
  const loser = [first.id, second.id].sort()[1];
  await expect(
    duringPreflight(Effect.flip(store.apply(a, "admin", desired, 1, "strict")), () => patch(first.id, 2)),
  ).resolves.toMatchObject({
    _tag: "Conflict",
    issues: [{ field: `${loser}.facts.${attribute}`, issue: "Duplicate unique value" }],
  });
  const lower = [first.id, second.id].sort()[0]!;
  await expect(duringPreflight(store.apply(a, "admin", desired, 1, "strict"), () => patch(lower, 3))).resolves.toMatchObject({
    version: 2,
  });
});

test("apply detects a deleted target referenced by an unchanged source during preflight", async () => {
  const a = account(),
    attribute = "test/target";
  const initial = {
    attributes: [{ key: attribute, type: "string" }],
    shapes: [{ key: "item", attributes: [attribute] }],
    automations: [],
  };
  const desired = { ...initial, attributes: [{ key: attribute, type: "ref", target: "item" }] };
  await run(store.apply(a, "test", initial, 0));
  const target = await run(store.mutate(a, "test", { shape: "item", facts: {} }));
  const source = await run(store.mutate(a, "test", { shape: "item", facts: { [attribute]: target.id } }));
  await expect(
    duringPreflight(Effect.flip(store.apply(a, "admin", desired, 1, "strict")), () => run(store.remove(a, "writer", target.id))),
  ).resolves.toMatchObject({ _tag: "Conflict", issues: [{ field: `${source.id}.facts.${attribute}`, issue: "Dangling reference" }] });
  expect((await run(store.getRegistry(a))).version).toBe(1);
});

test("soft removal preserves values written before and after the apply", async () => {
  const a = account();
  const initial = {
    attributes: [
      { key: "test/drop", type: "integer" },
      { key: "test/keep", type: "integer" },
    ],
    shapes: [{ key: "item", attributes: ["test/drop", "test/keep"] }],
    automations: [],
  };
  const desired = { ...initial, shapes: [{ key: "item", attributes: ["test/keep"] }] };
  await run(store.apply(a, "test", initial, 0));
  const e = await run(store.mutate(a, "test", { shape: "item", facts: { "test/drop": 1, "test/keep": 2 } }));
  await run(store.mutate(a, "writer", { facts: { "test/drop": 3 } }, e.id));
  await run(store.apply(a, "admin", desired, 1, "strict"));
  const current = await run(store.mutate(a, "writer", { facts: { "test/keep": 4 } }, e.id));
  expect(current).toMatchObject({ facts: { "test/keep": 4 }, version: 3, registry_version: 2 });
  expect((await run(store.asOf(a, e.id, current.updated_at))).facts).toEqual(current.facts);
  await run(store.apply(a, "admin", initial, 2));
  expect((await run(store.getLive(a, e.id))).facts).toEqual({ "test/drop": 3, "test/keep": 4 });
});

test("a replacement store continues the database clock", async () => {
  const a = await seed();
  const first = await run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "before-restart" } }));
  const replacement = await runtime.runPromise(makeStore());
  const second = await run(replacement.mutate(a, "test", { facts: { "person/note": "after-restart" } }, first.id));
  expect(second.updated_at > first.updated_at).toBe(true);
  const history = await run(replacement.history(a, first.id));
  expect(history.data.at(-1)!.tx).toBeGreaterThan(history.data[0]!.tx);
});

test("two Store instances with separate pools allocate increasing database tx/at", async () => {
  const otherRuntime = ManagedRuntime.make(
    DataLive.pipe(
      Layer.provideMerge(
        PgClient.layer({
          url: Redacted.make(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/onb_data_test"),
          maxConnections: 20,
        }),
      ),
    ),
  );
  try {
    const other = await otherRuntime.runPromise(Store),
      a = await seed();
    const [firstPid, secondPid] = await Promise.all([
      run(store.sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`),
      run(other.sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`),
    ]);
    expect(firstPid[0]!.pid).not.toBe(secondPid[0]!.pid);
    const creates = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        run(
          (i % 2 ? other : store).mutate(a, "replica", {
            shape: "employee",
            facts: { "person/email": `replica${i}`, "employee/state": i % 2 ? "CO" : "CA" },
          }),
        ),
      ),
    );
    const updates = await Promise.all(
      creates.map((e, i) =>
        run(
          (i % 2 ? store : other).mutate(
            a,
            "replica",
            { facts: { "employee/state": e.facts["employee/state"] === "CO" ? "CA" : "CO" } },
            e.id,
          ),
        ),
      ),
    );
    const races = await Promise.allSettled([
      run(store.mutate(a, "first", { shape: "employee", facts: { "person/email": "replica-race" } })),
      run(other.mutate(a, "second", { shape: "employee", facts: { "person/email": "replica-race" } })),
    ]);
    expect(races.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(races.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason))).toEqual([
      expect.stringContaining("Conflict"),
    ]);
    const events = await run(
      store.sql<{ tx: string; at: string }>`SELECT tx::text,at FROM events WHERE account_id=${a} ORDER BY events.tx`,
    );
    expect(new Set(events.map((e) => e.tx)).size).toBe(events.length);
    for (let i = 1; i < events.length; i++) {
      expect(Number(events[i]!.tx)).toBeGreaterThan(Number(events[i - 1]!.tx));
      expect(events[i]!.at > events[i - 1]!.at).toBe(true);
    }
    for (const snapshot of [...creates, ...updates]) {
      const { effects: _, ...plain } = snapshot;
      expect(await run(other.asOf(a, snapshot.id, snapshot.updated_at))).toEqual({ ...plain, violations: [] });
      const history = await run(store.history(a, snapshot.id));
      for (const fact of history.data) expect(fact.at).toBe(events.find((e) => Number(e.tx) === fact.tx)!.at);
    }
  } finally {
    await otherRuntime.dispose();
  }
}, 30000);

test("forced hash collisions compare exact values and retain database uniqueness", async () => {
  const collisionStore = await runtime.runPromise(makeStore("forced-collision")),
    a = account();
  await run(collisionStore.apply(a, "test", fixture(), 0));
  const [first, second] = await Promise.all(
    ["first-distinct", "second-distinct"].map((value) =>
      run(collisionStore.mutate(a, "test", { shape: "employee", facts: { "person/email": value } })),
    ),
  );
  expect(first!.id).not.toBe(second!.id);
  expect(
    await run(Effect.result(collisionStore.mutate(a, "test", { shape: "employee", facts: { "person/email": "first-distinct" } }))),
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "Conflict", issues: [{ field: "facts.person/email" }] } });
  const relaxed = fixture();
  relaxed.attributes = relaxed.attributes.map((attr) => (attr.key === "person/email" ? { ...attr, unique: false } : attr));
  await run(collisionStore.apply(a, "test", relaxed, 1, "strict"));
  const escaped = "third\u0000\ud800";
  await run(collisionStore.mutate(a, "test", { shape: "employee", facts: { "person/email": escaped } }));
  await run(collisionStore.apply(a, "test", fixture(), 2, "strict"));
  const reused = await run(Effect.flip(collisionStore.mutate(a, "test", { shape: "employee", facts: { "person/email": escaped } })));
  expect(reused).toMatchObject({ _tag: "Conflict", issues: [{ field: "facts.person/email" }] });
  const values = await run(
    store.sql<{ count: string }>`SELECT count(*)::text AS count FROM unique_values WHERE account_id=${a} AND hash='forced-collision'`,
  );
  expect(values[0]!.count).toBe("3");
});

test("compiled registry cache evicts least recently used entries at 1000", async () => {
  const r = fixture(),
    first = store.compiled("acct_cache_0", 1, r);
  for (let i = 1; i < 1000; i++) store.compiled(`acct_cache_${i}`, 1, r);
  expect(store.compiled("acct_cache_0", 1, r)).toBe(first);
  store.compiled("acct_cache_overflow", 1, r);
  expect(store.compiled("acct_cache_0", 1, r)).toBe(first);
  for (let i = 1001; i < 2001; i++) store.compiled(`acct_cache_${i}`, 1, r);
  expect(store.compiled("acct_cache_0", 1, r)).not.toBe(first);
});

const rollValue = "roll/value";
const rollLink = "roll/link";
const rollKeep = "roll/keep";
function rolloutFixture(flags: number): Registry {
  return {
    attributes: [
      { key: rollValue, type: "integer", unique: !!(flags & 1) },
      { key: rollLink, type: "ref", target: "target", unique: !!(flags & 2) },
      { key: rollKeep, type: "integer" },
    ],
    shapes: [
      { key: "item", attributes: [rollKeep, ...(flags & 4 ? [] : [rollValue]), ...(flags & 8 ? [] : [rollLink])] },
      { key: "target", attributes: [rollKeep] },
    ],
    automations: [],
  };
}
async function drainRollout(s: StoreValue, a: string, limit = 3) {
  for (let i = 0; i < 100; i++) if (!(await run(s.runRolloutBatch(a, limit)))) return;
  throw new Error("Rollout did not finish");
}
async function checkRollout(a: string, registry: Registry) {
  const entities = await run(store.live(a));
  const byId = new Map(entities.map((e) => [e.id, e]));
  const config = app.compile(registry);
  const refs: string[][] = [];
  const slots = new Map<string, string[]>();
  const dangling: string[][] = [];
  for (const entity of entities) {
    for (const [key, value] of Object.entries(entity.facts))
      if (config.edges.has(key)) refs.push([entity.id, key, config.storedRefTarget(value)]);
    for (const [key, value] of Object.entries(config.visible(entity.shape, entity.facts))) {
      if (config.unique.has(key)) {
        const identity = canonical([key, value]);
        slots.set(identity, [...(slots.get(identity) ?? []), entity.id]);
      }
      const edge = config.edges.get(key);
      if (edge && byId.get(String(value))?.shape !== edge.target) dangling.push([entity.id, key, canonical(value)]);
    }
  }
  const actualRefs = await run(store.sql<{ entity_id: string; attribute: string; target_id: string }>`
    SELECT entity_id,attribute,target_id FROM live_refs WHERE account_id=${a}`);
  expect(actualRefs.map((ref) => [ref.entity_id, ref.attribute, ref.target_id]).sort()).toEqual(refs.sort());
  const holders = await run(store.sql<{ entity_id: string; attribute: string; value: string }>`
    SELECT entity_id,attribute,value FROM live_unique WHERE account_id=${a}`);
  const open = (await run(store.listViolations(a, "open", undefined, 0, 200))).data;
  expect(holders).toHaveLength(slots.size);
  const duplicate: string[][] = [];
  for (const { entity_id, attribute, value } of holders) {
    const members = slots.get(canonical([attribute, decodeValue(value)]));
    expect(members).toContain(entity_id);
    for (const id of members!.filter((id) => id !== entity_id)) duplicate.push([id, attribute, canonical(decodeValue(value))]);
  }
  for (const [issue, expected] of [
    ["duplicate", duplicate],
    ["dangling_reference", dangling],
  ] as const)
    expect(
      open
        .filter((v) => v.issue === issue)
        .map((v) => [v.entity_id, v.attribute, canonical(v.value)])
        .sort(),
    ).toEqual(expected.sort());
}

test("rollout projections match a fresh derivation with writes and superseding applies between batches", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.record({ flags: fc.nat(15), writes: fc.array(fc.nat(45), { minLength: 1, maxLength: 6 }), supersede: fc.boolean() }), {
        minLength: 3,
        maxLength: 9,
      }),
      async (changes) => {
        const a = account(),
          targets: string[] = [],
          items: string[] = [];
        let version = 0;
        await run(store.apply(a, "test", rolloutFixture(0), version++));
        for (let n = 0; n < 5; n++) targets.push((await run(store.mutate(a, "test", { shape: "target", facts: { [rollKeep]: n } }))).id);
        for (let n = 0; n < 12; n++)
          items.push(
            (
              await run(
                store.mutate(a, "test", {
                  shape: "item",
                  facts: { [rollValue]: n % 3, [rollLink]: targets[n % targets.length] },
                }),
              )
            ).id,
          );

        for (const { flags, writes, supersede } of changes) {
          const registry = rolloutFixture(flags);
          await run(store.apply(a, "test", registry, version++));
          for (const n of writes) {
            await run(store.runRolloutBatch(a, 3));
            const id = items[n % items.length]!;
            const action = n % 6;
            const next =
              action === 0
                ? store.remove(a, "test", targets[n % targets.length]!)
                : action === 1
                  ? store.remove(a, "test", id)
                  : Effect.asVoid(
                      store.mutate(
                        a,
                        "test",
                        {
                          facts:
                            action <= 3
                              ? { [rollValue]: n % 5 }
                              : action === 4
                                ? { [rollLink]: targets[(n + 1) % targets.length] }
                                : { [rollKeep]: n },
                        },
                        id,
                      ),
                    );
            const result = await run(Effect.result(next));
            if (result._tag === "Failure") expect(["Conflict", "Invalid", "NotFound"]).toContain(result.failure._tag);
          }
          if (!supersede) {
            await drainRollout(store, a);
            await checkRollout(a, registry);
          }
        }
        await drainRollout(store, a);
        await checkRollout(a, rolloutFixture(changes.at(-1)!.flags));
      },
    ),
    { numRuns: 20 },
  );
}, 60000);

test("a new Store resumes from a persisted cursor and a later apply supersedes an unfinished rollout", async () => {
  const a = account();
  await run(store.apply(a, "test", rolloutFixture(0), 0));
  for (let n = 0; n < 10; n++) await run(store.mutate(a, "test", { shape: "item", facts: { [rollValue]: n % 2 } }));
  await run(store.apply(a, "test", rolloutFixture(1), 1));
  await run(store.runRolloutBatch(a, 3));
  const [before] = await run(
    store.sql<{ cursor: string; processed: number }>`SELECT cursor,processed FROM rollouts WHERE account_id=${a} AND registry_version=2`,
  );
  expect(before?.cursor).toMatch(/^en_/);
  expect(before?.processed).toBe(3);
  const replacement = await runtime.runPromise(makeStore());
  await run(replacement.runRolloutBatch(a, 3));
  const [after] = await run(
    store.sql<{ cursor: string; processed: number }>`SELECT cursor,processed FROM rollouts WHERE account_id=${a} AND registry_version=2`,
  );
  expect(after!.cursor > before!.cursor).toBe(true);
  expect(after?.processed).toBe(6);
  await drainRollout(replacement, a);
  await checkRollout(a, rolloutFixture(1));
  await run(replacement.apply(a, "test", rolloutFixture(5), 2));
  await run(replacement.runRolloutBatch(a, 3));
  await run(replacement.apply(a, "test", rolloutFixture(1), 3));
  const [superseded] = await run(store.sql<{ status: string }>`SELECT status FROM rollouts WHERE account_id=${a} AND registry_version=3`);
  expect(superseded?.status).toBe("superseded");
  await drainRollout(replacement, a);
  await checkRollout(a, rolloutFixture(1));
});

test.each(["strict", "rollout"] as const)("moves a slot between shapes in %s mode, releasing before claiming", async (mode) => {
  const a = account();
  const base = rolloutFixture(1);
  const first = {
    ...base,
    shapes: [
      { key: "item", attributes: [rollKeep] },
      { key: "target", attributes: [rollKeep, rollValue] },
    ],
  };
  const second = {
    ...base,
    shapes: [
      { key: "item", attributes: [rollKeep, rollValue] },
      { key: "target", attributes: [rollKeep] },
    ],
  };
  await run(store.apply(a, "test", first, 0, "strict"));
  const target = await run(store.mutate(a, "test", { shape: "target", facts: { [rollValue]: 42 } }));
  await run(store.apply(a, "test", second, 1, "strict"));
  const item = await run(store.mutate(a, "test", { shape: "item", facts: { [rollValue]: 42 } }));
  await run(store.apply(a, "test", first, 2, mode));
  const holders = () => run(store.sql<{ entity_id: string }>`SELECT entity_id FROM live_unique WHERE account_id=${a}`);
  if (mode === "rollout") {
    expect(await holders()).toEqual([{ entity_id: item.id }]);
    for (let i = 0; i < 3; i++) await run(store.runRolloutBatch(a, 1));
    expect(await holders()).toEqual([]);
    await drainRollout(store, a, 1);
  } else {
    expect(await run(store.rolloutStatus(a, 3))).toBeNull();
  }
  expect(await holders()).toEqual([{ entity_id: target.id }]);
  await checkRollout(a, first);
});

test("stored ref projection follows type changes while a value is hidden", async () => {
  const a = account();
  const active = rolloutFixture(0);
  const string = {
    ...active,
    attributes: active.attributes.map((attr) => (attr.key === rollLink ? { key: rollLink, type: "string" } : attr)),
  };
  const hiddenRef = rolloutFixture(8);
  const hiddenString = { ...string, shapes: hiddenRef.shapes };
  await run(store.apply(a, "test", string, 0));
  const target = await run(store.mutate(a, "test", { shape: "target", facts: {} }));
  await run(store.mutate(a, "test", { shape: "item", facts: { [rollLink]: target.id } }));
  const invalid = "\u0000\ud800" + "x".repeat(3000);
  const malformed = await run(store.mutate(a, "test", { shape: "item", facts: { [rollLink]: invalid } }));
  await run(store.apply(a, "test", hiddenRef, 1));
  await checkRollout(a, hiddenRef);
  await run(store.remove(a, "test", target.id));
  const failed = await run(Effect.flip(store.apply(a, "test", active, 2)));
  expect(failed).toMatchObject({ _tag: "Conflict", issues: [{ field: `${malformed.id}.facts.${rollLink}` }] });
  await run(store.apply(a, "test", hiddenString, 2));
  await drainRollout(store, a);
  await checkRollout(a, hiddenString);
});

test("a writer can claim a new unique slot before an existing value has been scanned", async () => {
  const a = account();
  await run(store.apply(a, "test", rolloutFixture(0), 0));
  const incumbent = await run(store.mutate(a, "test", { shape: "item", facts: { [rollValue]: 4 } }));
  await run(store.apply(a, "test", rolloutFixture(1), 1));
  const writer = await run(store.mutate(a, "test", { shape: "item", facts: { [rollValue]: 4 } }));
  await drainRollout(store, a);
  expect((await run(store.getLive(a, incumbent.id))).violations).toEqual([{ attribute: rollValue, issue: "duplicate" }]);
  expect((await run(store.getLive(a, writer.id))).violations).toEqual([]);
  await checkRollout(a, rolloutFixture(1));
});

test("retargeting a restored ref resolves the existing record in the registry transaction", async () => {
  const a = account();
  const base = rolloutFixture(0);
  const expanded = { ...base, shapes: [...base.shapes, { key: "other", attributes: [rollKeep] }] };
  const string = {
    ...expanded,
    attributes: expanded.attributes.map((attr) => (attr.key === rollLink ? { key: rollLink, type: "string" } : attr)),
  };
  const hidden = { ...string, shapes: [...rolloutFixture(8).shapes, expanded.shapes[2]!] };
  await run(store.apply(a, "test", string, 0));
  const target = await run(store.mutate(a, "test", { shape: "other", facts: {} }));
  const source = await run(store.mutate(a, "test", { shape: "item", facts: { [rollLink]: target.id } }));
  await run(store.apply(a, "test", hidden, 1));
  await run(store.apply(a, "test", expanded, 2));
  await drainRollout(store, a);
  expect((await run(store.getLive(a, source.id))).violations).toEqual([{ attribute: rollLink, issue: "dangling_reference" }]);
  const corrected = {
    ...expanded,
    attributes: expanded.attributes.map((attr) => (attr.key === rollLink ? { ...attr, target: "other" } : attr)),
  };
  await run(store.apply(a, "test", corrected, 3));
  expect((await run(store.getLive(a, source.id))).violations).toEqual([]);
  expect((await run(store.referrers(a, target.id))).data).toEqual([{ entity_id: source.id, attribute: rollLink, on_delete: "block" }]);
  const [violation] = (await run(store.listViolations(a, "resolved", rollLink, 0, 50))).data;
  const [registry] = await run(store.sql<{ at: string }>`SELECT at FROM registry_versions WHERE account_id=${a} AND version=4`);
  expect(violation?.resolved_at).toBe(registry?.at);
});

test("a strict apply replaces stale slot values when it supersedes a release", async () => {
  const a = account();
  await run(store.apply(a, "test", rolloutFixture(1), 0, "strict"));
  const owner = await run(store.mutate(a, "test", { shape: "item", facts: { [rollValue]: 4 } }));
  await run(store.apply(a, "test", rolloutFixture(0), 1));
  await run(store.mutate(a, "test", { facts: { [rollValue]: 5 } }, owner.id));
  await run(store.apply(a, "test", rolloutFixture(1), 2, "strict"));
  expect(await run(store.rolloutStatus(a, 3))).toBeNull();
  await checkRollout(a, rolloutFixture(1));
  await run(store.mutate(a, "test", { shape: "item", facts: { [rollValue]: 4 } }));
  expect(await run(Effect.flip(store.mutate(a, "test", { shape: "item", facts: { [rollValue]: 5 } })))).toMatchObject({ _tag: "Conflict" });
});
