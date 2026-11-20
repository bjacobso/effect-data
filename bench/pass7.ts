import { writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { dataLayer, type compose } from "../src/composition.ts";
import { type Registry } from "../src/core/model.ts";
import type { Query } from "../src/core/queryKind.ts";
import { migrate } from "../src/Migrations.ts";
import { makeStore, Store, type StoreValue } from "../src/storage/Store.ts";
import { pageStatement, type QueryOptions } from "../src/storage/queryPage.ts";

const baselineDir = process.env.BENCH_BASELINE_DIR;
if (!baselineDir) throw new Error("Set BENCH_BASELINE_DIR to a checkout of Pass 6 with dependencies available");
const baselineUrl = (file: string) => pathToFileURL(resolve(baselineDir, file)).href;
const { compose: composeBaseline } = (await import(baselineUrl("src/composition.ts"))) as { compose: typeof compose };
const { migrate: migrateBaseline } = (await import(baselineUrl("src/Migrations.ts"))) as { migrate: typeof migrate };
const { makeStore: makeBaselineStore } = (await import(baselineUrl("src/storage/Store.ts"))) as {
  makeStore: () => Effect.Effect<
    Pick<StoreValue, "mutate">,
    Effect.Error<ReturnType<typeof makeStore>>,
    Effect.Services<ReturnType<typeof makeStore>>
  >;
};

const url = new URL(process.env.BENCH_DATABASE_URL ?? "postgres://localhost:5432/onb_data_bench");
const count = Number(process.env.BENCH_ENTITIES ?? 1_000_000);
const writes = Number(process.env.BENCH_WRITES ?? 250);
const samples = Number(process.env.BENCH_QUERY_SAMPLES ?? 30);
const workers = 16;
const depth = 200;
const namespace = "effect_data_bench_pass7";
const output = new URL(
  `./results-pass7-current${count === 1_000_000 && samples === 30 && writes === 250 ? "" : "-smoke"}.json`,
  import.meta.url,
);
if (
  url.pathname !== "/onb_data_bench" ||
  !Number.isSafeInteger(count) ||
  count < workers ||
  !Number.isSafeInteger(writes) ||
  writes < 1 ||
  !Number.isSafeInteger(samples) ||
  samples < 1
)
  throw new Error("Use onb_data_bench, at least 16 entities, and positive write and query sample counts");
const big = "bench_q";
const small = Array.from({ length: 100 }, (_, i) => `bench_q_${i}`);
const entityId = (n: number) => `en_${String(n).padStart(21, "0")}`;
const epoch = "2024-01-01T00:00:00.000Z";
const sequence = "q/sequence",
  group = "q/group",
  label = "q/label",
  edited = "q/edited";
const attributes: Registry["attributes"] = [
  { key: sequence, type: "integer" },
  { key: group, type: "integer" },
  { key: label, type: "string" },
  { key: edited, type: "integer" },
];
const registry: Registry = {
  attributes,
  shapes: [{ key: "item", attributes: attributes.map(({ key }) => key) }],
  automations: [],
};

const seed = Effect.fnUntraced(function* (account: string, total: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO registries(account_id,version,document) VALUES (${account},1,${JSON.stringify(registry)})`;
  for (let start = 1; start <= total; start += 10_000) {
    const end = Math.min(total, start + 9_999);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        INSERT INTO events(account_id,entity_id,tx,at,kind,shape,version,registry_version,created_at)
        SELECT ${account}, 'en_' || lpad(n::text,21,'0'), n, t.at, 'create', 'item', 1, 1, t.at
        FROM generate_series(${start}::integer,${end}::integer) AS n
        CROSS JOIN LATERAL (SELECT to_char((${epoch}::timestamptz AT TIME ZONE 'UTC') + n * interval '1 millisecond',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at) t`;
        yield* sql`
        INSERT INTO entities(account_id,id,document)
        SELECT account_id, entity_id, jsonb_build_object(
          'id',entity_id,'shape',shape,'version',version,'registry_version',registry_version,'created_at',at,'updated_at',at,
          'facts',jsonb_build_object('q/sequence',tx,'q/group',tx % 1000)
            || CASE WHEN tx % 100 = 0 THEN jsonb_build_object('q/label','Label ' || tx::text) ELSE '{}'::jsonb END
        )::text FROM events WHERE account_id=${account} AND tx BETWEEN ${start} AND ${end}`;
        yield* sql`
        INSERT INTO facts(account_id,entity_id,tx,at,attribute,op,value,reason,actor)
        SELECT e.account_id,e.entity_id,e.tx,e.at,f.key,'assert',to_jsonb(f.value::text),'api','bench'
        FROM events e JOIN entities p ON p.account_id=e.account_id AND p.id=e.entity_id
        CROSS JOIN LATERAL jsonb_each(p.document::jsonb->'facts') f
        WHERE e.account_id=${account} AND e.tx BETWEEN ${start} AND ${end}`;
      }),
    );
    if (account === big && (end === total || end % 100_000 === 0)) console.log(`Seeded ${end}/${total} entities`);
  }
  yield* sql`INSERT INTO account_clocks(account_id,tx,at_ms) VALUES (${account},${total},${Date.parse(epoch) + total})`;
  yield* sql`INSERT INTO registry_versions(account_id,version,document,at)
    VALUES (${account},1,${JSON.stringify(registry)},${epoch})`;
});

