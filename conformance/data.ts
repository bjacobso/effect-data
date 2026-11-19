#!/usr/bin/env node
// effect-data POC black-box conformance suite (attribute registry, facts, automations).
// Usage: BASE_URL=http://localhost:8086 node conformance/data.ts [--filter text]
// Fresh random account per case. Contract: ../PLAN.md.

import { Effect } from "effect";
import {
  req,
  suite,
  newAccount,
  eqJ,
  same,
  check,
  expectError,
  fieldsOf,
  expectField,
  canon,
  Registry,
  Plan,
  Entity,
  Mutation,
  History,
  Outbox,
  Evaluate,
  Health,
  Empty,
} from "./client.ts";

const ID_RE = /^en_[A-Za-z0-9_-]{21}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------- fixtures ----------------
const ATTRS: { key: string; type: string; unique?: boolean; values?: string[]; label?: string }[] = [
  { key: "person/email", type: "string", unique: true },
  { key: "person/nickname", type: "string" },
  { key: "employee/work_state", type: "enum", values: ["CA", "CO", "NY"] },
  { key: "employee/salary", type: "number", label: "Salary" },
  { key: "employee/start_date", type: "date" },
  { key: "employee/remote", type: "boolean", unique: false },
  { key: "employee/level", type: "integer" },
];
const EMPLOYEE = {
  key: "employee",
  label: "Employee",
  attributes: [
    "person/email",
    "person/nickname",
    "employee/work_state",
    "employee/salary",
    "employee/start_date",
    "employee/remote",
    "employee/level",
  ],
  required: ["person/email"],
};
const CONTRACTOR = { key: "contractor", attributes: ["person/email", "person/nickname"] };
const C = (fact: string, operator: string, value?: unknown, extra = {}) => ({
  fact,
  operator,
  ...(value === undefined ? {} : { value }),
  ...extra,
});
const POLICIES = [
  {
    id: "colorado",
    name: "Colorado withholding",
    shape: "employee",
    applies_when: C("employee/work_state", "equal", "CO"),
    requires: [{ form: "co-dr0004" }, { form: "w-4" }],
  },
  {
    id: "high-earner",
    name: "Non-solicit",
    shape: "employee",
    applies_when: C("employee/salary", "greaterThanInclusive", 100000),
    requires: [{ form: "non-solicit" }],
  },
  {
    id: "remote",
    name: "Remote kit",
    shape: "employee",
    applies_when: true,
    requires: [
      { form: "remote-kit", when: C("employee/remote", "equal", true) },
      { form: "office-badge", when: { not: C("employee/remote", "equal", true) } },
    ],
  },
];
const AUTOMATIONS = [
  {
    id: "co-onboarding",
    shape: "employee",
    on: { changed: ["employee/work_state"] },
    when: C("employee/work_state", "equal", "CO"),
    do: [
      { op: "send_form", form: "co-dr0004" },
      { op: "notify", message: "Colorado hire" },
      { op: "set", attribute: "employee/salary", value: 50000 },
    ],
  },
  { id: "salary-watch", shape: "employee", on: { changed: ["employee/salary"] }, do: [{ op: "notify", message: "salary changed" }] },
];
const REGISTRY = { attributes: ATTRS, shapes: [EMPLOYEE, CONTRACTOR], policies: POLICIES, automations: AUTOMATIONS };

// Other enabled packs may add collections; they must be empty arrays here and are otherwise ignored.
const CORE_KEYS = ["version", "attributes", "shapes", "policies", "automations"];
const known = Effect.fnUntraced(function* (doc: typeof Registry.Type, ctx: string) {
  for (const [k, v] of Object.entries(doc ?? {}))
    if (!CORE_KEYS.includes(k)) yield* check(Array.isArray(v) && v.length === 0, `${ctx}: extra collection ${k} must be []`, v);
  return Object.fromEntries(Object.entries(doc ?? {}).filter(([k]) => CORE_KEYS.includes(k)));
});
const getReg = (account: string) => req(Registry, "GET", "/v2/registry", { account });
const plan = (account: string, doc: object, base_version?: number) =>
  req(Plan, "POST", "/v2/registry/plan", { account, body: { ...(base_version === undefined ? {} : { base_version }), ...doc } });
const put = (account: string, base_version: number, doc: object, actor?: string) =>
  req(Registry, "PUT", "/v2/registry", { account, body: { base_version, ...doc }, actor });
