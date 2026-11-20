# effect-data: Clojure's philosophy, Effect-native (minimal POC)

> This is the working plan given to a coding agent, kept as written across
> several passes. References to `../PLAN.md` and `../effect-ts` point into the
> exploration this started in; the parts that matter are restated in
> [docs/inherited-contract.md](docs/inherited-contract.md).

## Thesis

Everything a customer configures is **a JSON document checked against one
attribute registry**, and everything the system does with it comes from a small
**generic pipeline**: Schema → references → static check → plan → compile →
interpret. Attributes, not records, are the unit of meaning (Clojure spec /
Datomic). Facts accrete in an append-only log; current state is a projection.
Effect does the edges (HTTP, SQL transactions, services, typed errors); the core
is pure functions over data.

This is the smallest **fully working** loop that proves the idea:

    registry (attributes, shapes, policies, automations)
      → plan (issues + data violations) → apply
      → entities write facts → automations fire (same transaction)
      → policies evaluate → history / as_of from the facts log

Out of scope for this POC (named so you do not add them): refs between
entities, ad hoc queries, defaults, `many` values, the v1 slice 3 API,
durable automation delivery, auth. Keep the design able to add refs and
queries later (as two more document kinds).

## Read first

- `docs/inherited-contract.md` for the Rule grammar, three-valued semantics,
  typed condition checks and value encoding (originally "Slice 2" and
  "Slice 3" of a parent plan, referred to below as `../PLAN.md`).
- The sibling `effect-ts` implementation in the original exploration was a
  read-only reference for platform glue; it is not part of this repository.
- Effect 4.1.3 source in `node_modules/effect/src`, especially
  `SchemaRepresentation.ts` (schemas as JSON and back), `Arbitrary.ts`,
  `Schema.ts`. Learn APIs from the source, not from memory.

## Constraints

- You own `effect-data/` only. Never edit files outside it.
- Node 26.13.0 (mise), pnpm, `effect@4.1.3`, `@effect/sql-pg@4.1.3`,
  `@effect/platform-node@4.1.3`. Port **8086**, database **onb_data** (create
  it), test database **onb_data_test**.
- Hand-written SQL. No ORM.
- If anything here is ambiguous or contradicts `conformance/data.mjs`, stop
  and write `QUESTIONS.md`. Never bend code to fit a test you believe is wrong.
- **Keep SPEC.md current:** it is the system's contract as implemented.
  Every behaviour change updates it in the same commit (see AGENTS.md).
- **Line budget:** aim for at most **1,200 non-test lines** in `src/`. Report
  honestly if you exceed it and why.

## Required internal design

1. **`src/core/` is generic and has no HTTP or SQL.**
   - A `Kind` abstraction: each document kind (attribute, shape, policy,
     automation) declares its Effect Schema (structure), a function listing its
     **references** (`{path, to: "attribute" | "shape", key, context}`), and a
     kind-specific semantic check. The registry checker is generic over kinds;
     adding a fifth kind must not require touching the checker.
   - `check(registry) → Issue[]`, `plan(current, desired, liveEntities) → Plan`,
     `compile(registry) → Compiled` are pure.
   - `Compiled` holds, per shape, an entity facts decoder (a real Effect Schema
     built at runtime), compiled rule evaluators, and an index
     `attribute → automations`. Cache it by (account, registry version).
2. **Attribute schemas are data.** Build each attribute's value Schema by
   producing a `SchemaRepresentation` document (or its JSON) and reviving it
   with `fromJson`/`fromRepresentation`, if that works. If it does not fit
   (custom checks, code-point lengths, dates), say exactly where in REPORT.md and
   use the smallest workaround (custom revivers are fine).
3. **Facts are the source of truth.** `facts` is append-only (a trigger rejects
   UPDATE and DELETE). The `entities` table is a projection updated in the same
   transaction. `history` and `as_of` read only `facts` (+ entity
   creation/deletion markers).
4. **Concurrency without an account-wide write lock.** Entity writes take a
   **shared** transaction-scoped advisory lock on the account plus a row lock on
   the entity; registry apply takes the **exclusive** one. Uniqueness is a real
   unique index (e.g. on `(account_id, attribute, md5(value::text))` over live
   values) with 409 mapping, not a check-then-insert.
5. **Automations run in the write's transaction.** `set` actions write facts
   with reason `automation`; `send_form`/`notify` append to an `outbox` table.
   Automation-caused changes never trigger automations (depth 1).

## Wire contract (all under `X-Account-Id`; optional `X-Actor`, default `anonymous`)

Errors use the existing envelope `{error: {code, message, details?: [{field,
issue}]}}` with codes `bad_request` 400 (malformed JSON), `not_found` 404,
`conflict` 409 and `validation_failed` 422. `GET /healthz` → 200.

### Registry document

```json
{ "attributes": [
    { "key": "person/email", "type": "string", "unique": true },
    { "key": "employee/work_state", "type": "enum", "values": ["CA", "CO", "NY"] },
    { "key": "employee/salary", "type": "number", "label": "Salary" } ],
  "shapes": [
    { "key": "employee", "attributes": ["person/email", "employee/work_state", "employee/salary"],
      "required": ["person/email"] } ],
  "policies": [
    { "id": "colorado", "name": "Colorado withholding", "shape": "employee",
      "applies_when": { "fact": "employee/work_state", "operator": "equal", "value": "CO" },
      "requires": [ { "form": "co-dr0004" } ] } ],
  "automations": [
    { "id": "co-onboarding", "shape": "employee",
      "on": { "changed": ["employee/work_state"] },
      "when": { "fact": "employee/work_state", "operator": "equal", "value": "CO" },
      "do": [ { "op": "send_form", "form": "co-dr0004" },
              { "op": "notify", "message": "Colorado hire" },
              { "op": "set", "attribute": "employee/salary", "value": 50000 } ] } ] }
```

- **Attribute:** `key` matches `^[a-z][a-z0-9_]*/[a-z][a-z0-9_]*$`; `type` is
  `string | integer | number | boolean | date | enum` (encoding as slice 3);
  `values` (1–100 unique strings of 1–200 code points) is required for `enum`
  and forbidden otherwise; optional `label` (1–200 code points) and `unique`
  (boolean).
- **Shape:** `key` matches `^[a-z][a-z0-9_]*$`; `attributes` 1–200 unique keys;
  optional `required` (unique keys) and `label`.
- **Policy:** `id` matches `^[a-z0-9][a-z0-9_-]*$` (≤ 64); `name` 1–200 code
  points; `shape`; `applies_when` Rule; `requires` 1–50 `{form, when?}` with
  `form` matching the policy id pattern.
- **Automation:** `id` as policy id; `shape`; `on.changed` 1–50 unique
  attribute keys; optional `when` Rule; `do` 1–10 actions:
  `{op: "send_form", form}`, `{op: "notify", message (1–500 code points)}`,
  `{op: "set", attribute, value}` (`value: null` means retract).
- Rule grammar is slice 2's (`all`/`any`/`not`/condition/`true`/`false`,
  12 operators, `ignore_case`), but `fact` is an **attribute key**, never a dot
  path. Max depth 20 as in slice 2.
