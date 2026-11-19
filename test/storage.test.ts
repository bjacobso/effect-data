import { beforeAll, afterAll, test, expect } from "vitest";
import fc from "fast-check";
import { Effect, ManagedRuntime, Arbitrary, Schema, Redacted, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { randomBytes } from "node:crypto";
import { DataLive } from "../src/composition.ts";
import { Engine, type EngineValue } from "../src/core/engine.ts";
import { makeStore, encodeValue, decodeValue, Store, type StoreValue } from "../src/storage/Store.ts";
import { migrate } from "../src/Migrations.ts";
import { type Entity, type Facts, type Attribute, decodeIssues } from "../src/core/model.ts";
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
          expect(await run(store.asOf(a, snapshot.id, snapshot.updated_at))).toEqual(plain);
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

test("migration and deletion replay old state, pagination crosses decimal boundaries", async () => {
  const a = await seed(),
    e = await run(store.mutate(a, "test", { shape: "employee", facts: { "person/email": "a", "person/note": "history" } }));
  const desired = fixture();
  desired.attributes = desired.attributes!.filter((a) => a.key !== "person/note");
  desired.shapes![0]!.attributes = desired.shapes![0]!.attributes.filter((k: string) => k !== "person/note");
  await run(store.apply(a, "admin", desired, 1));
  expect((await run(store.getLive(a, e.id))).registry_version).toBe(2);
  expect((await run(store.history(a, e.id))).data.at(-1)).toMatchObject({
    reason: "migration",
    actor: "admin",
    op: "retract",
    value: "history",
  });
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

test("apply commits migration retractions across PostgreSQL bind batches", async () => {
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
  const count = 10_000;
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
        yield* sql`INSERT INTO account_clocks VALUES (${a},${count},${Date.UTC(2024, 0, 1) + count})`;
      }),
    ),
  );

  const applied = await run(store.apply(a, "admin", { ...initial, shapes: [{ key: "batch", attributes: ["batch/keep"] }] }, 1));
  expect(applied.version).toBe(2);
  const entities = await run(store.live(a));
  expect(entities).toHaveLength(count);
  expect(entities.every((e) => e.registry_version === 2 && e.version === 2 && Object.keys(e.facts).length === 0)).toBe(true);
  const [migration] = await run(sql<{ count: string }>`SELECT count(*)::text FROM facts WHERE account_id=${a} AND reason='migration'`);
  expect(Number(migration!.count)).toBe(count);
  for (const e of [entities[0]!, entities.at(-1)!]) {
    const [created, retracted] = (await run(store.history(a, e.id))).data;
    expect(retracted).toMatchObject({ op: "retract", attribute, value: created!.value, actor: "admin", reason: "migration" });
    expect((await run(store.asOf(a, e.id, created!.at))).facts).toEqual({ [attribute]: created!.value });
    expect(await run(store.asOf(a, e.id, retracted!.at))).toEqual(e);
  }
}, 30000);

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
      expect(await run(other.asOf(a, snapshot.id, snapshot.updated_at))).toEqual(plain);
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
  const values = await run(
    store.sql<{ count: string }>`SELECT count(*)::text AS count FROM unique_values WHERE account_id=${a} AND hash='forced-collision'`,
  );
  expect(values[0]!.count).toBe("2");
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