const putOk = Effect.fnUntraced(function* (account: string, base: number, doc: object, actor?: string) {
  const r = yield* put(account, base, doc, actor);
  yield* eqJ(r.status, 200, `PUT registry (${r.text.slice(0, 500)})`);
  return yield* r.body;
});
const create = (account: string, shape: string, facts: object, actor?: string) =>
  req(Mutation, "POST", "/v2/entities", { account, body: { shape, facts }, actor });
const createOk = Effect.fnUntraced(function* (account: string, shape: string, facts: object, actor?: string) {
  const r = yield* create(account, shape, facts, actor);
  yield* eqJ(r.status, 201, `create ${shape} (${r.text.slice(0, 500)})`);
  return yield* r.body;
});
const patch = (account: string, id: string, facts: object, expected_version?: number, actor?: string) =>
  req(Mutation, "PATCH", `/v2/entities/${id}`, {
    account,
    body: { facts, ...(expected_version === undefined ? {} : { expected_version }) },
    actor,
  });
const patchOk = Effect.fnUntraced(function* (account: string, id: string, facts: object, ev?: number, actor?: string) {
  const r = yield* patch(account, id, facts, ev, actor);
  yield* eqJ(r.status, 200, `patch (${r.text.slice(0, 500)})`);
  return yield* r.body;
});
const effectsOf = (e: typeof Mutation.Type) =>
  e.effects.map(({ automation_id, op, form, message, attribute, value }) => ({
    automation_id,
    op,
    ...(form !== undefined ? { form } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(attribute !== undefined ? { attribute } : {}),
    ...(value !== undefined ? { value } : {}),
  }));

// ---------------- cases ----------------
const { test, run } = suite();

test(
  "health and empty registry",
  Effect.gen(function* () {
    const h = yield* req(Health, "GET", "/healthz", { account: null });
    yield* eqJ(h.status, 200, "healthz");
    const a = newAccount();
    const r = yield* getReg(a);
    yield* eqJ(r.status, 200, "GET empty registry");
    yield* same(
      yield* known(yield* r.body, "empty"),
      { version: 0, attributes: [], shapes: [], policies: [], automations: [] },
      "empty registry",
    );
  }),
);

test(
  "registry: put, round-trip, no inserted defaults",
  Effect.gen(function* () {
    const a = newAccount();
    const r = yield* putOk(a, 0, REGISTRY, "ada");
    yield* eqJ(r.version, 1, "version after first PUT");
    yield* same({ ...(yield* known(r, "PUT")), version: undefined }, { ...REGISTRY, version: undefined }, "PUT response round-trips");
    const g = yield* getReg(a);
    yield* same(yield* known(yield* g.body, "GET"), { version: 1, ...REGISTRY }, "GET round-trips exactly");
    const again = yield* putOk(a, 1, REGISTRY);
    yield* eqJ(again.version, 2, "every successful PUT increments version");
  }),
);

test(
  "registry: structural 422 on both plan and PUT",
  Effect.gen(function* () {
    const a = newAccount();
    const bad: [object, string][] = [
      [{ ...REGISTRY, attributes: [{ key: "Email", type: "string" }, ...ATTRS] }, "attributes[0].key"],
      [{ ...REGISTRY, attributes: [{ key: "x/state", type: "enum" }, ...ATTRS] }, "attributes[0].values"],
      [{ ...REGISTRY, attributes: [{ key: "x/n", type: "number", values: ["a"] }, ...ATTRS] }, "attributes[0].values"],
      [{ ...REGISTRY, attributes: [{ key: "x/n", type: "decimal" }, ...ATTRS] }, "attributes[0].type"],
      [{ ...REGISTRY, attributes: [{ key: "x/n", type: "string", colour: "red" }, ...ATTRS] }, "attributes[0].colour"],
      [{ ...REGISTRY, attributes: [...ATTRS, { key: "person/email", type: "string" }] }, `attributes[${ATTRS.length}].key`],
      [{ ...REGISTRY, shapes: [EMPLOYEE, { ...CONTRACTOR, key: "employee" }] }, "shapes[1].key"],
      [{ ...REGISTRY, policies: [POLICIES[0], { ...POLICIES[1], id: "colorado" }] }, "policies[1].id"],
      [{ ...REGISTRY, automations: [{ ...AUTOMATIONS[0], do: [{ op: "launch", form: "x" }] }] }, "automations[0].do[0].op"],
      [
        { ...REGISTRY, policies: [{ ...POLICIES[0], applies_when: C("employee/work_state", "equals", "CO") }] },
        "policies[0].applies_when.operator",
      ],
    ];
    for (const [doc, field] of bad) {
      yield* expectField(yield* expectError(yield* plan(a, doc), 422, "validation_failed", `plan ${field}`), field, `plan ${field}`);
      yield* expectField(yield* expectError(yield* put(a, 0, doc), 422, "validation_failed", `PUT ${field}`), field, `PUT ${field}`);
    }
    const m = yield* req(Registry, "PUT", "/v2/registry", { account: a, raw: "{nope" });
    yield* expectError(m, 400, "bad_request", "malformed JSON");
    yield* eqJ((yield* (yield* getReg(a)).body).version, 0, "nothing stored");
  }),
);

test(
  "registry: reference issues — plan explains (200), PUT refuses (422), document order",
  Effect.gen(function* () {
    const a = newAccount();
    const doc = {
      attributes: ATTRS,
      shapes: [
        {
          key: "employee",
          attributes: ["person/email", "employee/ghost", "employee/work_state", "employee/salary"],
          required: ["employee/remote"],
        },
      ],
      policies: [
        { id: "p0", name: "unknown fact", shape: "employee", applies_when: C("person/nickname", "exists"), requires: [{ form: "f" }] },
        {
          id: "p1",
          name: "typed",
          shape: "employee",
          applies_when: C("employee/work_state", "lessThan", "CO"),
          requires: [{ form: "f", when: C("person/email", "equal", 5) }],
        },
        { id: "p2", name: "no shape", shape: "manager", applies_when: true, requires: [{ form: "f" }] },
      ],
      automations: [
        {
          id: "a0",
          shape: "employee",
          on: { changed: ["employee/level"] },
          do: [
            { op: "set", attribute: "employee/salary", value: "lots" },
            { op: "set", attribute: "employee/work_state", value: "TX" },
          ],
        },
      ],
    };
    const expected = [
      "shapes[0].attributes[1]",
      "shapes[0].required[0]",
      "policies[0].applies_when.fact",
      "policies[1].applies_when.operator",
      "policies[1].requires[0].when.value",
      "policies[2].shape",
      "automations[0].on.changed[0]",
      "automations[0].do[0].value",
      "automations[0].do[1].value",
    ];
    const p = yield* plan(a, doc);
    yield* eqJ(p.status, 200, `plan status (${p.text.slice(0, 300)})`);
    yield* eqJ((yield* p.body).applicable, false, "not applicable");
    yield* eqJ((yield* p.body).from_version, 0, "from_version");
    yield* eqJ((yield* p.body).to_version, 1, "to_version");
    yield* eqJ(
      (yield* p.body).issues.map((i) => i.field),
      expected,
      "issue fields in document order",
    );
    yield* check(
      (yield* p.body).issues.every((i) => typeof i.issue === "string" && i.issue.length > 0),
      "issue text",
      (yield* p.body).issues,
    );
    const e = yield* expectError(yield* put(a, 0, doc), 422, "validation_failed", "PUT with reference issues");
    yield* eqJ(fieldsOf(e), expected, "PUT details = plan issues");
    yield* eqJ((yield* (yield* getReg(a)).body).version, 0, "nothing stored");
  }),
);

test(
  "registry: stale base 409; plan ignores base; change list",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, REGISTRY);
    yield* expectError(yield* put(a, 0, REGISTRY), 409, "conflict", "stale base_version");
    const noop = yield* plan(a, REGISTRY, 0);
    yield* eqJ(noop.status, 200, "plan with stale base still plans");
    yield* same(
      {
        applicable: (yield* noop.body).applicable,
        changes: (yield* noop.body).changes,
        issues: (yield* noop.body).issues,
        violations: (yield* noop.body).violations,
      },
      { applicable: true, changes: [], issues: [], violations: [] },
      "no-op plan",
    );
    const desired = {
      attributes: [...ATTRS.filter((x) => x.key !== "employee/level"), { key: "employee/title", type: "string" }],
      shapes: [{ ...EMPLOYEE, attributes: [...EMPLOYEE.attributes.filter((k) => k !== "employee/level"), "employee/title"] }],
      policies: [POLICIES[0], { ...POLICIES[1], name: "Non-solicit agreement" }],
      automations: AUTOMATIONS,
    };
    desired.attributes = desired.attributes.map((x) => (x.key === "person/nickname" ? { ...x, label: "Nickname" } : x));
    const p = yield* plan(a, desired);
    yield* eqJ((yield* p.body).issues, [], "desired is valid");
    yield* eqJ(
      (yield* p.body).changes,
      [
        { kind: "attribute", key: "employee/level", change: "removed" },
        { kind: "attribute", key: "employee/title", change: "added" },
        { kind: "attribute", key: "person/nickname", change: "modified" },
        { kind: "shape", key: "contractor", change: "removed" },
        { kind: "shape", key: "employee", change: "modified" },
        { kind: "policy", key: "high-earner", change: "modified" },
        { kind: "policy", key: "remote", change: "removed" },
      ],
      "changes sorted by kind then key",
    );
    yield* eqJ((yield* p.body).applicable, true, "applicable (no live entities)");
  }),
);

