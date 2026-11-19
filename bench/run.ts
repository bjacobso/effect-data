import { writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { dataLayer } from "../src/composition.ts";
import type { Registry } from "../src/core/model.ts";
import { migrate } from "../src/Migrations.ts";
import { Store } from "../src/storage/Store.ts";

const mode = process.env.BENCH_MODE ?? "baseline";
const url = new URL(process.env.BENCH_DATABASE_URL ?? "postgres://localhost:5432/onb_data_bench");
if (url.pathname !== "/onb_data_bench" || (mode !== "baseline" && mode !== "refs"))
  throw new Error("Use the onb_data_bench database and BENCH_MODE=baseline or BENCH_MODE=refs");

const bigCount = Number(process.env.BENCH_ENTITIES ?? 1_000_000);
const writesPerWorker = Number(process.env.BENCH_WRITES ?? 250);
const workers = 16;
if (!Number.isSafeInteger(bigCount) || bigCount < workers + 6 || !Number.isSafeInteger(writesPerWorker) || writesPerWorker < 1)
  throw new Error("BENCH_ENTITIES must be at least 22 and BENCH_WRITES must be positive");

const namespace = `effect_data_bench_${mode}`;
const big = "bench_big";
const small = Array.from({ length: 100 }, (_, i) => `bench_small_${i}`);
const smallCount = 32;
const historySizes = [10, 1_000, 10_000];
const historySamples = 30;
const epoch = Date.UTC(2024, 0, 1);
const entityId = (n: number) => `en_${String(n).padStart(21, "0")}`;
const link = mode === "refs" ? { key: "bench/link", type: "ref", target: "bench" } : { key: "bench/link", type: "string" };
const populated: Registry["attributes"] = [
  link,
  { key: "bench/name", type: "string" },
  { key: "bench/count", type: "integer" },
  { key: "bench/ratio", type: "number" },
  { key: "bench/flag", type: "boolean" },
  { key: "bench/day", type: "date" },
  { key: "bench/state", type: "enum", values: ["a", "b"] },
];
const attributes = [
  ...populated,
  ...Array.from({ length: 200 - populated.length }, (_, i) => ({
    ...populated[1 + (i % 6)]!,
    key: `bench/extra_${i}`,
  })),
];
const registry: Registry = {
  attributes,
  shapes: [{ key: "bench", attributes: attributes.slice(0, 199).map(({ key }) => key) }],
  automations: [],
};

const timestamp = (tx: number) => new Date(epoch + tx).toISOString();
const percentile = (sorted: number[], p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
const latencies = (samples: number[]) => {
  const ordered = [...samples].sort((a, b) => a - b);
  return { p50_ms: percentile(ordered, 0.5), p95_ms: percentile(ordered, 0.95), p99_ms: percentile(ordered, 0.99) };
};

const seed = Effect.fnUntraced(function* (account: string, count: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO registries(account_id,version,document) VALUES (${account},1,${JSON.stringify(registry)})`;
  for (let start = 1; start <= count; start += 10_000) {
    const end = Math.min(count, start + 9_999);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        INSERT INTO events(account_id,entity_id,tx,at,kind,shape,version,registry_version,created_at)
        SELECT ${account}, 'en_' || lpad(n::text,21,'0'), n, at, 'create', 'bench', 1, 1, at
        FROM generate_series(${start}::integer,${end}::integer) AS n
        CROSS JOIN LATERAL (SELECT to_char(to_timestamp((${epoch}::bigint+n)/1000.0) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at) t
      `;
        yield* sql`
        INSERT INTO entities(account_id,id,document)
        SELECT account_id, entity_id, jsonb_build_object(
          'id',entity_id,'shape',shape,'version',1,'registry_version',1,'created_at',at,'updated_at',at,
          'facts',jsonb_build_object(
            'bench/link','en_' || lpad((tx % ${count} + 1)::text,21,'0'),
            'bench/name','name','bench/count',tx,'bench/ratio',1.5,
            'bench/flag',false,'bench/day','2024-01-01','bench/state','a'
          )
        )::text FROM events WHERE account_id=${account} AND tx BETWEEN ${start} AND ${end}
      `;
        yield* sql`
        INSERT INTO facts(account_id,entity_id,tx,at,attribute,op,value,reason,actor)
        SELECT e.account_id,e.entity_id,e.tx,e.at,f.key,'assert',to_jsonb(f.value::text),'api','bench'
        FROM events e JOIN entities p ON p.account_id=e.account_id AND p.id=e.entity_id
        CROSS JOIN LATERAL jsonb_each(p.document::jsonb->'facts') f
        WHERE e.account_id=${account} AND e.tx BETWEEN ${start} AND ${end}
      `;
        if (mode === "refs")
          yield* sql`
          INSERT INTO live_refs(account_id,entity_id,attribute,target_id)
          SELECT account_id,entity_id,'bench/link','en_' || lpad((tx % ${count} + 1)::text,21,'0')
          FROM events WHERE account_id=${account} AND tx BETWEEN ${start} AND ${end}
        `;
      }),
    );
    if (account === big && (end % 100_000 === 0 || end === count)) console.log(`Seeded ${end}/${count} large-account entities`);
  }
  let lastTx = count;
  const snapshots = [];
  if (account === big)
    for (const [i, size] of historySizes.entries()) {
      const id = entityId(i + 1);
      const extra = size - populated.length;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO events(account_id,entity_id,tx,at,kind,shape,version,registry_version,created_at)
          SELECT ${account},${id},${lastTx}::bigint+n,
            to_char(to_timestamp((${epoch + lastTx}::bigint+n)/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'write','bench',n+1,1,${timestamp(i + 1)}
          FROM generate_series(1,${extra}::integer) n
        `;
          yield* sql`
          INSERT INTO facts(account_id,entity_id,tx,at,attribute,op,value,reason,actor)
          SELECT account_id,entity_id,tx,at,'bench/flag','assert',to_jsonb((version % 2 = 0)::text),'api','bench'
          FROM events WHERE account_id=${account} AND tx BETWEEN ${lastTx + 1} AND ${lastTx + extra}
        `;
          yield* sql`
          UPDATE entities SET document=(document::jsonb || jsonb_build_object(
            'version',${extra + 1}::integer,'updated_at',${timestamp(lastTx + extra)}::text,
            'facts',(document::jsonb->'facts') || jsonb_build_object('bench/flag',${extra % 2 === 1}::boolean)
          ))::text WHERE account_id=${account} AND id=${id}
        `;
        }),
      );
      lastTx += extra;
      snapshots.push({ id, at: timestamp(lastTx), history_rows: size, version: 1 + extra });
    }
  yield* sql`INSERT INTO account_clocks(account_id,tx,at_ms) VALUES (${account},${lastTx},${epoch + lastTx})`;
  return snapshots;
});

const patchRun = Effect.fnUntraced(function* (spread: boolean) {
  const store = yield* Store;
  const run = (offset: number, count: number) =>
    Effect.forEach(
      Array.from({ length: workers }, (_, i) => i),
      (worker) =>
        Effect.forEach(
          Array.from({ length: count }, (_, i) => i + offset),
          (write) =>
            Effect.gen(function* () {
              const account = spread ? small[(write * workers + worker) % small.length]! : big;
              const source = entityId(4 + worker);
              // 25 visits return each worker to a given account. With two passes
              // through those 25 visits the target toggles for every source.
              const parity = spread ? Math.floor(write / 25) % 2 : write % 2;
              const target = entityId((spread ? smallCount : bigCount) - parity);
              const start = performance.now();
              const result = yield* store.mutate(account, "bench", { facts: { "bench/link": target } }, source);
              if (result.facts["bench/link"] !== target) throw new Error("PATCH did not set the link");
              return performance.now() - start;
            }),
        ),
      { concurrency: workers },
    );
  yield* run(0, 50);
  const start = performance.now();
  const samples = (yield* run(50, writesPerWorker)).flat();
  const wall = performance.now() - start;
  return { writes: samples.length, wall_ms: wall, writes_per_second: (samples.length * 1_000) / wall, ...latencies(samples) };
});

const benchmark = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store;
  yield* migrate;
  yield* sql`
    CREATE FUNCTION observe_apply_lock() RETURNS double precision LANGUAGE plpgsql AS $$
    DECLARE k bigint := hashtextextended('bench_big',0);
      deadline timestamptz := clock_timestamp() + interval '15 seconds';
      acquired timestamptz;
    BEGIN
      LOOP
        IF EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=((k >> 32) & 4294967295)::oid AND objid=(k & 4294967295)::oid AND objsubid=1) THEN
          acquired := coalesce(acquired,clock_timestamp());
        ELSIF acquired IS NOT NULL THEN
          RETURN extract(epoch FROM clock_timestamp()-acquired)*1000;
        ELSIF clock_timestamp()>deadline THEN
          RAISE EXCEPTION 'Timed account lock was not observed';
        END IF;
        PERFORM pg_sleep(0.001);
      END LOOP;
    END $$
  `.unprepared;
  if ((yield* store.getRegistry(big)).version !== 0) throw new Error("Benchmark fixture must start empty");
  const snapshots = yield* seed(big, bigCount);
  yield* Effect.forEach(small, (account) => seed(account, smallCount), { concurrency: workers, discard: true });
  yield* sql`ANALYZE entities`;
  yield* sql`ANALYZE events`;
  yield* sql`ANALYZE facts`;
  if (mode === "refs") yield* sql`ANALYZE live_refs`;
  console.log("Measuring PATCH throughput");
  const busy = yield* patchRun(false);
  const spread = yield* patchRun(true);
  console.log("Measuring registry apply");
  const desired = { ...registry, shapes: [{ key: "bench", attributes: attributes.map(({ key }) => key) }] };
  const [apply, locks] = yield* Effect.all(
    [
      Effect.gen(function* () {
        yield* Effect.sleep("25 millis");
        const start = performance.now();
        const applied = yield* store.apply(big, "bench", desired, 1);
        if (applied.version !== 2) throw new Error("Registry apply did not advance the version");
        return performance.now() - start;
      }),
      sql<{ ms: number }>`SELECT observe_apply_lock() AS ms`,
    ],
    { concurrency: "unbounded" },
  );
  console.log("Measuring as_of latency");
  const as_of = yield* Effect.forEach(snapshots, ({ id, at, history_rows, version }) =>
    Effect.gen(function* () {
      const history = yield* store.history(big, id);
      if (history.data.length !== history_rows) throw new Error(`Wrong history length for ${id}`);
      yield* store.asOf(big, id, at);
      const samples = yield* Effect.forEach(Array.from({ length: historySamples }), () =>
        Effect.gen(function* () {
          const start = performance.now();
          const entity = yield* store.asOf(big, id, at);
          if (entity.version !== version) throw new Error(`Wrong replay version for ${id}`);
          return performance.now() - start;
        }),
      );
      return { history_rows, samples: samples.length, ...latencies(samples) };
    }),
  );
  const [pg] = yield* sql<{ version: string }>`SHOW server_version`.pipe(
    Effect.map((rows) => rows.map((r) => ({ version: Object.values(r)[0]! }))),
  );
  return {
    mode,
    measured_at: new Date().toISOString(),
    driver: "Store",
    database: "onb_data_bench",
    environment: { node: process.version, postgres: pg!.version, cpu: cpus()[0]?.model, memory_bytes: totalmem() },
    fixture: {
      large_account: big,
      large_entities: bigCount,
      small_accounts: small.length,
      entities_per_small_account: smallCount,
      attributes: attributes.length,
      initial_shape_attributes: 199,
      initial_facts_per_entity: populated.length,
      workers,
      writes_per_worker: writesPerWorker,
    },
    patch: { busy, spread },
    apply: { wall_ms: apply, exclusive_lock_ms: Number(locks[0]!.ms) },
    as_of,
  };
});

const config = { url: Redacted.make(url.href), maxConnections: workers + 2 };
const main = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Each run owns only its fixed benchmark schema in the dedicated database.
  yield* sql`DROP SCHEMA IF EXISTS ${sql(namespace)} CASCADE`;
  yield* sql`CREATE SCHEMA ${sql(namespace)}`;
  const database = PgClient.layer({
    ...config,
    startupParameters: { search_path: namespace },
    maxMessageSize: 256 * 1024 * 1024,
  });
  const result = yield* benchmark.pipe(Effect.provide(dataLayer([]).pipe(Layer.provideMerge(database))));
  const output = new URL(`./results-${mode}${bigCount === 1_000_000 && writesPerWorker === 250 ? "" : "-smoke"}.json`, import.meta.url);
  yield* Effect.tryPromise(() => writeFile(output, JSON.stringify(result, null, 2) + "\n"));
  console.log(JSON.stringify(result, null, 2));
});
NodeRuntime.runMain(main.pipe(Effect.provide(PgClient.layer(config))));