const percent = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
const latency = (values: number[]) => ({ p50_ms: percent(values, 0.5), p95_ms: percent(values, 0.95), samples: values.length });

let editSequence = Date.now() * 1000;
const patch = (store: Pick<StoreValue, "mutate">, accounts: readonly string[]) =>
  Effect.gen(function* () {
    const perWorker = writes;
    const start = performance.now();
    yield* Effect.forEach(
      Array.from({ length: workers }, (_, i) => i),
      (worker) =>
        Effect.gen(function* () {
          for (let i = 0; i < perWorker; i++) {
            const ordinal = worker * perWorker + i;
            const account = accounts[ordinal % accounts.length]!;
            yield* store.mutate(account, "bench", { facts: { [edited]: ++editSequence } }, entityId(worker + 1));
          }
        }),
      { concurrency: workers, discard: true },
    );
    return (workers * perWorker * 1000) / (performance.now() - start);
  });

const patchRates = (store: Pick<StoreValue, "mutate">) =>
  Effect.gen(function* () {
    const rates: Record<string, { writes_per_second: number; runs: number[] }> = {};
    for (const [name, accounts] of [
      ["one_account", [big]],
      ["across_100_accounts", small],
    ] as const) {
      yield* patch(store, accounts);
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(yield* patch(store, accounts));
      rates[name] = { writes_per_second: percent(runs, 0.5), runs };
    }
    return rates;
  });

const equal = { fact: group, operator: "equal", value: 7 };
const query = (id: string, where?: Query["where"], order_by: Query["order_by"] = []): Query => ({
  id,
  shape: "item",
  order_by,
  ...(where !== undefined && { where }),
});
const work: [Query, QueryOptions][] = [
  [query("equality", equal), {}],
  [
    query("range", { fact: sequence, operator: "greaterThanInclusive", value: Math.floor(count / 2) }, [
      { attribute: sequence, direction: "asc" },
    ]),
    {},
  ],
  [query("any", { any: [equal, { ...equal, value: 17 }] }), {}],
  [query("not", { not: { fact: sequence, operator: "lessThanInclusive", value: count - Math.max(1, count / 1000) } }), {}],
  [query("unknown", { fact: label, operator: "equal", value: "missing" }), { match: "unknown" }],
];
const deep = query("deep");

const time = (store: StoreValue, q: Query, options: QueryOptions) =>
  Effect.gen(function* () {
    for (let i = 0; i < 3; i++) yield* store.runQuery(big, q, options);
    const times = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      const result = yield* store.runQuery(big, q, options);
      if (count >= 100_000 && result.data.length !== 50) throw new Error(`Unexpected page size in ${q.id}`);
      times.push(performance.now() - start);
    }
    const result = latency(times);
    console.log(q.id, result);
    return result;
  });

const runQueries = (store: StoreValue, deepAfter: string) =>
  Effect.gen(function* () {
    const results: Record<string, ReturnType<typeof latency>> = {};
    for (const [q, options] of [...work, [deep, deepAfter ? { after: deepAfter } : {}] as const])
      results[q.id] = yield* time(store, q, options);
    return results;
  });