- Every list is ≤ 500 items. Unknown properties are rejected (422 at their path).
  An unknown `op` is reported at `...do[j].op`, an unknown rule `operator` at
  `...operator` (slice 2's convention).
- Optional properties that were not supplied are omitted in responses (no
  inserted defaults); `unique: false` round-trips as supplied.

### Two levels of checking

1. **Structural** (decode, plus duplicates): 422 on both plan and PUT.
   A duplicate attribute/shape key or policy/automation id is reported at the
   later occurrence, e.g. `attributes[2].key`, `policies[1].id`.
2. **References and typed rules** (checked across the whole registry), each an
   issue `{field, issue}`:
   - `shapes[i].attributes[j]` names no attribute;
   - `shapes[i].required[j]` is not in that shape's `attributes`;
   - `policies[i].shape` / `automations[i].shape` names no shape;
   - every condition `fact` must be an attribute **of that document's shape**
     (`policies[0].applies_when.all[1].fact`,
     `policies[0].requires[0].when.fact`, `automations[0].when.fact`);
   - typed condition rules are slice 3's query rules for scalar fields
     (operator/type compatibility at `...operator`, value type at `...value`,
     `ignore_case` at `...ignore_case`);
   - `automations[i].on.changed[j]` and `automations[i].do[j].attribute`
     must be attributes of the shape; `do[j].value` must decode as that
     attribute (at `automations[i].do[j].value`), and `null` is not allowed
     for a `required` attribute.
   - **Condition operands (decided after review):** for `integer` and
     `number` attributes, operands of `equal`, `notEqual`, `in`, `notIn` and
     the ordering operators accept **any finite number** and compare
     numerically (`level lessThan 20.5` is valid; slice 3's sentence wins over
     the exact decoder). Every other type uses the attribute's exact decoder
     (enum values must be in `values`, dates must be real dates). `set`
     action values always use the exact attribute decoder.
   - **Dates order chronologically** (`2026-01-01 lessThan 2026-02-01` is T),
     as in slice 3's queries. Slice 2's "operands must become numbers" rule
     applies only to slice 2's untyped facts; here facts are typed, so no
     string-to-number coercion ever happens.
   - When a condition's `fact` (or an action's `attribute`) does not resolve,
     report only that one issue for it; skip its operator/value checks.

   **`POST /v2/registry/plan` explains, `PUT /v2/registry` refuses:** the plan
   returns 200 with these issues and `applicable: false`; PUT returns 422
   `validation_failed` with them as `details`. Issues are ordered by document
   order (attributes, shapes, policies, automations; index order; then the
   order of fields inside each document as written above).

### Registry endpoints

- `GET /v2/registry` → `{version, attributes, shapes, policies, automations}`;
  version 0 with empty arrays before the first PUT.
- `POST /v2/registry/plan` body `{base_version?, attributes, shapes, policies,
  automations}` →
  `{from_version, to_version, applicable, issues, changes, violations}`:
  - `changes`: `[{kind, key, change}]` with `kind` in `attribute | shape |
    policy | automation`, `key` the key/id, `change` in `added | removed |
    modified` (modified = any difference in the canonical JSON). Sorted by
    kind in that order, then key by code point. No-op → `[]`.
  - `violations`: apply re-validates **every live entity** against its shape
    under the desired registry, after dropping facts for attributes no longer
    in the shape. Each failure is `{entity_id, field, issue}` with `field`
    `facts.<attribute>` (missing required, value no longer decodes, duplicate
    of a now-unique attribute — reported on every entity but the
    lowest id) or `shape` (its shape was removed). Sorted by entity_id, then
    field.
  - `applicable` = no issues and no violations. `to_version` = from + 1.
  - The plan ignores `base_version` (only PUT checks it).
- `PUT /v2/registry` body as plan with required `base_version` →
  stale base → 409 `conflict`; structural/reference issues → 422;
  violations → 409 `conflict` with `details` `[{field:
  "<entity_id>.<field>", issue}]`; otherwise 200 with the stored registry.
  Apply retracts facts for attributes removed from a live entity's shape, in
  the same transaction, with reason `migration` and actor from `X-Actor`.
- `GET /v2/registry/json-schema/{shape}` → a JSON Schema document for that
  shape's `facts` object (from Effect's schema → JSON Schema). Not in
  conformance; 404 for an unknown shape.

### Entities

```json
{ "id": "en_…21 chars", "shape": "employee",
  "facts": { "person/email": "a@x.co", "employee/work_state": "CO" },
  "version": 1, "registry_version": 3,
  "created_at": "…Z", "updated_at": "…Z",
  "effects": [ { "automation_id": "co-onboarding", "op": "send_form", "form": "co-dr0004" } ] }
```

- `POST /v2/entities` `{shape, facts}` → 201 + `Location: /v2/entities/{id}`.
  `facts` keys must be attributes of the shape (else 422 `facts.<key>`);
  values must decode (422 `facts.<key>`); every required attribute must be
  present and non-null (422 `facts.<key>`); unknown shape → 422 `shape`.
  `null` values are the same as absent. Unique attribute collisions with any
  **live entity of any shape** → 409 `conflict` at `facts.<key>`.
- `PATCH /v2/entities/{id}` `{facts, expected_version?}`: `facts` non-empty
  (422 `facts`); `null` retracts; same validation as create against the
  merged result. Stale `expected_version` → 409. If nothing actually changes,
  respond 200 with the unchanged entity, `effects: []`, no facts written.
- `GET /v2/entities/{id}` (`?as_of=<RFC 3339>` optional, invalid → 422
  `as_of`; includes every change with `at <= as_of`; timestamps are
  millisecond `…Z` strings that strictly increase per account) → entity without `effects`. 404 if it does not exist (or did not
  exist yet / was deleted at `as_of`). `registry_version` is the version
  current at the entity's last write.
- `DELETE /v2/entities/{id}` → 204; afterwards GET → 404, but `as_of`
  before the deletion still works, and its unique values are free again.
- `GET /v2/entities/{id}/history` → `{data: [{tx, at, attribute, op, value,
  reason, actor}]}` ordered by `tx` then attribute by code point. One row per
  changed attribute: `op` `assert` with the new value, or `retract` with the
  removed value. `reason` in `api | automation | migration`; automation rows
  use actor `automation:<id>`. `tx` is an integer increasing per account. The
  history of a deleted entity is still readable.
- **Transactions and `tx`:** the API write is one `tx`, and each automation
  `set` that changes something is its own later `tx`, all inside one database
  transaction. Each `tx` has its own `at` (strictly increasing per account).
  An entity's `updated_at` is the `at` of the last `tx` that changed it, and
  its `version` increments once per such `tx`. A `set` that changes nothing
  writes no `tx` but is still listed in `effects`.
- `effects` (create/PATCH responses only) lists every action executed by this
  request, in execution order, as the action object plus `automation_id`.
- `POST /v2/entities/{id}/evaluate` (no body) → `{required: [form], undetermined:
  [form]}` from policies whose `shape` is the entity's shape, sorted by code
  point. For each (policy, requirement): status = applies_when AND (when, or
  T if absent), three-valued. A form is **required** if any status is T, and
  **undetermined** if none is T and some is U.

### Automations