test(
  "impact: removing an attribute shows every dependent document",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, REGISTRY);
    const desired = {
      ...REGISTRY,
      attributes: ATTRS.filter((x) => x.key !== "employee/work_state"),
      shapes: [{ ...EMPLOYEE, attributes: EMPLOYEE.attributes.filter((k) => k !== "employee/work_state") }, CONTRACTOR],
    };
    const p = yield* plan(a, desired);
    yield* eqJ(p.status, 200, "plan 200");
    yield* eqJ((yield* p.body).applicable, false, "not applicable");
    yield* eqJ(
      (yield* p.body).issues.map((i) => i.field),
      ["policies[0].applies_when.fact", "automations[0].on.changed[0]", "automations[0].when.fact"],
      "every reference to the removed attribute",
    );
    yield* expectError(yield* put(a, 1, desired), 422, "validation_failed", "PUT refuses");
  }),
);

test(
  "entities: create, Location, validation, registry_version",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, { ...REGISTRY, automations: [] });
    const r = yield* create(a, "employee", {
      "person/email": "ada@x.co",
      "employee/work_state": "CA",
      "employee/level": 3,
      "person/nickname": null,
    });
    yield* eqJ(r.status, 201, `create (${r.text.slice(0, 300)})`);
    const e = yield* r.body;
    yield* check(ID_RE.test(e.id), "id format", e.id);
    yield* eqJ(r.headers["location"], `/v2/entities/${e.id}`, "Location");
    yield* same(
      { shape: e.shape, facts: e.facts, version: e.version, registry_version: e.registry_version, effects: e.effects },
      {
        shape: "employee",
        facts: { "person/email": "ada@x.co", "employee/work_state": "CA", "employee/level": 3 },
        version: 1,
        registry_version: 1,
        effects: [],
      },
      "created entity (null omitted)",
    );
    yield* check(TS_RE.test(e.created_at) && e.created_at === e.updated_at, "timestamps", e);
    const g = yield* req(Entity, "GET", `/v2/entities/${e.id}`, { account: a });
    yield* eqJ(g.status, 200, "GET");
    yield* same(yield* g.body, Object.fromEntries(Object.entries(e).filter(([k]) => k !== "effects")), "GET equals create minus effects");
    yield* expectError(yield* req(Entity, "GET", `/v2/entities/${e.id}`, { account: newAccount() }), 404, "not_found", "other account");
    const bad: [[string, object], string][] = [
      [["manager", { "person/email": "b@x.co" }], "shape"],
      [["employee", { "person/email": "b@x.co", "contractor/rate": 5 }], "facts.contractor/rate"],
      [["contractor", { "person/email": "b@x.co", "employee/salary": 5 }], "facts.employee/salary"],
      [["employee", { "person/email": "b@x.co", "employee/salary": "5" }], "facts.employee/salary"],
      [["employee", { "person/email": "b@x.co", "employee/level": 1.5 }], "facts.employee/level"],
      [["employee", { "person/email": "b@x.co", "employee/work_state": "TX" }], "facts.employee/work_state"],
      [["employee", { "person/email": "b@x.co", "employee/start_date": "2026-02-30" }], "facts.employee/start_date"],
      [["employee", { "employee/salary": 5 }], "facts.person/email"],
      [["employee", { "person/email": null }], "facts.person/email"],
    ];
    for (const [[shape, facts], field] of bad) {
      yield* expectField(
        yield* expectError(yield* create(a, shape, facts), 422, "validation_failed", `create ${field}`),
        field,
        `create ${field}`,
      );
    }
  }),
);

