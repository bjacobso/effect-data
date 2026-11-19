# effect-data specification

This is the **current contract** of the system as implemented: what a client
can rely on and what the storage guarantees. It changes in the same commit as
the behaviour it describes.

- [PLAN.md](PLAN.md) is the history of instructions given for each pass.
- [REPORT.md](REPORT.md) records measurements and lessons for each pass.
- **SPEC.md** (this file) is the contract today. When they disagree, the code
  and this file must be brought back into agreement; PLAN.md is not edited
  after its pass lands.

Status: through **Pass 5** (registry apply performance). Packs: `onboarding`,
`certification`.

## 1. Model

- An **account** is the tenant. Everything below is per account.
- An **attribute** (`namespace/name`) is the unit of meaning: a typed value
  with optional uniqueness. Attributes are global within the account.
- A **shape** names the attributes an entity may have and which are required.
- An **entity** has an id, one shape, and a set of facts (attribute → value).
- A **fact** change is an assert or retract of one attribute of one entity,
  recorded with `tx`, `at`, `reason` and `actor` in an append-only log. Current
  entity state is a projection of that log.
- The **registry** is one versioned JSON document holding every configuration
  collection. Each collection is a **kind**; packs contribute kinds,
  automation operations and routes.

## 2. Registry

### 2.1 Document

`{ attributes, shapes, automations, <pack collections…> }`, ordered by kind
order: attributes (10), shapes (20), policies (30, onboarding),
certification_requirements (35, certification), automations (40).

- Every enabled collection is optional on input (absent = `[]`) and always
  present on output. A collection of a disabled pack is an unknown property.
- Each list holds at most 500 items. Unknown properties are rejected at their
  path. Optional properties not supplied are omitted on output (no inserted
  defaults).
- Identity: attributes and shapes by `key`, every other kind by `id`.
  A duplicate identity is reported at the later occurrence
  (`attributes[2].key`, `policies[1].id`).

### 2.2 Core kinds

**Attribute**
`{ key, type, values?, label?, unique?, target?, on_delete? }`

| Field | Rule |
| --- | --- |
| `key` | `^[a-z][a-z0-9_]*/[a-z][a-z0-9_]*$` |
| `type` | `string \| integer \| number \| boolean \| date \| enum \| ref` |
| `values` | enum only, required for enum: 1–100 unique strings of 1–200 code points |
| `label` | 1–200 code points |
| `unique` | boolean; uniqueness spans live entities of every shape |
| `target` | ref only, required for ref: a shape key (a reference) |
| `on_delete` | ref only, optional: `block` (default when absent) or `clear` |

Value encoding:

| Type | Value |
| --- | --- |
| `string` | JSON string, 0–10,000 code points |
| `integer` | integer in the safe range |
| `number` | finite number |
| `boolean` | boolean |
| `date` | `"YYYY-MM-DD"`, a real calendar date |
| `enum` | one of `values` |
| `ref` | entity id `^en_[A-Za-z0-9_-]{21}$` |

**Shape** `{ key, attributes, required?, label? }`: `key` matches
`^[a-z][a-z0-9_]*$`; `attributes` 1–200 unique attribute keys; `required`
unique keys that must be in `attributes`. A `clear` ref may not be `required`
(issue at `shapes[i].required[j]`: "Required ref cannot be cleared").

**Automation** `{ id, shape, on: { changed }, when?, do }`: `id` matches
`^[a-z0-9][a-z0-9_-]{0,63}$`; `on.changed` 1–50 unique attributes of the
shape; `when` a rule; `do` 1–10 actions. Core action:
`{ op: "set", attribute, value }` where `value` must decode as the attribute
and `null` (retract) is not allowed for a required attribute.

### 2.3 Pack kinds and operations

**onboarding**
- Kind **policy** (`policies`): `{ id, name, shape, applies_when, requires }`,
  `name` 1–200 code points, `requires` 1–50 `{ form, when? }` with `form`
  matching the id pattern.
- Ops `{ op: "send_form", form }` and `{ op: "notify", message }`
  (message 1–500 code points). Both append to the outbox.

**certification**
- Kind **certification_requirement** (`certification_requirements`):
  `{ id, name, shape, expires, renew_within_days, applies_when? }`. `expires`
  must be a `date` attribute of the shape (one issue at `expires`);
  `renew_within_days` is an integer 1–365.
- Op `{ op: "schedule_renewal", requirement }`: the requirement must exist
  and have the automation's shape (one issue at `...do[j].requirement`).
  Appends to the outbox.

### 2.4 Checking