After an API write commits its facts (create counts every asserted attribute
as changed), for each automation of the entity's shape **in registry order**
whose `on.changed` intersects the attributes this API write changed, and
whose `when` (absent = T) is **T** on the entity's facts at that moment
(after earlier automations' `set`s): run its actions in order. `set` writes
the fact immediately (reason `automation`) and is validated like a PATCH (a
unique collision fails the whole request with 409). `send_form` and `notify`
append to the outbox. Automation `set`s never trigger automations.

- `GET /v2/outbox?after=<seq>&limit=<1..200, default 50>` →
  `{data: [{seq, at, entity_id, automation_id, op, form? | message?}],
  next_after}`; an invalid `after` or `limit` → 422 at `after`/`limit`; `seq` increases per account; `next_after` is the last seq
  returned or `null` when the page is empty.

## Tests you must write

- Unit tests for check/plan/compile over registry fixtures.
- **Property tests (fast-check / Effect Arbitrary):**
  1. For every attribute type, values from `Arbitrary.schema(<revived schema>)`
     pass the entity decoder and survive a jsonb round trip.
  2. Reference completeness: for generated valid registries, `check` returns
     no issues; deleting one random attribute produces issues at **exactly**
     the paths an independent reference enumeration predicts.
  3. Projection = fold(facts): after a random sequence of creates, patches
     (including retracts), automation-triggering writes and deletes, every
     entity's projection equals replaying its facts, and `as_of` at each
     step equals that step's state.
  4. Concurrent writers: N parallel PATCHes to different entities of one
     account all succeed (no serialization errors); two concurrent creates
     with the same unique value give exactly one 201 and one 409.
- Conformance: `BASE_URL=http://localhost:8086 node conformance/data.mjs`
  must pass every case.

## Done criteria

- `make deps migrate test` green; migrations idempotent.
- `conformance/data.mjs` all green against `make run` on :8086.
- `REPORT.md` with:
  - LOC per file and per layer (core / storage / HTTP), against the 1,200
    budget, and the cost of the fourth kind (automation) in lines across all
    layers.
  - **SchemaRepresentation experience**: what revived cleanly, what needed
    revivers or workarounds, error-path quality, JSON Schema output.
  - Where TypeScript's static types stopped and runtime schemas took over.
  - What the facts-log design made easy and what it made hard.
  - A concrete **scale** section: what in this POC would break first at 10k
    accounts × 1M entities × 1k attributes, and the change you would make.
- Final message: results against these criteria. Stop the server when done.

## Layering: primitives vs domain packs (added mid-build)

Split the code into two layers, with no change to the wire contract or to
`conformance/data.mjs`:

- **`src/core/`: primitives with no domain vocabulary.** Attributes, shapes,
  the Rule condition language, the `Kind` protocol, the generic registry
  checker, plan/apply, the facts store, compile/cache, the **op registry**
  (`op name → input Schema + handler`), and automations as generic reactions
  (trigger on changed attributes + `when` + ops). The `set` op is core.
- **`src/packs/onboarding/`: a domain pack composed from the primitives.** It
  contributes the `policy` kind, the `send_form` and `notify` ops, and the
  `POST /v2/entities/{id}/evaluate` route. A pack has one interface, roughly
  `{ kinds, ops, routes }`, and the server is `core + [onboardingPack]`.
- **Enforce the boundary:** a test fails if any file in `src/core/` imports
  from `src/packs/` or contains the words `policy`, `policies`, `form`,
  `requires` or `onboarding` (case-insensitive, comments included). The
  registry document's `policies` array is contributed by the pack's kind, not
  hard-coded in core.
- **REPORT.md** adds: lines in core vs the pack; what was awkward to keep out
  of core; and a short sketch (text only, no code) of a second pack for a
  different domain (for example, certification tracking: a `requirement` kind
  with expiry dates and a `renewal_due` op), naming exactly what it would add.

## Pass 2: Effect-native edges (after orchestrator review)

The wire contract and `conformance/data.mjs` are unchanged; all 15 cases
and existing tests must stay green. Keep the core/pack boundary test. Goal:
prove the data-first core can be fully Effect-native without losing openness.

1. **HTTP via Effect's HttpApi** (`effect/unstable/httpapi` or wherever 4.1.3
   puts it; learn from source and `../effect-ts/src/Api.ts`/`Http.ts`). No
   hand-written regex router, no per-request `Effect.runPromise`. Each pack
   contributes its own `HttpApiGroup`; the evaluate route lives in the
   onboarding pack's group. Serve the generated OpenAPI at
   `GET /v2/openapi.json` (outside conformance).
2. **Services and Layers.** `Engine` (composed kinds/ops), `Store`, `Clock`
   and a `KindRegistry` are `Context` services provided by Layers. A pack is a
   Layer that contributes kinds, ops and its HttpApi group; the server is core
   Layers + `[OnboardingPack]`. No module-level `app` singleton.
3. **Typed domain errors.** `NotFound`, `Conflict` (with issues),
   `Invalid` (with issues) as tagged errors in the error channel of the
   services that raise them. Only the HTTP edge maps them to status codes
   and the envelope; storage and core never mention HTTP status.
4. **Typed kinds.** Make `Kind` generic over its schema
   (`Kind<S extends Schema.Top>`) so `references`, `check`, `structure` and
   `rules` receive `Schema.Type<S>`, and ops likewise for their action
   schema. Erasure is allowed only at the single point where kinds are
   collected into the heterogeneous registry. Report how many `any`s remain
   (before vs after, `rg -c '\bany\b' src`).
5. **Database clock, multiple replicas.** Remove the process-local clock.
   Allocate `tx` and `at` from PostgreSQL inside the write transaction while
   keeping per-account strictly increasing `tx`/`at` and **without**
   serializing writers to different entities longer than necessary (e.g. a
   per-account counter row updated as the last statement before commit, or a
   global sequence plus a monotonic per-account rule; justify the choice).
   Add a test that runs **two Store instances (two separate pools) against
   one database** with concurrent writes and checks unique, gap-tolerant,
   increasing tx and correct history/as_of.
6. **Smaller fixes:** unique lookups compare the exact value as well as the
   hash (a forced-collision test is enough via a test-only hash override or
   by asserting the SQL); when a document's `shape` does not resolve, report
   only the shape issue (not every fact under it); kind ordering comes from
   declared order metadata, not array slicing in composition; cap request
   bodies (1 MiB → 413 `bad_request` is fine, outside conformance); bound the
   compiled-registry cache (LRU, e.g. 1,000 entries).

**REPORT.md:** add a "Pass 2" section: LOC before/after per layer (also report
counts with Prettier printWidth 100 for comparability), what HttpApi/Layers
cost or saved, remaining `any`s and why, the clock design and its throughput
trade-off, and whether a pack-as-Layer felt natural. Stop the server when done.

## Pass 3: N packs and a second domain (certification tracking)

Goal: prove a new domain is **a new pack and nothing else**. Keep all existing
tests and `conformance/data.mjs` green (it now tolerates other packs' empty
collections). The new suite is `conformance/data-certs.mjs`.

### 1. Generic pack wiring

- A pack is one value/Layer contributing `{ name, kinds, ops, group?, handlers? }`.
  The server is core + an ordered list of packs. `src/http/` and `src/core/`
  must not import any pack; `composition.ts` (or `main.ts`) is the only place
  that names packs. Remove the duplicated wiring between `compose(packs)` and
  the Layer path: one code path builds both.
- `PACKS` env var selects packs, comma-separated, default
  `onboarding,certification`. Unknown name → fail at startup.
  `conformance/data.mjs` must pass with `PACKS=onboarding` **and** with the
  default; `data-certs.mjs` with the default.
- Registry collections: every enabled kind's collection is **optional on
  input** (absent = `[]`) and **always present on output** (`GET`, `PUT`
  response). A collection of a disabled pack in the input is an unknown
  property (422 at its key).
- Boundary tests: core and http import no pack; no pack imports another pack;
  core and http contain none of `policy`, `form`, `onboarding`,
  `certification`, `renewal`, `expires` (case-insensitive).

### 2. One allowed core generalization

`Ref.to` may name **any kind** (by kind name), not just `attribute | shape`.
Resolution looks the key up in that kind's collection by its identity. Report
this change explicitly (files and lines). No other core or http change is
allowed for the certification pack; list every file touched in Pass 3 and why.