test(
  "entities: PATCH, retract, no-op, expected_version, empty facts",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, { ...REGISTRY, automations: [] });
    const e = yield* createOk(a, "employee", { "person/email": "ada@x.co", "employee/salary": 10 });
    const p = yield* patchOk(a, e.id, { "employee/salary": null, "employee/remote": true }, 1);
    yield* same(
      { facts: p.facts, version: p.version, effects: p.effects },
      { facts: { "person/email": "ada@x.co", "employee/remote": true }, version: 2, effects: [] },
      "patched",
    );
    yield* check(p.updated_at > e.updated_at, "updated_at advances", p);
    const n = yield* patchOk(a, e.id, { "employee/remote": true, "employee/salary": null });
    yield* eqJ([n.version, n.updated_at], [2, p.updated_at], "no-op PATCH changes nothing");
    yield* expectError(yield* patch(a, e.id, { "employee/level": 2 }, 1), 409, "conflict", "stale expected_version");
    yield* expectField(yield* expectError(yield* patch(a, e.id, {}), 422, "validation_failed", "empty facts"), "facts", "empty facts");
    yield* expectField(
      yield* expectError(yield* patch(a, e.id, { "person/email": null }), 422, "validation_failed", "retract required"),
      "facts.person/email",
      "retract required",
    );
    yield* expectError(yield* patch(a, "en_AAAAAAAAAAAAAAAAAAAAA", { "employee/level": 2 }), 404, "not_found", "unknown id");
  }),
);

