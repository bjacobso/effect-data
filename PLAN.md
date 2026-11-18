# effect-data: Clojure's philosophy, Effect-native (minimal POC)

> This is the working plan given to a coding agent, kept as written across
> three passes. References to `../PLAN.md` and `../effect-ts` point into the
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