### 3. The certification pack (`src/packs/certification/`)

**Kind `certification_requirement`, collection `certification_requirements`,
order 35** (after policies, before automations):

```json
{ "id": "forklift", "name": "Forklift licence", "shape": "employee",
  "expires": "cert/forklift_expires", "renew_within_days": 30,
  "applies_when": { "fact": "employee/role", "operator": "equal", "value": "driver" } }
```

- `id`, `name`, `shape` as for policies; `expires` an attribute key;
  `renew_within_days` integer 1–365; optional `applies_when` Rule. Unknown
  properties rejected. Field order for issues: `id, name, shape, expires,
  renew_within_days, applies_when`.
- References/checks: `shape` must resolve (if not, only that issue);
  `expires` must be an attribute of the shape **and** of type `date` (one
  issue at `expires` either way); `applies_when` typed exactly like policy
  rules.

**Op `schedule_renewal`:** `{op: "schedule_renewal", requirement: <id>}`.
`requirement` must reference an existing `certification_requirement` (a kind
ref) **whose `shape` equals the automation's shape**; otherwise one issue at
`automations[i].do[j].requirement`. Handler: outbox item with
`requirement`. Outbox items expose the op's own fields alongside
`seq, at, entity_id, automation_id, op`.

**Route `POST /v2/entities/{id}/certifications`** body `{"on": "YYYY-MM-DD"}`
(a real date; otherwise 422 at `on`; missing body/field → 422 at `on`) →

```json
{ "data": [ { "requirement": "cpr", "status": "valid",
              "expires": "2027-06-01", "renew_by": "2027-04-02" } ] }
```

One row per requirement whose `shape` is the entity's shape, sorted by
`requirement` (code point). `applies_when` (absent = T), three-valued:

- F → `not_applicable`; U → `undetermined`;
- T and no expiry fact → `missing`;
- T and `expires < on` → `expired`;
- T and `on >= renew_by` → `due`, where `renew_by = expires − renew_within_days`
  calendar days (UTC);
- otherwise `valid`.

`expires` and `renew_by` are present **whenever the expiry fact exists**
(any status) and omitted otherwise. 404 for unknown/deleted entity.

### REPORT.md "Pass 3" section

Lines in the certification pack; every file touched outside it and why; the
`Ref` generalization diff size; what the second pack revealed about the
primitives (anything a third pack would want in core — e.g. date math,
per-pack routes needing request bodies); results of `data.mjs` under both
`PACKS` settings and `data-certs.mjs`.

## Pass 4: housekeeping, a baseline benchmark, and refs between entities

Goal: test the claim that a new capability is a small, generic addition, using
the hardest case so far. Every earlier kind was configuration beside the data;
a ref changes the data itself (integrity on write, behavior on delete, impact
that follows edges). Refs are honestly a **core primitive** (a new attribute
type), not a pack, so this pass has an explicit core-change budget and the
report measures against it. Keep every existing test and both conformance
suites green.

### 0. Housekeeping (land first, in its own commit)

- Convert `conformance/data.mjs` and `conformance/data-certs.mjs` to
  TypeScript programs that are **Effect end to end**: `HttpClient` for
  requests, `Schema` to decode every response body, typed errors for failed
  expectations, `Effect.gen` for each case, `NodeRuntime.runMain` as the
  entry point, run with `node`. Same cases, same assertions, same `BASE_URL`
  contract.
- Write them as an **external user of the API would, from first
  principles**: they import nothing from `src/` (still black-box) and define
  their own response schemas from the wire contract in this plan. They double
  as the example of how to consume this service with Effect, so favour
  readable, idiomatic code over clever helpers: a reader new to the
  repo should learn the API from them.
- `LICENSE` is MIT (already added).
- Update the README commands accordingly.

### 1. Baseline benchmark (before any refs code)

`bench/` holds a script that generates one account (`bench_big`) with
**200 attributes** in the registry, **199 of them** in one shape, mixed
types, and **1,000,000 entities**, plus 100 small accounts. One of the 199
is a `string` attribute `bench/link` holding the id of another entity (see
the matched workload below). It measures and writes
`bench/results-baseline.json`:

- write throughput: N concurrent PATCH workers on one busy account vs the
  same N spread over the 100 accounts (p50/p95/p99, writes/s);
- registry apply on `bench_big` that attaches the 200th attribute to the
  shape as **optional** (no retractions, but every live entity is
  revalidated): wall time and how long the exclusive account lock is held;
- `as_of` latency for entities with 10, 1,000 and 10,000 history rows.

The PATCH workload sets `bench/link` to the id of another live entity.
In the refs run, `bench/link` is declared as
`{type: "ref", target: <the shape>}` instead of `string`; everything else,
including the payloads and entity ids patched, is identical. That isolates
the cost of ref validation and edge maintenance.

Drive the Store directly or over HTTP (say which). It does not need to be
fast to generate; it must be repeatable (`make bench`). Rerun the same script
at the end of Pass 4 into `bench/results-refs.json`, so the write-path cost
of refs is a measured before/after, not a guess.

### 2. The ref attribute type

```json
{ "key": "employee/manager", "type": "ref", "target": "employee", "on_delete": "block" }
```

- `target` is a shape key and is a **reference** (`{path: "target", to:
  "shape"}`) resolved by the existing reference checker. Unknown target → one
  issue at `attributes[i].target`.
- `on_delete` is `block | clear`; absent means `block` and is omitted on
  output (no inserted defaults).
- For `ref`, `target` is **required** and `on_delete` is **optional**. Both
  are **forbidden** on every other type (checked in `structure`, like
  `values`).
- A `clear` ref that is in any shape's `required` list → one issue at
  `shapes[i].required[j]` ("Required ref cannot be cleared").
- Value encoding: an entity id string matching `^en_[A-Za-z0-9_-]{21}$`
  (the existing id format). A self-reference is allowed.
- `unique: true` on a ref is allowed (one-to-one) and uses the existing
  mechanism unchanged.
- Rules: conditions on a ref attribute allow only `equal`, `notEqual`, `in`,
  `notIn`, `exists`, `doesNotExist`; operands must match the id pattern;
  `ignore_case` is not allowed. No liveness check on operands. Paths through
  refs (`employee/manager → person/email`) are **out of scope**.
- `set` actions may set a ref; the value is checked like a PATCH.

### 3. Integrity on write

- On create, PATCH and automation `set`, every ref value must name a **live
  entity whose shape is the attribute's `target`**, in the same account.
  Otherwise 422 at `facts.<key>` with issue `"Unknown reference"` (an
  automation `set` failing this fails the whole request with 422).
- This must be race-free against a concurrent DELETE of the target: the writer
  locks each referenced target row (e.g. `FOR KEY SHARE`) inside its
  transaction; DELETE already locks the entity `FOR UPDATE`. Do not take an
  exclusive account lock for either.
- Maintain a live edge table `live_refs(account_id, entity_id, attribute,
  target_id)` with an index on `(account_id, target_id)`, updated in the write
  transaction exactly like `live_unique`. Edges are a projection; the facts log
  stays the source of truth.

### 4. Delete

`DELETE /v2/entities/{id}`, in one database transaction:

1. If any **other** live entity references it through a `block` ref →
   409 `conflict`, `details` `[{field: "<referrer_id>.facts.<attribute>",
   issue: "Referenced"}]` sorted by referrer id then attribute. Nothing is
   written. Self-references never block.
2. Otherwise delete it, then for each referrer through a `clear` ref (sorted by
   referrer id), retract that fact in its own later `tx` with reason
   **`reference`** and actor `reference:<deleted_id>`. This needs a migration
   widening the `facts.reason` check; history must show these rows.