test(
  "automations: trigger on changed attribute, when, effects, outbox, depth 1",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, REGISTRY);
    const e = yield* createOk(a, "employee", { "person/email": "ada@x.co", "employee/work_state": "CA" });
    yield* eqJ(e.effects, [], "CA hire: co-onboarding's when is F, salary-watch not triggered");
    const p = yield* patchOk(a, e.id, { "employee/work_state": "CO" }, undefined, "hr");
    yield* same(
      effectsOf(p),
      [
        { automation_id: "co-onboarding", form: "co-dr0004", op: "send_form" },
        { automation_id: "co-onboarding", message: "Colorado hire", op: "notify" },
        { attribute: "employee/salary", automation_id: "co-onboarding", op: "set", value: 50000 },
      ],
      "effects in order; the set does not trigger salary-watch (depth 1)",
    );
    yield* eqJ(p.facts["employee/salary"], 50000, "set applied");
    const o = yield* req(Outbox, "GET", "/v2/outbox", { account: a });
    yield* eqJ(o.status, 200, "outbox");
    yield* eqJ(
      (yield* o.body).data.map(({ entity_id, automation_id, op, form, message }) =>
        canon({ entity_id, automation_id, op, ...(form ? { form } : {}), ...(message ? { message } : {}) }),
      ),
      [
        { automation_id: "co-onboarding", entity_id: e.id, form: "co-dr0004", op: "send_form" },
        { automation_id: "co-onboarding", entity_id: e.id, message: "Colorado hire", op: "notify" },
      ],
      "outbox has send_form and notify only",
    );
    yield* check(
      (yield* o.body).data[0]!.seq < (yield* o.body).data[1]!.seq && TS_RE.test((yield* o.body).data[0]!.at),
      "seq increases",
      (yield* o.body).data,
    );
    const s = yield* patchOk(a, e.id, { "employee/salary": 60000 });
    yield* same(
      effectsOf(s),
      [{ automation_id: "salary-watch", message: "salary changed", op: "notify" }],
      "API salary change triggers salary-watch",
    );
    const n = yield* patchOk(a, e.id, { "person/nickname": "A" });
    yield* eqJ(n.effects, [], "unrelated attribute triggers nothing");
    const c = yield* createOk(a, "employee", { "person/email": "bo@x.co", "employee/work_state": "CO" });
    yield* eqJ(
      effectsOf(c).map((x) => x.automation_id),
      ["co-onboarding", "co-onboarding", "co-onboarding"],
      "create counts as change",
    );
    const contractor = yield* createOk(a, "contractor", { "person/email": "cy@x.co" });
    yield* eqJ(contractor.effects, [], "automations are per shape");
  }),
);

