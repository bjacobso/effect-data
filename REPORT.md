# effect-data results

Measurements and design notes below are chronological snapshots. **Pass 3**
is current for pack wiring and LOC; Pass 2's clock, typed edges, and concurrency
notes still apply unless superseded. Earlier file ranges refer to their
original snapshots.

Implemented the complete v2 registry → plan/apply → fact writes → transactional
reactions → policy evaluation → history/as_of loop. The onboarding pack supplies
the policy kind, send_form/notify operations, and evaluation route. Core has no
pack dependency or onboarding vocabulary. No files outside effect-data were
edited; effect-ts supplied platform/dependency references, not Entity modules.

## Done criteria and verification

- Node 26.13.0 through Makefile/mise; pnpm 10.20.0. All three runtime packages
  are pinned to 4.1.3. Three runtime dependencies, six development dependencies.
- Created onb_data and onb_data_test. `make deps migrate test` passes, including
  TypeScript checking and 20 tests across two suites. Repeated `make migrate`
  succeeds without changing the applied migration.
- `BASE_URL=http://localhost:8086 node conformance/data.mjs` passes 15/15
  against `make run`. The suite was not edited. The server is stopped after
  verification.
- The initial outbox paging failure was an implementation bug: selecting
  `seq::text` made `ORDER BY seq` sort the selected alias lexically. Ordering
  by `outbox.seq` fixes it. An integration regression crosses decimal digit
  boundaries and verifies no repeated/skipped rows.
- Source boundary test rejects pack imports and the specified forbidden words
  in core, and also rejects HTTP/SQL/storage imports there. A fifth test kind
  plugs into structural validation and reference checking without checker edits.

The required property coverage uses 100 generated reference registries;
12 generated operation sequences (plus guaranteed lifecycle/retract/reaction
steps); 8 generated concurrent-writer counts from 2–16; and 40
`Arbitrary.schema(revivedSchema)` samples per attribute in a seven-attribute
fixture covering all six value types. Values go through the real entity schema
and real PostgreSQL jsonb encoding/decoding. Extra cases cover NUL, lone
surrogates, Unicode length boundaries, invalid dates, finite/safe-integer
limits, and numeric/date condition decisions.

Replay is compared with both an independently maintained expected state and
an independent fold of the fact history. Every saved snapshot is reread with
as_of after subsequent writes/deletes. Separate tests verify migration history,
rollback of projection/facts/outbox on an automation unique collision, database
rejection of fact UPDATE/DELETE, restart clock seeding, projection corruption
not affecting history/as_of, registry CAS, unique races, and shared-lock
concurrency. The held-row test observes ShareLock on the account while a writer
waits for one entity; another entity's write completes before that row lock is
released. Exact HTTP 201/409 outcomes are also checked by conformance.

## Lines of code

Physical lines, including imports, blank lines, comments, and SQL template
lines; tests and migrations are counted separately. Prettier printWidth is
140. Some SQL statements occupy a long physical line, so LOC is a size measure,
not a claim about conceptual simplicity.