3. Cascade retractions never trigger automations (same depth-1 rule as
   automation `set`s) and never delete anything further. There is no
   cascade-delete option.

### 5. Impact

- `GET /v2/entities/{id}/referrers` →
  `{data: [{entity_id, attribute, on_delete}]}` for live referrers, sorted by
  entity_id then attribute. 404 for an unknown or deleted entity. This is what
  a client uses to preview a delete.
- Registry plan/apply: every live ref value must still point at a live entity
  of the desired `target` shape. Changing an attribute's `type` to `ref`,
  changing `target`, or removing the target shape's entities' eligibility
  yields violations at `facts.<key>` ("Dangling reference"). Retargeting is
  allowed when no live value breaks.
- `as_of` returns ref values as they were, even if the target has since been
  deleted; history is not rewritten.

### 6. Core-change budget (measured in REPORT.md)

- Core may change only `model.ts`, `values.ts`, `kinds.ts`, `rules.ts` and
  `engine.ts`. The literal `"ref"` may appear only in `values.ts`, `kinds.ts`
  and `rules.ts`.
- `compile` gains one generic output, `edges: Map<attribute, {target,
  on_delete}>` (or equivalent), and storage consumes **only that**. Storage
  must not inspect attribute types.
- Target: **≤ 80 net lines in `src/core/`**. Exceeding it is allowed; report
  exactly where and why. That is the result we want.
- List every file touched outside `src/core/` and why, as in Pass 3.

### 7. Tests and conformance

- Unit: ref structure/reference issues (unknown target, `target` on a
  non-ref, clear+required), rule operator checks for refs.
- Property: extend property 2 (reference completeness) so generated
  registries include ref attributes and deleting a shape predicts the
  `target` issues exactly; extend property 3 (projection = fold(facts)) with
  ref writes, blocked deletes and clear cascades, and add **edges =
  fold(facts)**: `live_refs` always equals the edges recomputed from live
  projections.
- Concurrency: a create referencing X racing DELETE of X gives exactly one
  of {201 then 409 on delete, 204 then 422 on create}, never a dangling edge
  (repeat 50×).
- New black-box suite `conformance/data-refs.ts`, in the same style as the converted suites, covering at least:
  create with valid/unknown/wrong-shape/deleted target; PATCH to retarget and
  to null; self-reference; block delete with ordered details; clear delete
  with history rows and reason `reference`; clear does not fire automations;
  referrers listing; `as_of` before and after a clear; registry plan
  violations for retargeting; a `unique` ref; automation `set` of a bad ref
  failing the request.

### REPORT.md "Pass 4" section

Housekeeping results; baseline vs refs benchmark numbers side by side; core
lines changed against the budget, file by file; files touched outside core;
where refs did **not** fit the kind/attribute protocol and what a generic
primitive would have needed; results of all three conformance suites.

## Pass 5: find and fix the slowness

Goal: explain where time goes, then remove it. Pass 4 measured a registry
apply on 1,000,000 entities holding the **exclusive account lock for ~80 s**
(every write to that account blocks), plus PATCH at ~1,700-3,100 writes/s and
`as_of` growing linearly with history. Measure first; change behaviour only in
phase B. The wire contract does not change; SPEC.md is updated only where
guarantees or known limits change.

### Phase 0: bulk-insert bug fix (own commit, before phase A)

`flush` inserts all events (and facts, projections, outbox rows) in one
statement, so any write staging more rows than PostgreSQL's 65,535 bind
parameters allow fails and rolls back: today a registry apply that retracts
from more than ~7,281 entities cannot commit. Chunk every bulk insert in
`flush` below the parameter limit, inside the same transaction. This restores
the contract SPEC.md already states; it changes no semantics. Add a storage
regression test whose apply retracts an attribute from more entities than one
statement can hold (e.g. 10,000) and commits, with replay/as_of still
matching. Record it in REPORT.md as a bug found by Pass 5.

### Phase A: investigate (no behaviour changes, own commit)

Instrument and record, in REPORT.md "Pass 5 investigation", for the
`bench_big` account:

1. **Registry apply**, split into phases with wall time and SQL statement
   count each: waiting for the lock; loading and parsing live entities;
   `plan` reference/type checks; per-entity revalidation (schema decode);
   per-entity staging, uniqueness and edge work; registry write; flush. Add a
   Node CPU profile (`--cpu-prof`) of the apply and name the top frames.
2. **PATCH**: database round trips per write and time per step (account lock,
   entity read, decode, uniqueness, refs, clock reserve, inserts), single and
   under 16 workers.
3. **as_of** at 10 / 1,000 / 10,000 history rows: rows read, time in SQL vs
   replay.

Confirm or refute these hypotheses from reading the code, with evidence:

- **H1:** apply calls `unique()` for **every** live entity even when nothing
  about it changed, which issues at least one `DELETE` round trip per entity
  (1M statements) even with no unique attributes; changed entities pay it
  twice (`stage` and the apply loop).
- **H2:** `plan` decodes every live entity through Effect Schema in-process,
  and that decode is a large CPU share.
- **H3:** loading all live documents into memory is a material time and
  memory cost (report peak RSS).
- **H4:** all of the above runs inside the exclusive lock in one transaction,
  so lock time is roughly total apply time.

Add two apply scenarios to `make bench` alongside the existing one
(attach an optional attribute): **remove a populated attribute** from the
shape (1M migration retractions), and **make an attribute unique** whose
values are already distinct. For every scenario also measure **PATCH p50/p99
for writes to the same account issued while the apply runs**: that is the
user-visible cost of the lock.

### Phase B: fix, in this order, measuring after each step

Rerun the bench after each step and record a row per step per scenario.

1. **Skip no-op work.** An entity whose retained facts, unique slots and
   edges do not change under the desired registry writes nothing: no
   `live_unique` churn, no edge work, no event. Fix the double `unique()`.
   Also drop the per-value advisory locks inside registry apply: the
   exclusive account lock already excludes every writer, and holding one lock
   per distinct value until commit exhausts PostgreSQL's shared lock memory
   (make-unique failed at 30,000 entities in phase A). Phase A records that
   failure as the make-unique baseline; do not raise PostgreSQL's lock limits
   to work around it. Add a regression test that makes an attribute unique
   across more entities than the default lock table holds and commits.
2. **Classify changes before revalidating.** Compute from the registry diff
   which entities can possibly violate the desired registry. Changes that
   cannot (adding an attribute, adding an optional attribute to a shape,
   labels, adding or editing policies, automations and other non-attribute
   kinds) skip per-entity revalidation entirely. Revalidate only the shapes
   and attributes affected by: new required members, type or `values`
   changes, becoming unique, ref target or `on_delete` changes, attributes
   leaving a shape, and removed shapes. Use indexed SQL where it is exact
   (e.g. "any live entity lacks attribute X", "duplicate values of X") instead
   of loading documents.
   - **Differential property test (required):** for generated registry pairs
     and live entities, the classified plan's `violations` equal the
     full-revalidation plan's, always.
3. **Shorten the lock for expensive changes.** When revalidation or
   retractions are needed, do the scanning and validation in batches **before**
   taking the exclusive lock, against a recorded tx position. Under the
   exclusive lock, recheck only entities written after that position, then
   write. If the retraction writes themselves still hold the lock for long,
   report the number and stop there: fully online migration is a later pass.

Targets (report against them; missing one is allowed with an explanation):
attach-optional apply holds the exclusive lock **< 100 ms** at 1M entities;
make-unique **< 5 s**; remove-populated reports its lock time honestly.