test(
  "automations: when sees earlier automations' sets; outbox paging",
  Effect.gen(function* () {
    const a = newAccount();
    const autos = [
      {
        id: "first",
        shape: "employee",
        on: { changed: ["employee/work_state"] },
        do: [{ op: "set", attribute: "employee/level", value: 2 }],
      },
      {
        id: "second",
        shape: "employee",
        on: { changed: ["employee/work_state"] },
        when: C("employee/level", "equal", 2),
        do: [{ op: "notify", message: "level 2" }],
      },
    ];
    yield* putOk(a, 0, { ...REGISTRY, policies: [], automations: autos });
    const e = yield* createOk(a, "employee", { "person/email": "ada@x.co", "employee/work_state": "NY" });
    yield* eqJ(
      effectsOf(e).map((x) => `${x.automation_id}:${x.op}`),
      ["first:set", "second:notify"],
      "second sees first's set",
    );
    for (const s of ["CA", "CO", "NY", "CA"]) yield* patchOk(a, e.id, { "employee/work_state": s });
    const all: (typeof Outbox.Type.data)[number][] = [];
    let after: number | null | undefined;
    for (let i = 0; i < 10; i++) {
      const r = yield* req(Outbox, "GET", `/v2/outbox?limit=2${after === undefined ? "" : `&after=${after}`}`, { account: a });
      yield* eqJ(r.status, 200, "outbox page");
      if ((yield* r.body).data.length === 0) {
        yield* eqJ((yield* r.body).next_after, null, "empty page next_after null");
        break;
      }
      all.push(...(yield* r.body).data);
      yield* eqJ((yield* r.body).next_after, (yield* r.body).data.at(-1)?.seq, "next_after = last seq");
      after = (yield* r.body).next_after;
    }
    yield* eqJ(all.length, 5, "5 notifies across pages");
    yield* check(
      all.every((x, i) => i === 0 || x.seq > all[i - 1]!.seq),
      "strictly increasing",
      all.map((x) => x.seq),
    );
    yield* expectField(
      yield* expectError(yield* req(Outbox, "GET", "/v2/outbox?limit=0", { account: a }), 422, "validation_failed", "limit 0"),
      "limit",
      "limit",
    );
  }),
);

test(
  "uniqueness is per attribute, across shapes, among live entities",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, { ...REGISTRY, automations: [] });
    const e = yield* createOk(a, "employee", { "person/email": "ada@x.co" });
    yield* expectField(
      yield* expectError(yield* create(a, "contractor", { "person/email": "ada@x.co" }), 409, "conflict", "dup across shapes"),
      "facts.person/email",
      "dup",
    );
    yield* createOk(a, "employee", { "person/email": "Ada@x.co" });
    yield* createOk(a, "contractor", { "person/nickname": "same" });
    yield* createOk(a, "contractor", { "person/nickname": "same" });
    yield* eqJ((yield* req(Empty, "DELETE", `/v2/entities/${e.id}`, { account: a })).status, 204, "delete");
    yield* createOk(a, "contractor", { "person/email": "ada@x.co" });
  }),
);