1. **Structural** (decode and duplicates). Fails plan and PUT with 422.
2. **References and typed rules** across the whole registry: every shape,
   attribute and kind reference resolves; condition facts and action
   attributes belong to the document's shape; rule operators and operands are
   typed (section 3). If a document's shape does not resolve, only that issue
   is reported for the document; an unresolved fact or attribute suppresses
   its own operator/value checks.

Issues are ordered by kind order, then index, then the kind's field order.

### 2.5 Plan and apply

- `POST /v2/registry/plan` returns `{ from_version, to_version, applicable,
  issues, changes, violations }`. `changes` are `{ kind, key, change }` with
  `added | removed | modified` (canonical JSON differs), sorted by kind order
  then key by code point.
- `violations` describe the impact of the desired registry on all live
  entities after dropping facts for attributes no longer in the shape:
  missing required,
  value no longer decodes, duplicate of a now-unique value (reported on every
  entity but the lowest id), `shape` removed, and ref values that no longer
  name a live entity of the target shape ("Dangling reference"). Sorted by
  entity id, then field.
- `PUT /v2/registry` requires `base_version`: stale → 409; issues → 422;
  violations → 409 with details `<entity_id>.<field>`; otherwise 200. Apply
  retracts facts for attributes removed from a live entity's shape, with
  reason `migration`.
- Plan and apply select entities and facts affected by registry changes for
  revalidation. Apply prepares these checks from a committed snapshot before
  taking the account's exclusive lock. Under the lock it checks the registry
  version again, updates its checks for entity writes since the snapshot,
  and commits the registry and migration together (see section 9).

## 3. Rules

The rule grammar, three-valued evaluation, typed condition checks and value
comparisons are normative in
[docs/inherited-contract.md](docs/inherited-contract.md), with these
effect-data specifics:

- `fact` is always an attribute key of the document's shape.
- Conditions on `ref` attributes allow only `equal`, `notEqual`, `in`,
  `notIn`, `exists`, `doesNotExist`; operands must be entity ids;
  `ignore_case` is not allowed. Operands are not checked for liveness. Rules
  cannot follow refs.

## 4. Entities

```json
{ "id": "en_…", "shape": "employee", "facts": { "person/email": "a@x.co" },
  "version": 1, "registry_version": 3,
  "created_at": "…Z", "updated_at": "…Z", "effects": [] }
```

- **Create** `POST /v2/entities` `{ shape, facts }` → 201 with `Location`.
  Facts must be attributes of the shape and decode; required attributes must
  be present; `null` equals absent. Unknown shape → 422 at `shape`.
- **Patch** `PATCH /v2/entities/{id}` `{ facts, expected_version? }`: `facts`
  non-empty; `null` retracts; validated against the merged result. Stale
  `expected_version` → 409. No actual change → 200, `effects: []`, nothing
  written.
- **Read** `GET /v2/entities/{id}` with optional `?as_of=<RFC 3339>`. 404 if
  the entity does not exist (or did not exist yet / was deleted at `as_of`).
- **Delete** `DELETE /v2/entities/{id}` → 204. Later reads 404; `as_of` before
  the deletion still works; its unique values are freed. See 5.3 for refs.
- **History** `GET /v2/entities/{id}/history` → `{ data: [{ tx, at,
  attribute, op, value, reason, actor }] }` ordered by tx then attribute.
  `reason` is `api | automation | migration | reference`. Readable after
  deletion.
- Unique collisions with any live entity of any shape → 409 at
  `facts.<key>`.

## 5. Refs

### 5.1 Integrity on write

On create, PATCH and automation `set`, every ref value must name a **live
entity of the attribute's target shape** in the same account; otherwise 422 at
`facts.<key>` ("Unknown reference"). A self-reference is allowed. An
automation `set` that fails this fails the whole request and rolls back its
facts, outbox items and edges.

### 5.2 Concurrency

A writer holds `FOR KEY SHARE` on each referenced target row; mutations hold
`FOR NO KEY UPDATE` on their own row; deletes hold `FOR UPDATE`. All of these
run under the shared account lock. A write and a concurrent delete of its
target therefore serialize: no dangling edge can commit. A transaction chosen
as a PostgreSQL deadlock victim is retried with bounded backoff.

### 5.3 Delete

1. If another live entity references the target through a `block` ref → 409
   with details `<referrer_id>.facts.<attribute>` ("Referenced"), sorted by
   referrer id then attribute. Nothing is written. Self-references never block.
2. Otherwise the entity is deleted, then each `clear` referrer (sorted by id)
   has the fact retracted in its own later tx with reason `reference` and actor
   `reference:<deleted_id>`.
3. Clears never trigger automations and never delete further.