### Phase C: PATCH and as_of (only if cheap)

From phase A's numbers, fix the largest single PATCH cost if it does not
change semantics (e.g. collapsing round trips). Do not change `as_of`
storage in this pass; record the recommended change (checkpoints or an
`(account, entity, tx)` latest-value read) with its expected effect.

### Constraints for this pass

- Plan/apply semantics, issues, violations and ordering are unchanged; every
  existing test and conformance suite stays green.
- Core changes are allowed in `plan` (classification is pure and belongs in
  core); keep storage free of attribute-type knowledge, as in Pass 4.
- Update SPEC.md section 9's known limits with the new measured numbers.

### REPORT.md "Pass 5" section

The investigation table and verdict on H1-H4; per-step before/after numbers
for all three apply scenarios and the concurrent-PATCH impact; lines changed
by layer; what remains slow and what the next change would be.

## Pass 6: soft removal and background rollout

Goal: no registry apply holds the exclusive account lock for longer than it
takes to write the registry. Pass 5 left two slow applies at 1M entities:
making an attribute unique (37 s lock) and removing a populated attribute
(118 s lock). Both stay slow for as long as apply rewrites existing data
inside one transaction, so this pass changes the contract instead:

- **Removing an attribute is a soft delete.** Apply writes no facts. Reads
  hide the values; they come back if the attribute is added back.
- **Making an attribute unique rolls out in the background.** Apply returns at
  once. New writes are enforced immediately; existing duplicates become
  **violation records** that people can list, act on and fix.
- Today's all-or-nothing behaviour stays available as `mode: "strict"`.

This is a wire-contract change. SPEC.md changes in the same commits as the
code (sections 2.2, 2.5, 4, 5, 6, 8, 9 and 11 at least). Branch:
`pass-6-rollout`.

### 0. Registry history (own commit, first)

`registries` keeps only the current document. Add `registry_versions
(account_id, version, document, at)` written on every apply in the same
transaction, and backfill the current row for existing accounts. Needed for
`as_of` in section 1. No behaviour change in this commit.

### 1. Soft removal

- **Visibility.** An entity's visible facts are the stored facts whose
  attribute is in its shape under the registry being read against. Entity
  reads, rules, automations, pack routes (`evaluate`, `certifications`),
  `plan`, uniqueness and ref checks all use visible facts only.
- **Apply writes no facts.** Removing an attribute from a shape, or retiring
  it (below), only writes the registry. The stored projection keeps the hidden
  values, so projection still equals replay of the log (keep the existing
  property test green). New applies never write reason `migration`; the value
  stays valid in old logs.
- **Re-adding restores.** Putting the attribute back in the shape makes the
  hidden values visible again, for every entity, without writes.
- **Writes.** PATCH and create validate against visible facts. A hidden
  attribute is not in the shape, so writing it is 422 as today. A write never
  drops or changes hidden values.
- **`as_of`** filters by the registry version in effect at that time (from
  `registry_versions`). For a time before an account's earliest
  `registry_versions` row (the section 0 backfill), return the unfiltered
  replay, exactly as Pass 5 does: before this pass every removal retracted
  facts physically, so there is nothing to hide. **History** is the log as written; a removal adds no
  rows.
- **Retirement.** Attribute gains `retired?: true`. Once an attribute has
  been in an applied registry it can't be dropped from the document: omitting
  it is a 422 issue at `attributes` ("Attribute cannot be removed; set
  retired") naming the key. A retired attribute may not appear in any shape,
  rule or action (normal reference checks report it). Its definition is
  frozen while retired, and un-retiring (dropping `retired`) must keep the
  definition unchanged in that same apply; it can change in a later apply.
  This stops a key being reused with a different type over hidden values.
- **Refs of hidden facts.** `live_refs` stays a projection of the **stored**
  ref facts, hidden or not: soft removal never deletes its rows and re-adding
  never has to restore them. Every read of it (delete blocking, `clear`,
  `/referrers`) filters by the compiled registry's edges, so a hidden ref
  never blocks a delete, is never cleared and is not listed, and a re-added
  ref's `block`/`clear` takes effect the moment the apply commits. Precisely,
  `live_refs` holds the stored facts (hidden or visible) of attributes whose
  **current** type is `ref`. An apply that changes an attribute's type to or
  from `ref` therefore adds or removes those rows before commit, under the
  lock, as Pass 5 already does; this includes an attribute converted to `ref`
  while hidden or in the same apply that re-adds it. Type changes stay a
  locked, synchronous cost; record that in REPORT.md. Storage
  stays free of type knowledge. Rows may point at targets deleted while the
  ref was hidden; re-adding such a ref is what yields `dangling_reference`.
- **Uniqueness of hidden facts.** Hidden unique values release their slots:
  in rollout mode through the job (section 2), not under the lock; in strict
  mode before commit. In rollout mode, until the job reaches an entity, its
  hidden unique value can still collide with a new write (409); record that in
  SPEC section 9 as a known limit.

### 2. Background rollout

- **Mode.** `PUT /v2/registry` accepts `mode?: "rollout" | "strict"`,
  default `rollout`. `plan` reports the same violations as today and gains
  `mode` in its input to say which of them would block.
- **What rolls out.** Only two violation kinds become records instead of
  blocking: `duplicate` (becoming unique, or un-hiding values that are now
  duplicates) and `dangling_reference` (un-hiding a ref whose target is gone
  or has the wrong shape). Every other violation (missing required, value no
  longer decodes, shape removed with live entities, ref target or `on_delete`
  changes that dangle existing refs) blocks with 409 in both modes, exactly as
  today, using the Pass 5 classified preflight.
- **Strict mode** is today's apply for duplicates and dangling refs: 409 if
  any exist, otherwise **all** slot work for the change is done before commit:
  releasing slots of values that become hidden first, then claiming slots for
  values that become visible or unique. Strict mode starts no rollout. So a
  strict apply that hides `x` in one shape and re-adds it in another moves the
  slot atomically, and its preflight only looks at the desired visible data.
  Soft removal (no fact writes) applies in both modes.
- **Rollout mode** defers all slot work to the job, which does every release
  for the rollout before any claim.
- **Apply in rollout mode** writes the registry and a `rollouts` row
  `(account_id, registry_version, status running|done|superseded, cursor,
  processed, total, started_at, finished_at)` and commits. Target: exclusive
  lock under 100 ms at 1M entities for both make-unique and remove-populated.
- **The job** reconciles affected entities to the current registry: unique
  slots, `live_refs` rows and violation records, nothing else. It runs as an
  Effect fiber in the server process, in batches (start at 1,000 entities by
  id) each in its own transaction under the **shared** account lock, so
  entity writes keep going. It is idempotent per entity and resumes from
  `cursor` after a restart. Only one instance works an account's rollout
  (claim with `FOR UPDATE SKIP LOCKED` or a session advisory lock; your call,
  justify it in REPORT.md). A later apply marks the running rollout
  `superseded` and starts a new one against the new registry; the new one
  must cover whatever the old one hadn't reached (simplest: the union of both
  affected sets).
- **Writes during a rollout** follow the new registry immediately. A write
  that sets a newly unique attribute must claim the slot; if an entity the job
  hasn't reached holds the same value without a slot, the writer still wins
  and the job later records that entity as the duplicate.
- **Duplicates.** The slot holder is whoever holds the slot; among entities
  the job reconciles in one batch, the lowest id wins. Every other live entity
  with that visible value gets a `duplicate` violation.

### 3. Violation records