test(
  "history, as_of and delete from the facts log",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, REGISTRY);
    const e = yield* createOk(a, "employee", { "person/email": "ada@x.co", "employee/work_state": "CA" }, "ada");
    yield* Effect.sleep(5);
    const p1 = yield* patchOk(a, e.id, { "employee/work_state": "CO" }, undefined, "hr");
    yield* Effect.sleep(5);
    const p2 = yield* patchOk(a, e.id, { "employee/salary": null }, undefined, "hr");
    const h = yield* req(History, "GET", `/v2/entities/${e.id}/history`, { account: a });
    yield* eqJ(h.status, 200, "history");
    const rows = (yield* h.body).data.map(({ attribute, op, value, reason, actor }) => ({ attribute, op, value, reason, actor }));
    yield* eqJ(
      rows,
      [
        { attribute: "employee/work_state", op: "assert", value: "CA", reason: "api", actor: "ada" },
        { attribute: "person/email", op: "assert", value: "ada@x.co", reason: "api", actor: "ada" },
        { attribute: "employee/work_state", op: "assert", value: "CO", reason: "api", actor: "hr" },
        { attribute: "employee/salary", op: "assert", value: 50000, reason: "automation", actor: "automation:co-onboarding" },
        { attribute: "employee/salary", op: "retract", value: 50000, reason: "api", actor: "hr" },
      ],
      "history rows (tx, then attribute)",
    );
    const txs = (yield* h.body).data.map((x) => x.tx);
    yield* check(txs.every((t, i) => i === 0 || t >= txs[i - 1]!) && txs[0]! < txs[2]!, "tx ordering", txs);
    yield* check(
      (yield* h.body).data.every((x) => TS_RE.test(x.at)),
      "at format",
      (yield* h.body).data,
    );
    const at = (ts: string) => req(Entity, "GET", `/v2/entities/${e.id}?as_of=${encodeURIComponent(ts)}`, { account: a });
    const v1 = yield* at(e.created_at);
    yield* eqJ(v1.status, 200, "as_of creation");
    yield* same((yield* v1.body).facts, { "person/email": "ada@x.co", "employee/work_state": "CA" }, "as_of creation facts");
    yield* eqJ((yield* v1.body).version, 1, "as_of version");
    const v2 = yield* at(p1.updated_at);
    yield* same(
      (yield* v2.body).facts,
      { "person/email": "ada@x.co", "employee/work_state": "CO", "employee/salary": 50000 },
      "as_of after automation",
    );
    yield* expectError(yield* at(new Date(Date.parse(e.created_at) - 1000).toISOString()), 404, "not_found", "before creation");
    yield* expectField(yield* expectError(yield* at("yesterday"), 422, "validation_failed", "bad as_of"), "as_of", "as_of");
    yield* eqJ((yield* req(Empty, "DELETE", `/v2/entities/${e.id}`, { account: a })).status, 204, "delete");
    yield* expectError(yield* req(Entity, "GET", `/v2/entities/${e.id}`, { account: a }), 404, "not_found", "deleted");
    yield* same(
      (yield* (yield* at(p2.updated_at)).body)?.facts,
      { "person/email": "ada@x.co", "employee/work_state": "CO" },
      "as_of before delete",
    );
    yield* eqJ((yield* req(History, "GET", `/v2/entities/${e.id}/history`, { account: a })).status, 200, "history of deleted entity");
    yield* expectError(yield* req(Empty, "DELETE", `/v2/entities/${e.id}`, { account: a }), 404, "not_found", "delete twice");
  }),
);

test(
  "evaluate: three-valued policies over facts",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, { ...REGISTRY, automations: [] });
    const ev = Effect.fnUntraced(function* (id: string) {
      const r = yield* req(Evaluate, "POST", `/v2/entities/${id}/evaluate`, { account: a });
      yield* eqJ(r.status, 200, "evaluate");
      return yield* r.body;
    });
    const e1 = yield* createOk(a, "employee", { "person/email": "a@x.co", "employee/work_state": "CO" });
    yield* same(
      yield* ev(e1.id),
      { required: ["co-dr0004", "w-4"], undetermined: ["non-solicit", "office-badge", "remote-kit"] },
      "missing salary and remote are unknown",
    );
    yield* patchOk(a, e1.id, { "employee/salary": 150000, "employee/remote": false });
    yield* same(yield* ev(e1.id), { required: ["co-dr0004", "non-solicit", "office-badge", "w-4"], undetermined: [] }, "all known");
    const e2 = yield* createOk(a, "employee", {
      "person/email": "b@x.co",
      "employee/work_state": "NY",
      "employee/salary": 10,
      "employee/remote": true,
    });
    yield* same(yield* ev(e2.id), { required: ["remote-kit"], undetermined: [] }, "NY remote");
    const c = yield* createOk(a, "contractor", { "person/email": "c@x.co" });
    yield* same(yield* ev(c.id), { required: [], undetermined: [] }, "no policies for contractor");
  }),
);

