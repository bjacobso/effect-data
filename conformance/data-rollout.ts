import { Effect } from "effect";
import {
  Empty,
  Entity,
  History,
  Mutation,
  Outbox,
  Plan,
  Registry,
  Violations,
  check,
  eqJ,
  expectError,
  newAccount,
  req,
  same,
  suite,
} from "./client.ts";

const { test, run } = suite();
const value = "item/value";
const keep = "item/keep";
const link = "item/link";
const registry = {
  attributes: [
    { key: value, type: "string" },
    { key: keep, type: "string" },
  ],
  shapes: [{ key: "item", attributes: [value, keep] }],
};
const put = (account: string, base_version: number, doc: object) =>
  req(Registry, "PUT", "/v2/registry", { account, body: { base_version, ...doc } });
const state = (account: string) => req(Registry, "GET", "/v2/registry", { account }).pipe(Effect.flatMap((r) => r.body));
const create = (account: string, facts: object, shape = "item") =>
  req(Mutation, "POST", "/v2/entities", { account, body: { shape, facts } });
const patch = (account: string, id: string, facts: object) => req(Mutation, "PATCH", `/v2/entities/${id}`, { account, body: { facts } });
const entity = (account: string, id: string, at?: string) =>
  req(Entity, "GET", `/v2/entities/${id}${at ? `?as_of=${encodeURIComponent(at)}` : ""}`, { account }).pipe(Effect.flatMap((r) => r.body));
const history = (account: string, id: string) =>
  req(History, "GET", `/v2/entities/${id}/history`, { account }).pipe(Effect.flatMap((r) => r.body));
const list = (account: string, query: string) =>
  req(Violations, "GET", `/v2/violations?${query}`, { account }).pipe(Effect.flatMap((r) => r.body));
const wait = Effect.fnUntraced(function* (account: string, version: number) {
  for (let i = 0; i < 400; i++) {
    const rollout = (yield* state(account)).rollout;
    if (rollout?.version === version && rollout.status === "done") return rollout;
    yield* Effect.sleep("25 millis");
  }
  yield* check(false, `rollout ${version} did not finish`);
});

test(
  "duplicates roll out, writes enforce slots, promotion and repairs resolve records",
  Effect.gen(function* () {
    const a = newAccount(),
      desired = { ...registry, attributes: [{ key: value, type: "string", unique: true }, registry.attributes[1]] };
    yield* (yield* put(a, 0, registry)).body;
    const duplicates = yield* Effect.forEach(Array.from({ length: 3 }), () =>
      create(a, { [value]: "shared" }).pipe(Effect.flatMap((r) => r.body)),
    );
    const strict = yield* req(Plan, "POST", "/v2/registry/plan", { account: a, body: { ...desired, mode: "strict" } });
    const deferred = yield* req(Plan, "POST", "/v2/registry/plan", { account: a, body: desired });
    yield* eqJ((yield* strict.body).applicable, false, "strict plan blocks");
    const plan = yield* deferred.body;
    yield* eqJ(plan.applicable, true, "rollout plan applies");
    yield* eqJ(
      plan.violations.map((v) => v.blocking),
      [false, false],
      "duplicate details are deferred",
    );
    yield* expectError(yield* put(a, 1, { ...desired, mode: "strict" }), 409, "conflict", "strict apply blocks");
    // Keep several thousand rows ahead of the worker so the HTTP requests
    // exercise uniqueness while batches are still committing.
    yield* Effect.forEach(Array.from({ length: 3_000 }), () => create(a, {}).pipe(Effect.flatMap((r) => r.body)), {
      concurrency: 16,
      discard: true,
    });
    yield* (yield* put(a, 1, desired)).body;
    const progress = (yield* state(a)).rollout;
    yield* eqJ(progress?.status, "running", "apply returned while rollout was running");
    yield* (yield* create(a, { [value]: "fresh" })).body;
    yield* expectError(yield* create(a, { [value]: "fresh" }), 409, "conflict", "new duplicate during rollout");
    yield* wait(a, 2);
    yield* expectError(yield* create(a, { [value]: "shared" }), 409, "conflict", "duplicate after rollout");
    const key = encodeURIComponent(value);
    const first = yield* list(a, `status=open&attribute=${key}&limit=1`);
    const second = yield* list(a, `status=open&attribute=${key}&after=${first.next_after}&limit=1`);
    const found = [...first.data, ...second.data];
    const ids = duplicates.map(({ id }) => id).sort();
    yield* eqJ(found.map((v) => v.entity_id).sort(), ids.slice(1), "lowest id holds slot and both losers are paged");
    yield* same((yield* entity(a, ids[1]!)).violations, [{ attribute: value, issue: "duplicate" }], "entity exposes duplicate");
    yield* (yield* patch(a, ids[1]!, { [keep]: "unrelated" })).body;
    yield* (yield* patch(a, ids[0]!, { [value]: null })).body;
    yield* eqJ((yield* entity(a, ids[1]!)).violations, [], "lowest open duplicate promoted");
    yield* (yield* patch(a, ids[2]!, { [value]: "different" })).body;
    yield* eqJ((yield* list(a, "status=open")).data, [], "all violations resolved");
    const resolved = yield* list(a, "status=resolved");
    yield* eqJ(resolved.data.length, 2, "resolved history remains");
    yield* check(
      resolved.data.every((v) => v.resolved_tx !== null && v.resolved_tx > v.opened_tx),
      "resolution has a later tx",
    );
    const outbox = yield* (yield* req(Outbox, "GET", "/v2/outbox", { account: a })).body;
    for (const v of found)
      yield* eqJ(
        outbox.data.filter((event) => event.violation_id === v.id && event.automation_id === null).map((event) => event.op),
        ["violation_opened", "violation_resolved"],
        "outbox records both state transitions",
      );
  }),
);

