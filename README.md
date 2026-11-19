# effect-data

> **What this explores:** what a Clojure-style, data-first system looks like
> when built natively on [Effect](https://effect.website) v4. Everything a
> customer configures (attributes, shapes, rules, automations, domain
> documents) is JSON checked against one attribute registry; a small generic
> pipeline (schema → references → check → plan → compile → interpret) does
> the rest; facts accrete in an append-only log. Domains are **packs**
> composed on domain-free primitives: this repo ships an onboarding pack and a
> certification-tracking pack, and the second needed a one-line core change.
>
> Built by a coding agent from [PLAN.md](PLAN.md) and verified with black-box
> suites in [conformance/](conformance/). [REPORT.md](REPORT.md) records each
> pass: what worked, what it cost, and what would break first at scale.

A minimal proof of concept of "Clojure's philosophy, Effect-native": one
attribute registry, generic shapes and reactions, an append-only facts log,
and an onboarding pack supplying policies and messaging operations.

Use Node 26.13.0 (`mise install`) and pnpm. PostgreSQL must be running locally.
Create `onb_data` and `onb_data_test` once with `createdb`, then:

```sh
make deps migrate test
make run
# In another terminal:
BASE_URL=http://localhost:8086 node conformance/data.ts
```

`PORT` defaults to 8086. `DATABASE_URL` defaults to
`postgres://localhost:5432/onb_data`. Tests use `TEST_DATABASE_URL`, defaulting
to `postgres://localhost:5432/onb_data_test`; they run migrations themselves
and isolate each scenario with a fresh account. Migrations are repeatable.
`make fmt` formats source and tests; `make test` also checks TypeScript.

The v2 data routes require `X-Account-Id: acct_...`. Health and the generated
OpenAPI document at `/v2/openapi.json` are public.
`X-Actor` is optional. The contract is in [PLAN.md](PLAN.md); implementation
results, LOC accounting, schema experience, and limitations are in
[REPORT.md](REPORT.md).

`src/core/` contains pure primitives and no HTTP, SQL, or domain vocabulary.
`src/packs/` supplies typed kinds, operations, and HttpApi groups.
`src/composition.ts` selects and assembles the ordered pack list once for both
pure composition and service Layers. `src/storage/` interprets writes transactionally;
`src/http/` maps the wire contract. A source boundary test enforces the split.

Engine, KindRegistry, Store, and Clock are Context services provided by Layers.
Multiple Store instances and server replicas share PostgreSQL transaction and
timestamp allocation. Writes stage their log changes, then reserve the clock
near commit and flush in bulk. The compiled-registry cache is bounded to 1,000
entries per Store. Request bodies are capped at 1 MiB. See the Pass 2 section
of REPORT.md for the clock critical section and its throughput trade-off.

`PACKS` selects a comma-separated ordered list. The default is
`onboarding,certification`; use `PACKS=onboarding make run` for the original
surface, or `PACKS= make run` for core alone. Unknown or repeated names fail
startup. Enabled registry collections are optional on input (omitted means
`[]`) and always present on output. Disabled collections are rejected.

The certification pack adds `certification_requirements`, `schedule_renewal`,
and `POST /v2/entities/{id}/certifications` with `{ "on": "YYYY-MM-DD" }`.
With the default packs running, also verify:

```sh
BASE_URL=http://localhost:8086 node conformance/data-certs.ts
```

Ref attributes store an entity ID from the same account and declare a target
shape. Deletion blocks by default. An optional `on_delete: "clear"`
retracts the incoming fact and records it in history with reason
`reference`. Preview the live incoming edges at
`GET /v2/entities/{id}/referrers`.

```sh
BASE_URL=http://localhost:8086 node conformance/data-refs.ts
```

The Pass 4 benchmark invokes the Store directly. Create the dedicated
`onb_data_bench` database once and run the matched ref workload with:

```sh
createdb -h localhost onb_data_bench
make bench
```

Use `BENCH_DATABASE_URL` to override the connection URL. Each run recreates
its own benchmark schema in that database and writes `bench/results-refs.json`.
Run `make bench` at the baseline commit to reproduce `bench/results-baseline.json`.
`BENCH_ENTITIES` and `BENCH_WRITES` override the one-million-entity and
250-writes-per-worker defaults for a smoke run, which writes a separate result.