test(
  "registry evolution: violations, 409, migration retracts",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, { ...REGISTRY, automations: [] });
    const e1 = yield* createOk(a, "employee", { "person/email": "a@x.co", "person/nickname": "dup", "employee/level": 3 });
    const e2 = yield* createOk(a, "employee", {
      "person/email": "b@x.co",
      "person/nickname": "dup",
      "employee/salary": 5,
      "employee/level": 4,
    });
    const c = yield* createOk(a, "contractor", { "person/email": "c@x.co" });
    const lo = e1.id < e2.id ? e1.id : e2.id;
    const hi = e1.id < e2.id ? e2.id : e1.id;
    const desired = {
      ...REGISTRY,
      automations: [],
      attributes: ATTRS.map((x) => (x.key === "person/nickname" ? { ...x, unique: true } : x)),
      shapes: [{ ...EMPLOYEE, required: ["person/email", "employee/salary"] }],
    };
    const p = yield* plan(a, desired);
    yield* eqJ((yield* p.body).issues, [], "no static issues");
    const expected = [
      { entity_id: c.id, field: "shape" },
      { entity_id: e1.id, field: "facts.employee/salary" },
      { entity_id: hi, field: "facts.person/nickname" },
    ].sort((x, y) => (x.entity_id < y.entity_id ? -1 : x.entity_id > y.entity_id ? 1 : x.field < y.field ? -1 : 1));
    yield* eqJ(
      (yield* p.body).violations.map(({ entity_id, field }) => ({ entity_id, field })),
      expected,
      "violations sorted",
    );
    yield* check(
      !(yield* p.body).violations.some((v) => v.entity_id === lo && v.field === "facts.person/nickname"),
      "lowest id keeps the value",
    );
    yield* eqJ((yield* p.body).applicable, false, "not applicable");
    const e = yield* expectError(yield* put(a, 1, desired), 409, "conflict", "PUT with violations");
    yield* same(fieldsOf(e).sort(), expected.map((v) => `${v.entity_id}.${v.field}`).sort(), "PUT details");
    // Removing an attribute from the shape retracts its facts, audited as migration.
    const shrink = {
      ...REGISTRY,
      automations: [],
      policies: REGISTRY.policies.filter((x) => x.id !== "high-earner"),
      attributes: ATTRS.filter((x) => x.key !== "employee/level" && x.key !== "employee/salary"),
      shapes: [
        { ...EMPLOYEE, attributes: EMPLOYEE.attributes.filter((k) => k !== "employee/level" && k !== "employee/salary") },
        CONTRACTOR,
      ],
    };
    const ps = yield* plan(a, shrink);
    yield* same(
      { applicable: (yield* ps.body).applicable, issues: (yield* ps.body).issues, violations: (yield* ps.body).violations },
      { applicable: true, issues: [], violations: [] },
      "shrink plan",
    );
    const r = yield* putOk(a, 1, shrink, "admin");
    yield* eqJ(r.version, 2, "applied");
    const g = yield* req(Entity, "GET", `/v2/entities/${e2.id}`, { account: a });
    yield* same((yield* g.body).facts, { "person/email": "b@x.co", "person/nickname": "dup" }, "facts dropped");
    yield* eqJ((yield* g.body).registry_version, 2, "registry_version follows the migration write");
    const h = yield* req(History, "GET", `/v2/entities/${e2.id}/history`, { account: a });
    yield* eqJ(
      (yield* h.body).data
        .filter((x) => x.reason === "migration")
        .map(({ attribute, op, value, actor }) => ({ attribute, op, value, actor })),
      [
        { attribute: "employee/level", op: "retract", value: 4, actor: "admin" },
        { attribute: "employee/salary", op: "retract", value: 5, actor: "admin" },
      ],
      "migration retracts",
    );
    yield* eqJ(c.registry_version, 1, "sanity");
  }),
);

test(
  "concurrency: parallel writers in one account; unique race",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, { ...REGISTRY, automations: [] });
    const es = [];
    for (let i = 0; i < 10; i++) es.push(yield* createOk(a, "employee", { "person/email": `p${i}@x.co` }));
    const rs = yield* Effect.all(
      es.map((e, i) => patch(a, e.id, { "employee/level": i })),
      { concurrency: "unbounded" },
    );
    yield* eqJ(
      rs.map((r) => r.status),
      es.map(() => 200),
      "all parallel PATCHes succeed",
    );
    const race = yield* Effect.all(
      [create(a, "employee", { "person/email": "race@x.co" }), create(a, "contractor", { "person/email": "race@x.co" })],
      { concurrency: "unbounded" },
    );
    yield* eqJ(race.map((r) => r.status).sort(), [201, 409], "exactly one wins the unique race");
    const regs = yield* Effect.all([put(a, 1, REGISTRY), put(a, 1, REGISTRY), put(a, 1, REGISTRY)], { concurrency: "unbounded" });
    yield* eqJ(regs.map((r) => r.status).sort(), [200, 409, 409], "registry CAS");
  }),
);

run();