### 5.4 Impact and history

- `GET /v2/entities/{id}/referrers` → `{ data: [{ entity_id, attribute,
  on_delete }] }` for live referrers, sorted by entity id then attribute; 404
  for an unknown or deleted entity.
- `as_of` returns ref values as they were, even if the target was deleted
  later.

## 6. Automations and the outbox

- After an API write's facts (on create, every asserted attribute counts as
  changed), each automation of the entity's shape **in registry order** whose
  `on.changed` intersects the changed attributes and whose `when` (absent = T)
  is **T** on the current facts runs its actions in order.
- `set` writes immediately with reason `automation` and actor
  `automation:<id>`, validated like a PATCH (including refs and uniqueness).
  Each changing `set` is its own later tx. A `set` that changes nothing writes
  no tx but is still listed in `effects`.
- Automation `set`s and reference clears never trigger automations (depth 1).
- Other ops append to the outbox in the same transaction.
- `GET /v2/outbox?after=<seq>&limit=<1..200, default 50>` → `{ data: [{ seq,
  at, entity_id, automation_id, op, …op fields }], next_after }`.
  `next_after` is the last seq returned, or `null` for an empty page.
- `effects` on create/PATCH responses lists every action executed, in order,
  with `automation_id`.

## 7. Pack routes

- `POST /v2/entities/{id}/evaluate` (onboarding) → `{ required: [form],
  undetermined: [form] }`. For each (policy, requirement) of the entity's
  shape, status = `applies_when` AND (`when` or T). A form is required if any
  status is T; undetermined if none is T and some is U. Sorted by code point.
- `POST /v2/entities/{id}/certifications` (certification), body
  `{ "on": "YYYY-MM-DD" }` → one row per requirement of the entity's shape,
  sorted by requirement: `not_applicable` (F), `undetermined` (U), `missing`,
  `expired` (`expires < on`), `due` (`on >= expires − renew_within_days`),
  otherwise `valid`. `expires` and `renew_by` are present whenever the expiry
  fact exists.

## 8. HTTP

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | public |
| GET | `/v2/openapi.json` | public, generated |
| GET | `/v2/registry` | version 0 with empty collections before first PUT |
| POST | `/v2/registry/plan` | |
| PUT | `/v2/registry` | |
| GET | `/v2/registry/json-schema/{shape}` | JSON Schema for the shape's facts |
| POST | `/v2/entities` | |
| GET / PATCH / DELETE | `/v2/entities/{id}` | |
| GET | `/v2/entities/{id}/history` | |
| GET | `/v2/entities/{id}/referrers` | |
| GET | `/v2/outbox` | |
| POST | `/v2/entities/{id}/evaluate` | onboarding pack |
| POST | `/v2/entities/{id}/certifications` | certification pack |

- Data routes require `X-Account-Id` matching `^acct_[A-Za-z0-9_-]{1,64}$`
  (otherwise 400). `X-Actor` is optional (default `anonymous`), 1–200 code
  points (otherwise 422 at `X-Actor`).
- Errors: `{ error: { code, message, details?: [{ field, issue }] } }` with
  `bad_request` 400 (malformed JSON; also 413 for bodies over 1 MiB),
  `not_found` 404, `conflict` 409, `validation_failed` 422.
- Timestamps are millisecond `…Z` strings that strictly increase per account.

## 9. Storage guarantees

- `facts` and `events` are append-only (triggers reject UPDATE and DELETE).
  `entities`, `live_unique` and `live_refs` are projections updated in the
  same transaction as the facts.
- Each account has its own `tx` sequence and logical clock; one API write is
  one tx, and each automation `set` or reference clear is a later tx in the
  same database transaction.
- Entity writes take a shared account advisory lock plus row locks; registry
  apply takes the exclusive account lock. Uniqueness is enforced by a unique
  index, not check-then-insert.
- Registry apply takes no per-value advisory locks. Its exclusive account
  lock guards changes to the live uniqueness projection.
- Known limits, measured in REPORT.md Pass 5 at 1M live entities: attaching
  an optional member held the exclusive account lock for 2.21 ms, enabling
  uniqueness for 37.47 s and retracting a populated member for 118.36 s. The
  lock blocks all writes to that account. `as_of` replays an entity's full
  history.

## 10. Composition

`PACKS` (comma-separated, ordered; default `onboarding,certification`; empty
means core only) selects packs at startup. Unknown or repeated names fail
startup. `src/core` and `src/http` import no pack, and no pack imports
another.

## 11. Not yet specified

- Queries (deferred; effect-data stays standalone from Triplex).
- Staged or online registry migration.