- Table `violations (account_id, id, entity_id, attribute, issue, value,
  status open|resolved, registry_version, opened_tx, opened_at, resolved_tx,
  resolved_at)`. At most one open record per (entity, attribute, issue): a
  unique ref can be both `duplicate` and `dangling_reference`, and gets both
  records.
- **Opened** by the rollout job (and by nothing else in this pass).
- **Resolved** in the same transaction as whatever fixes it: the entity's
  value changes or is retracted, the entity is deleted, the attribute stops
  being unique or leaves the shape (resolved by the next rollout), the ref
  target becomes valid, or the slot holder gives the value up. When a slot is
  released and open duplicates for that value remain, the lowest-id one takes
  the slot and its record resolves.
- **Writes to an entity with an open violation** succeed if they don't make
  things worse. Keeping a duplicate value unchanged while patching other
  facts is allowed; setting a new duplicate value is 409 as usual.
- **Outbox.** Opening and resolving each append an outbox item with
  `automation_id: null`, `op: "violation_opened" | "violation_resolved"`,
  `violation_id`, `attribute`, `issue`.
- **HTTP.** `GET /v2/violations?status=open|resolved&attribute=&after=&limit=`
  paged like the outbox. `GET /v2/registry` gains `rollout: { version,
  status, processed, total } | null`. Entity reads gain `violations: [{
  attribute, issue }]` listing open records.

### 4. Tests and conformance

- **New black-box suite `conformance/data-rollout.ts`** (Effect, no `src/`
  imports, same style as the others). Cases: make unique over duplicates in
  rollout mode returns 200 and duplicates appear as records once the rollout
  is done (poll `GET /v2/registry`); a new duplicate write is 409 during and
  after; fixing a duplicate resolves its record and the outbox shows both
  events; strict mode returns 409 as before; remove an attribute from a shape
  → reads hide it, history unchanged, re-add → values back; dropping an
  attribute key is 422; changing a retired definition is 422; hide a ref,
  delete its target (not blocked), re-add → `dangling_reference` record;
  missing-required still 409 in rollout mode.
- **Update existing suites** only where this pass changes the contract (for
  example a case expecting 409 for duplicates on make-unique now sends
  `mode: "strict"`); say which cases changed in REPORT.md.
- **Differential property test (storage).** After random entity writes, random
  registry changes in rollout mode and the job running to completion with
  writes interleaved between batches (and some applies superseding a running
  rollout), check against a from-scratch computation over the visible facts:
  - `live_refs` equals the stored ref facts of live entities;
    `dangling_reference` records equal the from-scratch set;
  - for each unique attribute and visible value among live entities, exactly
    one entity holds the slot and every other one has an open `duplicate`
    record; no entity both holds the slot and has the record; there are no
    slots or open records for hidden, deleted or no-longer-unique facts.
  **Which** entity holds a slot is not compared: incumbents keep their slots,
  so it depends on write order. A failed write is simply not replayed.
- **Restart test:** stop the job mid-rollout, start a new Store, it finishes
  from `cursor` with the same result.
- **Supersede test:** a second apply during a rollout leaves a final state
  that satisfies the same invariants as the property test for the latest
  registry.
- Keep every existing test and suite green.

### 5. Benchmark

Rerun the three Pass 5 apply scenarios at 1M in rollout mode and record,
per scenario: exclusive lock time (target < 100 ms for all three), rollout
duration and entities/s, same-account PATCH p50/p99 during the rollout
(target p99 < 100 ms), and for make-unique the number of violation records
(seed some duplicates so it's non-zero). Also rerun make-unique in strict
mode on a separate duplicate-free attribute (strict mode rejects the seeded
one), to show the locked slot writes still match Pass 5.

### Constraints for this pass

- Storage stays free of attribute-type knowledge; violation kinds and
  visibility come from core (`compile()` output), not `"ref"` checks in
  storage.
- Do not change PostgreSQL configuration.
- Commits: section 0, then soft removal, then rollout and violations, then
  bench and report. Each behaviour commit updates SPEC.md.
- If a decision here turns out wrong or contradictory, write QUESTIONS.md and
  stop rather than guess.

### REPORT.md "Pass 6" section

Lock times and rollout numbers against the targets; which conformance cases
changed and why; lines changed by layer; open limits (hidden unique values
holding slots until the rollout reaches them, storage kept by hidden values,
no purge).

## Deferred: queries (formerly planned as Pass 5)

Goal: a query is **another document kind** checked by the existing reference
and typed-rule machinery, compiled to SQL with the inherited three-valued
semantics intact. Decide storage first; the kind protocol is judged
separately from the storage change.

### 1. Storage decision (do this first, report it separately)

Today `facts.value` is jsonb holding a JSON **string** of canonical JSON (to
preserve NUL and lone surrogates), and `entities.document` is text. Neither is
queryable by type. Add a live typed projection maintained in the write
transaction like `live_unique`:

    cells(account_id, entity_id, shape, attribute,
          s text COLLATE "C", n numeric, b boolean, d date)

one row per present live fact, exactly one typed column set (`enum`, `string`
and `ref` use `s`; `integer`/`number` use `n`). An absent fact is an absent
row. Index `(account_id, attribute, s|n|b|d, entity_id)` per column. Strings
containing NUL cannot live in `text`: either reject NUL in string attributes
from now on (registry-level decision, report it) or store such cells with a
flag and evaluate them in memory. Say which and why. Facts and history are
unchanged.

### 2. The query kind (core)

```json
{ "id": "co-drivers", "shape": "employee",
  "where": { "all": [ { "fact": "employee/work_state", "operator": "equal", "value": "CO" },
                      { "fact": "employee/role", "operator": "equal", "value": "driver" } ] },
  "order_by": [ { "attribute": "employee/salary", "direction": "desc" } ] }
```

Collection `queries`, order 45. `where` is a Rule checked exactly like policy
rules; `order_by` (0–3 items) attributes must be in the shape and not `ref`.
Field order: `id, shape, where, order_by`.

### 3. Running

- `POST /v2/queries/{id}/run` and `POST /v2/query` (an inline query document,
  checked with the same kind checks; issues → 422) take
  `{limit?: 1..200 (50), after?: <cursor>, match?: "true" | "unknown"}` and
  return `{data: [entity], next_after}`. `match: "true"` returns entities
  where `where` is T; `"unknown"` returns those where it is U. F never.
- Order: `order_by` then entity id; absent values sort last in either
  direction. Keyset cursor, opaque string.
- Live data only. `as_of` queries are out of scope.

### 4. Compiling rules to SQL

One compiler `rule → SQL boolean expression` where SQL `NULL` is U:
SQL's `AND`/`OR`/`NOT` over `NULL` match the inherited `all`/`any`/`not`
tables; empty `all` → `TRUE`, empty `any` → `FALSE`; a condition on an absent
cell → `NULL` except `exists`/`doesNotExist`. Specify exactly how
`ignore_case` lowercases (Postgres `lower` vs JS `toLowerCase` differ outside
ASCII) and make the in-memory evaluator agree.

**Differential property test (the core of this pass):** for generated
registries, entities and rules, the SQL result (T/F/U per entity, via
`match`) equals the existing in-memory evaluator on every entity. Include
absent facts, `in`/`notIn` with absent facts, `ignore_case` on non-ASCII,
numeric boundaries, dates, and depth-20 rules.

### 5. Core-change budget

The query kind lives in core (it is generic). The SQL compiler lives in
`src/storage/` and consumes rules plus compiled attribute metadata only.
Target **≤ 60 net lines** of change in existing core files (new files for the
kind are counted separately). Report every overrun.

### REPORT.md "Pass 5" section

The storage decision and its cost; kind-protocol fit, file by file; the
differential test's case count and anything it found; query latency on the
benchmark data with and without the cell indexes (add to `make bench`);
results of all conformance suites including a new `conformance/data-queries.ts`.

## Pass 7: queries

Goal: list entities by their facts. A query is a registry kind checked by the
existing reference and typed-rule machinery, compiled to SQL with the
inherited three-valued semantics intact. This section replaces "Deferred:
queries" above; where they differ, this section wins. Branch:
`pass-7-queries`. New routes and a new kind are wire-contract additions, so
SPEC.md changes in the same commits (sections 2, 3, 8, 9 and 11 at least).

### 0. Storage decision (own commit, first; report it separately)

`facts.value` is jsonb holding a JSON string of canonical JSON, and
`entities.document` is text, so neither can be queried by type. Add a typed
projection maintained in the write transaction, like `live_unique`:

    cells(account_id, entity_id, shape, attribute,
          s text COLLATE "C", n numeric, b boolean, d date)

- One row per **stored** fact of a live entity, hidden or visible, with exactly
  one typed column set, chosen by the attribute's **current** type (`string`,
  `enum` and `ref` use `s`; `integer` and `number` use `n`). An absent fact is
  an absent row. Deleting an entity removes its rows.