test(
  "membership hides and restores facts, retirement freezes the definition",
  Effect.gen(function* () {
    const a = newAccount();
    yield* (yield* put(a, 0, registry)).body;
    const source = yield* (yield* create(a, { [value]: "stored" })).body;
    const hidden = { ...registry, shapes: [{ key: "item", attributes: [keep] }] };
    yield* expectError(yield* put(a, 1, { ...hidden, attributes: [registry.attributes[1]] }), 422, "validation_failed", "cannot drop key");
    const retired = { ...hidden, attributes: [{ ...registry.attributes[0], retired: true }, registry.attributes[1]] };
    yield* (yield* put(a, 1, retired)).body;
    yield* eqJ((yield* entity(a, source.id)).facts, {}, "hidden in live reads");
    yield* same((yield* entity(a, source.id, source.updated_at)).facts, { [value]: "stored" }, "visible before removal");
    yield* expectError(yield* patch(a, source.id, { [value]: "changed" }), 422, "validation_failed", "cannot write hidden value");
    yield* expectError(
      yield* put(a, 2, { ...retired, attributes: [{ ...retired.attributes[0], label: "changed" }, registry.attributes[1]] }),
      422,
      "validation_failed",
      "retired definition frozen",
    );
    yield* (yield* put(a, 2, registry)).body;
    yield* same((yield* entity(a, source.id)).facts, { [value]: "stored" }, "value is restored");
    yield* eqJ((yield* history(a, source.id)).data.length, 1, "apply added no facts");
  }),
);

test(
  "a hidden ref allows deletion, then restoration opens a violation",
  Effect.gen(function* () {
    const a = newAccount();
    const refs = {
      attributes: [...registry.attributes, { key: link, type: "ref", target: "item" }],
      shapes: [{ key: "item", attributes: [value, keep, link] }],
    };
    yield* (yield* put(a, 0, refs)).body;
    const target = yield* (yield* create(a, {})).body;
    const source = yield* (yield* create(a, { [link]: target.id })).body;
    yield* (yield* put(a, 1, { ...refs, shapes: registry.shapes })).body;
    yield* eqJ((yield* req(Empty, "DELETE", `/v2/entities/${target.id}`, { account: a })).status, 204, "hidden ref never blocks");
    yield* expectError(yield* put(a, 2, { ...refs, mode: "strict" }), 409, "conflict", "strict refuses dangling ref");
    yield* (yield* put(a, 2, refs)).body;
    yield* wait(a, 3);
    yield* same((yield* entity(a, source.id)).violations, [{ attribute: link, issue: "dangling_reference" }], "reintroduced ref dangles");
    yield* (yield* patch(a, source.id, { [keep]: "unrelated" })).body;
    yield* (yield* patch(a, source.id, { [link]: null })).body;
    yield* eqJ(
      (yield* list(a, "status=resolved")).data.map((v) => v.issue),
      ["dangling_reference"],
      "retraction repairs the ref",
    );
    yield* expectError(
      yield* put(a, 3, { ...refs, shapes: [{ ...refs.shapes[0], required: [value] }] }),
      409,
      "conflict",
      "missing required value still blocks a rollout",
    );
  }),
);

run();