const benchmark = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store;
  const previous = yield* makeBaselineStore().pipe(Effect.provide(composeBaseline([]).layer));
  yield* migrateBaseline;
  yield* seed(big, count);
  yield* Effect.forEach(small, (account) => seed(account, workers), { concurrency: workers, discard: true });
  for (const table of ["entities", "events", "facts"]) yield* sql`ANALYZE ${sql(table)}`;
  console.log("Measuring Pass 6 PATCH throughput");
  const before = yield* patchRates(previous);
  console.log(before);
  const start = performance.now();
  yield* migrate;
  const backfill_ms = performance.now() - start;
  console.log({ backfill_ms });
  yield* sql`ANALYZE cells`;
  console.log("Measuring Pass 7 PATCH throughput");
  const after = yield* patchRates(store);
  console.log(after);
  const [pg] = yield* sql<{ server_version: string }>`SHOW server_version`;
  const sizes = yield* sql<{ relation: string; bytes: string }>`
    SELECT 'cells heap and TOAST' AS relation,pg_table_size('cells')::text AS bytes
    UNION ALL
    SELECT indexrelid::regclass::text,pg_relation_size(indexrelid)::text FROM pg_index WHERE indrelid='cells'::regclass`;
  const [cells] = yield* sql<{ count: string }>`SELECT count(*)::text AS count FROM cells WHERE account_id=${big}`;
  const current = yield* store.getRegistry(big);
  const config = store.compiled(big, current.version, current.registry);
  const explain = (q: Query, options: QueryOptions = {}) => {
    const planned = pageStatement(sql, big, q, config, 51, options.match ?? "true");
    return sql<{ "QUERY PLAN": string }>`EXPLAIN (ANALYZE, BUFFERS) ${planned}`.pipe(
      Effect.map((rows) => rows.map((row) => row["QUERY PLAN"]).join("\n")),
    );
  };
  let cursor = "";
  const pageNumber = Math.min(depth, Math.max(1, Math.ceil(count / 50)));
  for (let i = 1; i < pageNumber; i++) {
    const p: Effect.Success<ReturnType<StoreValue["runQuery"]>> = yield* store.runQuery(big, deep, cursor ? { after: cursor } : {});
    cursor = p.next_after!;
    if (!cursor) throw new Error("Benchmark fixture ended before the deep page");
  }
  console.log("Queries with secondary cell indexes");
  const indexed = yield* runQueries(store, cursor);
  const indexedPlans = { equality: yield* explain(work[0]![0]), range: yield* explain(work[1]![0]), not: yield* explain(work[3]![0]) };

  const createNumeric = (
    shape: boolean,
  ) => sql`CREATE INDEX cells_n ON cells(account_id,attribute,${shape ? sql`shape,` : sql``}n,entity_id)
    WHERE n IS NOT NULL AND octet_length(attribute)<=768`;
  yield* sql`DROP INDEX cells_n`;
  yield* createNumeric(true);
  const [shapeSize] = yield* sql<{ bytes: string }>`SELECT pg_relation_size('cells_n')::text AS bytes`;
  console.log("Testing shape in the numeric index");
  const with_shape = {
    indexed_bytes: Number(shapeSize?.bytes),
    equality: yield* time(store, work[0]![0], {}),
    explain: yield* explain(work[0]![0]),
  };
  yield* sql`DROP INDEX cells_n,cells_s,cells_folded,cells_b,cells_d,cells_attribute,cells_exceptional`;

  console.log("Queries with the cell primary key only");
  const unindexed = yield* runQueries(store, cursor);
  const unindexedPlans = { equality: yield* explain(work[0]![0]), range: yield* explain(work[1]![0]), not: yield* explain(work[3]![0]) };
  return {
    measured_at: new Date().toISOString(),
    node: process.version,
    postgres: pg!.server_version,
    cpu: cpus()[0]?.model,
    memory_bytes: totalmem(),
    fixture: { count, cells: Number(cells?.count), workers, writes, small_accounts: small.length, page_size: 50, deep_page: pageNumber },
    backfill_ms,
    sizes: Object.fromEntries(sizes.map(({ relation, bytes }) => [relation, Number(bytes)])),
    patch: { before, after },
    queries: { indexed, unindexed, indexed_plans: indexedPlans, unindexed_plans: unindexedPlans, with_shape },
  };
});

const pg = { url: Redacted.make(url.href), maxConnections: workers + 2 };
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // This fixed schema in the dedicated benchmark database belongs to this script.
  yield* sql`DROP SCHEMA IF EXISTS ${sql(namespace)} CASCADE`;
  yield* sql`CREATE SCHEMA ${sql(namespace)}`;
  const layer = dataLayer([]).pipe(Layer.provideMerge(PgClient.layer({ ...pg, startupParameters: { search_path: namespace } })));
  const result = yield* benchmark.pipe(Effect.provide(layer));
  yield* Effect.promise(() => writeFile(output, JSON.stringify(result, null, 2) + "\n"));
  console.log(`Results written to ${output.pathname}`);
  yield* sql`DROP SCHEMA ${sql(namespace)} CASCADE`;
});

NodeRuntime.runMain(setup.pipe(Effect.provide(PgClient.layer(pg))));