- **Why hidden facts stay:** a query names a shape and may only use attributes
  of that shape (section 1), so hidden facts are never queried. Soft removal
  and restore (Pass 6) then need no cell writes at all.
- **Type changes** rebuild that attribute's cells before commit, under the
  exclusive lock, exactly as Pass 6 does for type changes to or from `ref`.
  Pass 6 already guarantees that restored values decode under the new type.
- Index `(account_id, attribute, <typed column>, entity_id)` per typed column.
  Measure whether `shape` belongs in the index too and justify the choice.
- **NUL in strings:** `text` cannot hold NUL. Either reject NUL in string
  values from now on (a contract change: say what happens to existing stored
  values), or store those cells flagged and evaluate them in memory. Choose,
  justify, and put the rule in SPEC.md.
- Backfill cells for existing data in the migration. Facts, history and
  `as_of` are unchanged.
- Measure the write cost: PATCH writes/s for one account and across 100
  accounts, before and after cells. Target: no more than 15% slower.

### 1. The query kind (core)

```json
{ "id": "co-drivers", "shape": "employee",
  "where": { "all": [ { "fact": "employee/work_state", "operator": "equal", "value": "CO" },
                      { "fact": "employee/role", "operator": "equal", "value": "driver" } ] },
  "order_by": [ { "attribute": "employee/salary", "direction": "desc" } ] }
```

- Collection `queries`, kind order 45, identity `id` (the usual id pattern).
  Field order: `id, shape, where, order_by`. `where` is optional (absent = T).
- `where` is a rule checked exactly like policy rules: facts must be
  attributes of the shape, and operators and values are typed.
- `order_by` has 0–3 items, each `{ attribute, direction: "asc" | "desc" }`,
  attributes in the shape, unique, not `ref`, not `boolean`.
- Retired attributes and attributes not in the shape are reported by the
  normal reference checks, so registry checking keeps every stored query
  valid against the current registry.
- The kind is generic: it lives in core, beside attributes, shapes and
  automations, not in a pack.

### 2. Running

- `POST /v2/queries/{id}/run` runs a stored query. `POST /v2/query` runs an
  inline query document checked with the same kind checks against the current
  registry (issues → 422 at `query.<path>`). Both take `{ limit?: 1..200
  (default 50), after?: <cursor>, match?: "true" | "unknown" (default
  "true") }` and return `{ data: [entity], next_after }`.
- `match: "true"` returns entities where `where` is T; `"unknown"` returns
  those where it is U. F is never returned.
- Each entity is the same document `GET /v2/entities/{id}` returns, including
  open `violations` and with hidden facts left out.
- Order: `order_by`, then entity id ascending. Absent values sort last in
  either direction. Comparison is by the typed column (code point order for
  strings, `COLLATE "C"`). The cursor is an opaque keyset string; a cursor
  from a different query, registry version or `match` is a 400.
- Live data only; `as_of` queries are out of scope. A page reads one snapshot,
  but pages are not consistent with each other: say so in SPEC.md.
- Unknown query id → 404.

### 3. Compiling rules to SQL

One compiler, `rule → SQL boolean expression`, in `src/storage/`, where SQL
`NULL` is U. It consumes the rule plus compiled attribute metadata (which typed
column, and `ignore_case` support) from core; storage stays free of
attribute-type knowledge beyond what `compile()` hands it.

- SQL `AND`, `OR` and `NOT` over `NULL` match the inherited `all`, `any` and
  `not` tables. Empty `all` → `TRUE`, empty `any` → `FALSE`.
- A condition on an absent cell → `NULL`, except `exists` and
  `doesNotExist`. Check `in` and `notIn` on absent facts carefully.
- `ignore_case`: the in-memory evaluator uses JS `toLowerCase()`, and Postgres
  `lower()` differs outside ASCII. Define one rule, make both sides agree, and
  put it in SPEC section 3. If you change the in-memory behaviour, that is a
  contract change: record it in SPEC.md and REPORT.md.
- Every condition must be able to use the cell indexes for selective
  queries; check the plans with `EXPLAIN` on the benchmark data.

**Differential property test (the core of this pass):** for generated
registries, entities and rules, the SQL verdict (T, F or U per entity,
obtained through `match`) equals the in-memory evaluator on every entity.
Include absent facts, `in`/`notIn` with absent facts, `ignore_case` on
non-ASCII strings, numeric and safe-integer boundaries, dates, depth-20 rules,
hidden facts (removed from the shape after being written), and a type change
followed by a query. At least 200 cases.

Also test ordering and paging: walking every page with random `limit`s
returns each matching entity exactly once, in the order the in-memory sort
gives.

### 4. Conformance

New black-box suite `conformance/data-queries.ts` (Effect, no `src/`
imports): store and run a query; inline queries; `match: "unknown"`; ordering
with absent values in both directions; paging to the end; cursor misuse →
400; registry checks on the query kind (unknown fact, wrong operator type,
`order_by` on a ref, retired attribute); a hidden attribute disappearing from
results and its values returning on restore; results carrying open
violations. Keep every existing suite green.

### 5. Benchmark

On the 1M-entity account, record p50/p95 for: a selective equality query
(about 0.1% match), a range query with `order_by` and `limit 50`, an `any` of
two conditions, a `not`, `match: "unknown"`, and a deep page (the 200th page
by cursor). Report each with and without the cell indexes, plus the `EXPLAIN`
plan of the selective query. Target: selective query p95 under 50 ms. Also
record the PATCH throughput before and after cells (target in section 0), and
how long the cells backfill took.

### Constraints for this pass

- Core changes go in new files where possible. Report net lines changed in
  existing core files and why (aim: 60 or fewer).
- Do not change PostgreSQL configuration.
- Commits: section 0, then the kind and running together with the compiler,
  then benchmark and report. Each behaviour commit updates SPEC.md.
- Stop for QUESTIONS.md only on a genuine contradiction that no reasonable
  reading resolves. For smaller gaps, choose the option most consistent with
  the plan, implement it and record the choice in REPORT.md.

### REPORT.md "Pass 7" section

The storage decision and its cost (backfill time, write throughput, table and
index size at 1M); the NUL and `ignore_case` decisions; how the query kind fit
the kind protocol, file by file; the differential test's case count and
anything it found; query latencies against the targets; conformance results;
lines changed by layer.