| Layer | File | Lines |
| --- | --- | ---: |
| Core | src/core/model.ts | 85 |
| Core | src/core/values.ts | 35 |
| Core | src/core/rules.ts | 152 |
| Core | src/core/kinds.ts | 144 |
| Core | src/core/engine.ts | 154 |
| Storage | src/storage/Store.ts | 287 |
| HTTP | src/http/handler.ts | 127 |
| Onboarding pack | src/packs/onboarding/index.ts | 65 |
| Wiring | src/composition.ts | 17 |
| Wiring | src/Config.ts | 5 |
| Wiring | src/Errors.ts | 14 |
| Wiring | src/Migrations.ts | 3 |
| Wiring | src/migrate.ts | 5 |
| Wiring | src/main.ts | 42 |
| **Total non-test src/** | | **1,135 / 1,200** |

Core: **570**. Storage: **287**. HTTP: **127**. Pack: **65**. Wiring/shared
boundary: **86**. Migration: **18** additional lines outside src/; including
it gives **1,153** production TypeScript lines. Tests: **576** lines
(core 230, fixtures 48, storage 298). The source budget has 65 lines spare.

### Cost of the fourth kind: automation

An explicit allocation of existing physical lines gives **141 lines**, of
which 139 are in src/ and two in the migration. This is an attributable
footprint, not a measured before/after diff: this implementation was built
with reactions present. Shared imports and reused schema/rule/reference/
transaction/unique-write machinery are not charged again. A mixed line is
charged in full where listed.

| Layer | Attributed work | Lines |
| --- | --- | ---: |
| Core/model | Op protocol and registry, model.ts 23–29 | 7 |
| Core/kinds | set (22–44), action decoding (46–55), reaction kind (96–127), changed-list duplicates (142) | 66 |
| Core/engine | Reaction index and its return entry (84–86) | 3 |
| Storage | Trigger selection/action execution/effects (162–192), outbox reader (272–284) | 44 |
| HTTP | Outbox route and pagination validation (65–74) | 10 |
| Pack | send_form/notify op contributions (57–63) | 7 |
| Composition | Op assembly/return entries (11, 14) | 2 |
| Migration | Outbox table/index (16–17) | 2 |
| **Total** | | **141** |

The fourth kind changes no generic checker or diff algorithm. Execution still
costs code: ordering, depth one, no-op set behavior, effects, outbox, and
transactional rollback cannot be obtained solely by declaring a document schema.

## SchemaRepresentation experience

APIs were read from the installed 4.1.3 SchemaRepresentation.ts, Schema.ts,
Arbitrary.ts, SQL, and Node runtime source. Attribute type tags produce a
representation document: String, Number, Boolean, or a Union of Literal enum
members. `fromRepresentation` revives that document. Its checks are attached,
then the complete schema is serialized with `toRepresentation`/`toJson`, read
with `fromJson`, and revived again. Thus the actual decoder and arbitrary
operate on the revived checked schema, rather than bypassing persistence for
the difficult cases.

Boolean, enum, finite number, and safe integer checks revived cleanly with
built-in revivers. Integer uses isInt, whose source specifies the safe range.
Pattern checks also have a built-in reviver. Two tiny custom filter revivers
were needed:

- `data/codePoints`: Array.from(s).length ≤ 10,000. UTF-16 length would reject
  valid astral characters. Export emits JSON Schema maxLength, which counts
  Unicode code points.
- `data/date`: anchored YYYY-MM-DD syntax plus round-trip calendar validation.
  A pattern alone accepts February 30. The pattern helps native arbitrary
  generation; the custom filter rejects nonexistent calendar dates. Export
  retains the pattern and format: date; the format fragment is declared an
  approximation because client validators may treat formats as annotations.

No custom declaration, transformed date object, or external date library was
needed. Date values remain JSON strings. Numeric condition operands deliberately
use Finite for both integer and number attributes; writes and set actions keep
the exact value schema. Valid fixed-width date strings order chronologically.
There is no string/number coercion in the typed evaluator.

Effect's standard issue formatter supplies useful paths for missing fields,
unknown properties, and value checks. A small path adapter converts arrays to
bracket notation. Structural rule and operation checks use pointer-producing
filters so unknown operator/op errors (including inherited JavaScript property names) land on those properties, without union
branch noise. Cross-document references and typed operands need explicit
semantic Issue objects; a runtime structural schema cannot resolve another
customer document by itself.

An HTTP smoke check also verified unknown shapes, invalid-calendar as_of values,
unknown null facts, and Unicode/NUL replay.

GET /v2/registry/json-schema/{shape} exports the compiled Effect facts schema,
with required keys, enum alternatives, integer bounds, string constraints,
$defs and draft identifier. Passing onExcessProperty: error is necessary to
make additionalProperties false; the default exporter follows Effect's default
of ignoring excess keys. The HTTP decoder uses the same explicit strict option.

## Static types and runtime schemas

TypeScript describes the Kind/Ref/Op protocols, Rule union, three-valued
results, Entity envelope, and Effect service/error requirements. Customer keys
and pack-supplied document kinds are runtime data. Registry/Doc and dynamic
schema maps intentionally erase document-specific static types with any;
Schema.make's service-free codec cast is localized to revived/dynamic schemas.
These casts are not proof that an arbitrary document is valid.

At the HTTP boundary, structural schemas, strict excess-property checks, and
Kind structural hooks run before document access. The pure reference and
semantic checker follows. Entity facts are checked against the compiled shape
schema, and PostgreSQL owns race-safe uniqueness. Bad combinations and missing
references are runtime issues, not compile-time TypeScript errors. This is a
smaller POC than threading a generic type parameter through every open pack,
but it relies on those boundaries and their tests.

## Facts log and transactions

Facts plus immutable transaction metadata are enough to reconstruct facts,
versions, shape, registry_version, created_at, and updated_at. Events contain
no fact snapshots. Both logs reject UPDATE/DELETE via triggers. Projections,
uniqueness entries, fact rows, event metadata, and outbox rows share the SQL
transaction. History and as_of never consult entities. Deleted entity history
and historical unique values remain available, while live uniqueness is freed.

This made migrations, retractions, historical reads, and failure rollback
straightforward. It made transaction granularity more visible: the API change
has one tx, each effective set has another, and a no-op set gets an effect
without a fact row or version increment. Deletion needs a marker even for an
entity with no facts. Outbox seq is a database sequence: gaps are allowed, and
values increase within each account even though allocation is global.

One JSON/PostgreSQL impedance mismatch is handled explicitly. jsonb cannot
represent U+0000 or lone UTF-16 surrogates, both possible JSON string values.
Fact values and unique entries therefore store canonical JSON text inside a
jsonb string; decode restores the scalar. Registry/projection/outbox documents
are serialized JSON in text columns. This preserves all permitted strings,
including enum values and labels, but gives up native scalar jsonb queries.
There are no ad hoc queries in this slice. MD5 uniqueness hashes the encoded
canonical value, using the plan's permitted index strategy.

Entity writes hold a shared account advisory transaction lock and the entity
row lock; apply holds the exclusive account advisory lock. The process-local
logical clock allocates tx and max(wall clock, previous millisecond + 1)
synchronously, seeded from committed events at startup. It neither holds an
account-wide database write lock nor requires serializable retries. Rolled-back
allocations can leave gaps. **This allocator supports one server process per
database, not concurrent replicas**; that is an explicit POC limitation.

## Layer boundary and a second pack

Core has 570 lines and the onboarding pack 65. The difficult part was keeping
policy traversal, requirement aggregation, and message payload vocabulary out
of storage/HTTP conditionals. Kinds supply references, semantic checks,
structural duplicate hooks, and rules to compile. Operation handlers return
primitive set/outbox instructions, which storage interprets transactionally.
Pack route metadata supplies the suffix/method and evaluation function; the
HTTP layer only dispatches it. The pack's policies array appears because the
pack contributes its Kind.collection, including in empty-registry responses.

A certification pack would contribute a certification_requirement kind
(collection certification_requirements) with id, shape, expiry attribute, and
renewal-window fields; its schema, shape/attribute references, date-type check,
and optional condition would use the existing Kind protocol. A renewal_due op
would validate certificate/recipient payloads and return an outbox instruction.
A certifications-due entity route would compare the selected entity's typed
expiry fact with a request date and return matching requirements. Composition
would register the pack. No checker, planner, fact writer, or shared rule
language change is needed; actual delivery remains outside this POC.

## Scale: 10k accounts × 1M entities × 1k attributes

The contract first rejects a 1,000-attribute registry: each top-level list is
capped at 500, and a shape at 200 attributes. Raising those limits alone would
not make the implementation suitable for 10 billion entities or up to 10
trillion populated attribute cells.

1. Startup scans all event metadata to seed every account's clock, and clock/
   compiled caches are unbounded by active-account count. Multiple replicas
   also cannot allocate tx safely. Route accounts to fenced single-owner
   shards with a durable allocator; restore only each shard's clock metadata,
   and bound the compiled cache. Do not replace shared entity-write locks with
   one long account counter-row transaction lock.
2. Plan/apply materializes every live entity of an account. The pure planner
   compiles the desired registry once, but checking a million wide entities,
   sorting uniqueness ownership, and rebuilding all live unique entries inside
   an exclusive account transaction is the next practical limit. Stream rows,
   precompute unique conflicts with indexed SQL, stage validation against a
   stable version, and use a resumable migration with a short final CAS/fence.
3. Each entity update rewrites its whole serialized projection and recreates
   all of that entity's unique entries. Store typed/projection columns or
   partitioned attribute cells and update only changed facts/unique slots.
   The JSON-text jsonb codec would need a queryable tagged value encoding.
4. as_of currently loads all eligible metadata and fact rows for the entity.
   Fetch the latest eligible metadata by an (account, entity, at, tx) index,
   and use fact checkpoints plus bounded replay. Partition append-only logs
   by account shard and time, with archived history and explicit retention.
5. A strictly increasing millisecond timestamp can advance ahead of wall time
   above 1,000 tx/second for one account; it is a logical clock. Keep tx as the
   ordering authority and make clock semantics explicit before increasing
   throughput. No outbox delivery or backpressure worker exists in this scope.

## Pass 2

Completed the Effect-native edges pass without changing PLAN.md, the wire
contract, dependencies, or conformance. `make deps migrate test` passes with
**28 tests across three suites**, including TypeScript checking. Repeating
`make migrate` is green. The actual HttpApi server on :8086 passes **15/15**
unchanged conformance cases. Both migrations were also applied to the test
database. The server is stopped after verification.

### Services, packs, and HTTP

Engine, KindRegistry, Store, and Clock are Context services. Their Layers have
explicit dependencies: the engine reads the registry contribution, Store
needs Engine/Clock/SqlClient, and the PostgreSQL layer supplies SQL. The
OnboardingPack Layer supplies an immutable contribution containing typed
kinds/ops, its HttpApiGroup, and its handler Layer. Handlers are built after
Store exists, so pack registration does not mutate a global registry or create
a Store/pack initialization cycle. There is no module-level app singleton.
The pure compose factory remains useful for isolated core tests.

Each Kind declares an order (attribute 10, shape 20, policy 30, automation 40).
The collector sorts that metadata. There is no positional array slicing to
insert the pack. A test shuffles the kinds and adds an earlier fifth kind.

The raw Node regex router and per-request Effect.runPromise are gone. HttpApi
owns endpoint declarations, query/payload decoding, success schemas, creation
headers, and group handler wiring. NodeHttpServer and Layer.launch own serving
and shutdown. The onboarding evaluation endpoint is declared and implemented
inside its own group. HttpApiBuilder serves generated OpenAPI at
`/v2/openapi.json`, including registry document schemas, the pack route, and
operation alternatives. This static API description is public; tenant data
endpoints retain their account middleware. Rule nodes retain a JSON-shaped
OpenAPI approximation; their existing path-producing structural filter remains
authoritative at runtime.

NotFound, Conflict(issues), and Invalid(issues) are tagged domain errors in
Store method error channels, alongside SqlError when applicable. Their service
modules contain no HTTP status/envelope mapping. The HTTP boundary alone maps
the domain tags to 404/409/422 and the existing envelope, handles schema and
malformed-JSON errors (including empty bodies), validates tenant headers, and protects route misses,
unsupported media types, defects, and body-read failures. Pagination and RFC
3339 checks keep the existing strict field/error conventions.

The 1 MiB cap uses Effect's MaxBodySize in the request context plus a fast
Content-Length check. HTTP integration tests exercise both fixed-length and
chunked oversized requests and require 413 bad_request envelopes. The compiled
registry cache is a 1,000-entry LRU keyed by account and version; a test verifies
retention after a touch and eviction after exceeding capacity.

Pack-as-Layer felt natural for supplying immutable capabilities and exposing
the group's Store dependency. It is more ceremony than a plain object: data
contributions must be available before Engine/Store, whereas the handler Layer
must be built after them. Keeping the handler Layer in the contribution gives
that sequencing without a mutable plugin registry or hidden singleton. The
small pure factory and the service wiring share the same typed declarations.

### Typed kinds and remaining any matches

Kind<S extends Schema.Top> and Op<S extends Schema.Top> now carry the supplied
schema type into every callback. defineKind/defineOp infer that type; policy,
shape, attribute, reaction, and operation implementations no longer annotate
callback documents with Doc/any. Compile-time regression cases deliberately
access an undeclared kind field and assign a string action field to number;
the expected TypeScript errors prove inference is active.

The heterogeneous collection point is `src/core/registry.ts:collect`: its two
assertions turn schema-specific kinds and ops into the uniform registry
interfaces. Generic checking/execution works on those collected interfaces.
Dynamic facts schemas still need a runtime Facts assertion, and persisted JSON
is read into its already-validated registry/entity envelope; neither turns a
kind or operation callback into an untyped implementation.

The requested `rg -c '\bany\b' src` comparison, summing matching lines:

| File | Before | After |
| --- | ---: | ---: |
| core/model.ts | 7 | 1 |
| core/values.ts | 3 | 0 |
| core/rules.ts | 12 | 6 |
| core/engine.ts | 2 | 0 |
| storage/Store.ts | 1 | 0 |
| packs/onboarding/index.ts | 5 | 0 |
| **Total matching lines** | **30** | **7** |

Counting tokens rather than matching lines gives **32 → 8**. All eight remaining
matches are the Rule language's `any` branch name or accesses to that branch.
There are **zero explicit TypeScript any types** left in src/. Unknown replaces
unvalidated JSON and open document fields; schema types replace callback any.

### Database clock and concurrency

Migration 0002 creates account_clocks and seeds it from committed event
metadata once. There is no startup event scan or process-local allocator.
Clock.reserve uses one PostgreSQL INSERT/ON CONFLICT UPDATE/RETURNING statement
to reserve a block of tx numbers and milliseconds for all effective writes in
a request. The ending millisecond is the greater of database wall time (plus
the block length minus one) and the prior account millisecond plus block
length. Every reserved tx gets its own strictly increasing ISO millisecond.
No-op PATCHes and no-op set actions reserve nothing. A rollback rolls back the
counter as well as all data; consumers do not rely on consecutive tx values.

Entity row locking, registry/facts validation, automation execution, and unique
value interning all happen before clock reservation. Effective changes are
staged as data. Once the counter row is locked, Store bulk-inserts event
metadata, bulk-inserts facts, upserts the final projections, and bulk-inserts
outbox entries, then commits. There are at most four persistence statements
between reservation and COMMIT, independent of the number of changed fields or
set actions. Registry apply stages all migration writes and stores its registry
version before this final flush. Entity writes retain the shared account
advisory lock; registry apply retains the exclusive one.

This intentionally serializes the final persistence tail for each account,
not decoding, unique checks, or waits for an unrelated entity's row. It avoids
reserving a clock block early and holding its row lock across the entire
request. Throughput for a single hot account is bounded by that short tail
and commit latency; bulk writes reduce round trips, but a large migration
still makes that tail long. More accounts can finalize independently. A
future hot-account design could use fenced allocation/ownership or a
single-statement flush; this POC does not claim lock-free account ordering.
The millisecond field remains a logical clock and can run ahead of wall time
above 1,000 effective tx/sec per account.

The new concurrency test builds **two ManagedRuntimes with separate PostgreSQL
pools**, verifies different backend PIDs, and alternates concurrent creates and
patches between their Store instances. It includes automation set transactions
and a unique-value race. It checks unique tx numbers, increasing tx and at,
matching history timestamps, and cross-instance as_of for each saved response.
The previous held-entity-row test still proves that another entity can be
written before the held row is released. The replacement-Store test now
continues the database clock instead of testing process-memory reseeding.

### Exact uniqueness and other fixes

The old unique index on a hash alone is replaced by an exact-value dictionary
and a unique live index on (account, attribute, value_id). A dictionary lookup
compares **account, attribute, hash, and the full encoded jsonb value**. A
transaction advisory lock scoped to that account/attribute/hash protects
interning of one exact value id. Its indexed hash lookup is not the entity's
uniqueness check: the real unique live index arbitrates competing entity
claims. Distinct colliding values get different ids. No long value is put in
a btree key, avoiding the PostgreSQL btree entry-size limit for valid
10,000-code-point strings.

The test-only hash override forces two distinct values into the same hash
bucket. Both creates succeed, a duplicate of the first still yields tagged
Conflict, and the dictionary contains two exact values. Normal writes compute
the hash from the encoded PostgreSQL value, including backfilled first-pass
rows. Dictionary records remain after release of live claims; eventual
compaction is a scale concern, not an entity deletion side effect.

When a document's shape is unresolved, generic checking now emits just that
shape issue and skips subordinate references and semantic checks. A regression
covers invalid facts/triggers/actions beneath missing policy and reaction
shapes. Existing reference completeness and wire error-order tests remain
unchanged in their expectations.

### LOC before/after

Both columns count physical non-test lines, including imports/comments/blanks.
The main comparison uses the repository's Prettier printWidth 140. The second
comparison actually reformats each file in memory with printWidth 100; it is
not an estimate and does not change the checked-in formatting.

| Layer | Before 140 | After 140 | Delta | Before 100 | After 100 | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Core | 570 | 605 | +35 | 657 | 736 | +79 |
| Storage/clock | 287 | 348 | +61 | 359 | 454 | +95 |
| HTTP | 127 | 333 | +206 | 157 | 439 | +282 |
| Onboarding pack | 65 | 122 | +57 | 89 | 145 | +56 |
| Wiring/shared errors | 86 | 65 | −21 | 102 | 79 | −23 |
| **Total src/** | **1,135** | **1,473** | **+338** | **1,364** | **1,853** | **+489** |

The 1,200-line source target is exceeded by **273 lines** at the checked-in
width. I kept the explicit HttpApi schemas/handlers, error boundary, typed
protocols, staged bulk writer, and exact uniqueness behavior instead of
compressing lines or dropping requirements. HttpApi/Layers saved 21 wiring
lines but increased HTTP by 206 and pack code by 57: this small POC pays for
response contracts, group/middleware declarations, generated documentation,
and explicit service wiring. It gained stronger checked boundaries and
OpenAPI, not a smaller handwritten router.

| Current file | Width 140 | Width 100 |
| --- | ---: | ---: |
| core/model.ts | 89 | 135 |
| core/values.ts | 36 | 59 |
| core/rules.ts | 170 | 184 |
| core/kinds.ts | 135 | 157 |
| core/registry.ts | 13 | 18 |
| core/engine.ts | 162 | 183 |
| storage/Clock.ts | 18 | 20 |
| storage/Store.ts | 330 | 434 |
| http/boundary.ts | 92 | 120 |
| http/schemas.ts | 27 | 35 |
| http/handler.ts | 197 | 265 |
| http/routes.ts | 17 | 19 |
| packs/onboarding/documents.ts | 72 | 85 |
| packs/onboarding/http.ts | 43 | 46 |
| packs/onboarding/index.ts | 7 | 14 |
| composition.ts | 28 | 31 |
| Config.ts | 5 | 10 |
| Errors.ts | 8 | 12 |
| Migrations.ts | 4 | 6 |
| migrate.ts | 5 | 5 |
| main.ts | 15 | 15 |

The original scale discussion still applies to materializing a million live
entities for apply, wide projection rewrites, replay length, and log storage.
Pass 2 removes the single-process clock/startup scan and unbounded compiled
cache as immediate barriers to replicas. It does not solve long account-wide
migration fences, dictionary/log retention, or aggregate data volume.

## Pass 3

The server now composes core with an ordered pack list. `PACKS` defaults to
`onboarding,certification`; selection preserves caller order, rejects unknown
or repeated names, and supports an empty list for core alone. Composition is
the only shared module naming concrete packs. Core and HTTP import no pack,
and packs import no sibling pack.

Verification:

- `make deps migrate test`: **36 tests across four suites**, including the
  existing property, replay, two-pool clock, collision, and body-limit tests.
  Repeating migrations is green; no new migration or dependency was needed.
- `data.mjs`, `PACKS=onboarding`: **15/15**.
- `data.mjs`, default PACKS: **15/15**.
- `data-certs.mjs`, default PACKS: **6/6**.
- `PACKS=not-a-pack make run`: startup fails nonzero with `Unknown pack`.
- Server stopped after final verification. No conformance file or PLAN.md was
  edited, and no file outside effect-data was edited.

### One composition path

`compose(packs)` collects operations and ordered kinds once, constructs the
engine once, and returns its pure API and a Layer providing that same engine,
KindRegistry, and Packs. `dataLayer(packs)` consumes that Layer and supplies
Store/Clock. The environment-selected DataLive uses dataLayer; the old separate
KindRegistryLive/EngineLive assembly was removed. A test compares kind order,
operation order, empty collections, and selected names through the pure and
Layer paths for zero, one, and multiple packs, including reversed pack order.

The neutral Pack protocol is `{name, kinds, ops, group?, handlers?}`.
Onboarding's old dedicated Context tag becomes a contribution value; the new
pack has the identical shape. The Packs service supplies the selected list to
HTTP, which iterates groups and handler Layers without knowing their names.
`definePack` keeps the input group's identifier tied to its typed handler
Layer, then widens that phantom identifier once for heterogeneous collection.
HttpApi still validates group implementation keys when building the router.
Kind/op erasure remains at the existing core registry collector. There are no
new explicit TypeScript any types.

All enabled collections are optional in request schemas. Normalization adds
only enabled top-level arrays, leaving optional fields inside documents alone.
Response schemas still require each enabled collection. Normalization happens
in the pure checker/planner, the registry HTTP input adapter, and Store's
registry read/apply boundary. This also supplies a newly enabled collection
when reading an older stored registry. Disabled collection names are strict
unknown-property errors. HTTP tests cover core alone, each pack individually,
and both by default, including disabled routes and OpenAPI groups.

### The allowed Ref generalization

Only registry-document references were generalized; no entity references,
queries, new instruction type, or domain-specific core behavior was added.
The domain extension itself changes **two existing core files, three lines
added and two removed (net +1)**:

| File | Exact change |
| --- | --- |
| src/core/model.ts:13 | Ref.to changes from the attribute/shape union to string: one line replaced. |
| src/core/engine.ts:55–56 | Replace the attribute/shape lookup ternary with lookup of the declared Kind by name, followed by lookup in its collection using its identity: one line replaced by two. |

The engine's other edits implement the separately requested generic optional
collection input/output contract. Attribute scope and missing-shape suppression
remain the existing primitives. The schedule_renewal op declares its kind ref
without adding a new context mode; the pack's semantic check handles the
referenced requirement's shape. Missing refs skip that semantic check, so each
bad target produces exactly one issue at requirement. Likewise the pack's
expiry type check runs only after attribute resolution and shape membership,
so an expiry error is not duplicated.

### Certification tracking

The pack contributes a typed certification_requirement kind at order 35,
a schedule_renewal op that emits the existing outbox instruction, and a typed
HttpApi group for POST /v2/entities/{id}/certifications. The kind's field order,
structural limits, shape/date references, typed applicability rule, and compiled
rule contribution are all declared locally. Sorting, reference traversal,
planning, storage, effects, and transactional outbox delivery use the existing
paths. The outbox already preserves each operation's own payload fields.

Certification evaluation filters by entity shape and sorts requirement ids by
code point. It preserves expiry/deadline fields for every status whenever the
expiry fact exists. Applicability uses the existing three-valued evaluator;
the remaining status calculation compares UTC midnights and subtracts calendar
days as UTC day intervals. Unit tests cover all six statuses, leap-year date
arithmetic, renew_by equality, expiry equality, and the day after expiry.
Conformance additionally exercises mixed operations from both packs.

The route owns its request schema and schema-error middleware. Missing body,
missing on, null body, wrong type, and invalid calendar dates yield 422 at on;
malformed JSON remains 400 and the shared request-size cap remains active.
This local adapter avoids changing the existing core endpoints' empty-body
400 behavior. Unknown/deleted entities retain 404 through Store's tagged error.

Physical certification-pack lines (including imports/comments/blanks):

| File | Width 140 | Width 100 |
| --- | ---: | ---: |
| documents.ts | 94 | 115 |
| http.ts | 62 | 92 |
| index.ts | 10 | 10 |
| **Total** | **166** | **217** |

Compared with Pass 2, total non-test src/ is **1,683** lines at the checked-in
Prettier width 140 (**+210**); width 100 gives **2,123** (**+270**), measured by
reformatting in memory. Of the 210 added physical lines, 166 are the new pack
and 44 are net shared wiring/input normalization changes. Current layers:
core 611, storage/clock 349, HTTP 337, onboarding 126, certification 166,
wiring/shared errors 94. The original 1,200-line target is exceeded by 483;
the new domain and explicit generic wiring account for the growth.

### Every file touched outside the new pack

| File | Why |
| --- | --- |
| src/Packs.ts (new) | Neutral typed contribution protocol, heterogeneous HTTP-group boundary, and Packs service/Layer. |
| src/composition.ts | Ordered environment selection and the single pure/Layer composition path; sole shared concrete-pack catalogue. |
| src/core/model.ts | Ref.to accepts any declared kind name. |
| src/core/engine.ts | Generic kind-ref lookup plus optional enabled collections and normalization in structural/pure checking and planning. |
| src/http/routes.ts | Assemble every selected group's endpoints/handler Layers through the neutral Packs service. |
| src/http/handler.ts | Normalize enabled input collections after structural validation. No domain route or payload rule was added here. |
| src/storage/Store.ts | Normalize registry reads and desired apply documents. No write, automation, clock, uniqueness, or outbox execution change. |
| src/packs/onboarding/index.ts | Replace its special service/Layer wrapper with the common contribution value and name. |
| test/core.test.ts | Name the test contribution and strengthen recursive core/HTTP/pack import and vocabulary boundaries. |
| test/certification.test.ts (new) | Kind/op checks, status/date cases, generalized references, optional/disabled collections, selection, and pure/Layer equivalence. |
| test/http.test.ts | Default-pack OpenAPI alternatives, zero/one-pack HTTP surfaces, and pack-local missing-body/date errors. |
| README.md | PACKS usage, collection semantics, common composition, certification route, and new conformance command. |
| REPORT.md | Preserve historical snapshots and record this pass. |

All other source, test, dependency, migration, and configuration files are
unchanged. The three new certification files are listed in their own LOC table
above. Boundary tests recursively reject pack imports/domain words in core and
HTTP, and resolve relative imports to reject cross-pack dependencies. The
vocabulary check uses word boundaries, so JSON Schema's format keyword and
Effect's formatter API are not mistaken for domain terms.

### What the second pack revealed

A second domain needed no new storage instruction: scheduling is another
outbox payload, and references to configuration documents belong in the
registry checker. The only domain-driven core extension was resolving a Ref
through any Kind's declared collection/identity. The generic pack list removed
an onboarding assumption from HTTP and Layer construction that the single-pack
version could not expose.

A third pack might want shared UTC date arithmetic or a reusable convention
for a required body field's error path. Both remain pack-local here; neither
justified broadening the core during this pass. Per-pack middleware already
supports different request-body conventions, and a pack can provide additional
handler-service dependencies inside its handler Layer. The main remaining
composition rough edge is the phantom HttpApi group identifier widening at a
heterogeneous boundary; each group's endpoint schemas and handlers remain
checked inside its own module.
