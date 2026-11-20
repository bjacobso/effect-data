#!/usr/bin/env node
// effect-data certification pack conformance (Pass 3). Requires the server to run with the
// certification and onboarding packs enabled (the default PACKS).
// Usage: BASE_URL=http://localhost:8086 node conformance/data-certs.ts [--filter text]
// Contract: ../PLAN.md "Pass 3".

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
  CertRegistry,
  Plan,
  Mutation,
  Outbox,
  Certifications,
  Empty,
} from "./client.ts";

// ---------------- fixtures ----------------
const C = (fact: string, operator: string, value?: unknown) => ({ fact, operator, ...(value === undefined ? {} : { value }) });
const ATTRS: { key: string; type: string; unique?: boolean; values?: string[]; label?: string }[] = [
  { key: "person/email", type: "string", unique: true },
  { key: "employee/role", type: "enum", values: ["driver", "office"] },
  { key: "employee/remote", type: "boolean" },
  { key: "cert/forklift_expires", type: "date" },
  { key: "cert/cpr_expires", type: "date" },
  { key: "cert/badge_number", type: "string" },
];
const EMPLOYEE = { key: "employee", attributes: ATTRS.map((a) => a.key), required: ["person/email"] };
const VISITOR = { key: "visitor", attributes: ["person/email", "cert/cpr_expires"] };
const REQS = [
  {
    id: "forklift",
    name: "Forklift licence",
    shape: "employee",
    expires: "cert/forklift_expires",
    renew_within_days: 30,
    applies_when: C("employee/role", "equal", "driver"),
  },
  { id: "cpr", name: "CPR", shape: "employee", expires: "cert/cpr_expires", renew_within_days: 60 },
  {
    id: "remote-safety",
    name: "Home office safety",
    shape: "employee",
    expires: "cert/cpr_expires",
    renew_within_days: 10,
    applies_when: C("employee/remote", "equal", true),
  },
  { id: "visitor-cpr", name: "Visitor CPR", shape: "visitor", expires: "cert/cpr_expires", renew_within_days: 5 },
];
const AUTOS = [
  {
    id: "forklift-renewal",
    shape: "employee",
    on: { changed: ["cert/forklift_expires"] },
    when: C("employee/role", "equal", "driver"),
    do: [
      { op: "schedule_renewal", requirement: "forklift" },
      { op: "send_form", form: "forklift-refresher" },
    ],
  },
];
const REGISTRY = { attributes: ATTRS, shapes: [EMPLOYEE, VISITOR], policies: [], certification_requirements: REQS, automations: AUTOS };

const put = (account: string, base_version: number, doc: object) =>
  req(CertRegistry, "PUT", "/v2/registry", { account, body: { base_version, ...doc } });
const plan = (account: string, doc: object) => req(Plan, "POST", "/v2/registry/plan", { account, body: doc });
const putOk = Effect.fnUntraced(function* (account: string, base: number, doc: object) {
  const r = yield* put(account, base, doc);
  yield* eqJ(r.status, 200, `PUT registry (${r.text.slice(0, 500)})`);
  return yield* r.body;
});
const createOk = Effect.fnUntraced(function* (account: string, shape: string, facts: object) {
  const r = yield* req(Mutation, "POST", "/v2/entities", { account, body: { shape, facts } });
  yield* eqJ(r.status, 201, `create (${r.text.slice(0, 400)})`);
  return yield* r.body;
});
const certs = (account: string, id: string, body: object) =>
  req(Certifications, "POST", `/v2/entities/${id}/certifications`, { account, body });
const minus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
const row = (requirement: string, status: string, expires?: string, days = 0) => ({
  requirement,
  status,
  ...(expires ? { expires, renew_by: minus(expires, days) } : {}),
});

// ---------------- cases ----------------
const { test, run } = suite();

test(
  "collections: optional on input, present on output, round-trip",
  Effect.gen(function* () {
    const a = newAccount();
    const empty = yield* req(CertRegistry, "GET", "/v2/registry", { account: a });
    yield* eqJ(empty.status, 200, "GET");
    yield* eqJ((yield* empty.body).certification_requirements, [], "empty collection present");
    yield* eqJ((yield* empty.body).policies, [], "other pack's collection present");
    const r = yield* putOk(a, 0, { attributes: ATTRS, shapes: [EMPLOYEE] });
    yield* same(
      { policies: r.policies, certification_requirements: r.certification_requirements, automations: r.automations },
      { policies: [], certification_requirements: [], automations: [] },
      "absent collections default to []",
    );
    const r2 = yield* putOk(a, 1, REGISTRY);
    yield* same(
      yield* (yield* req(CertRegistry, "GET", "/v2/registry", { account: a })).body,
      { version: 2, ...REGISTRY, queries: [], rollout: { version: 2, status: "done", processed: 0, total: 0 } },
      "full round-trip",
    );
    yield* eqJ(r2.version, 2, "version");
  }),
);

test(
  "static checks: structure, expires, shape, kind references",
  Effect.gen(function* () {
    const a = newAccount();
    const structural: [object, string][] = [
      [
        { ...REGISTRY, certification_requirements: [{ ...REQS[1], renew_within_days: 0 }] },
        "certification_requirements[0].renew_within_days",
      ],
      [
        { ...REGISTRY, certification_requirements: [{ ...REQS[1], renew_within_days: 2.5 }] },
        "certification_requirements[0].renew_within_days",
      ],
      [{ ...REGISTRY, certification_requirements: [{ ...REQS[1], grace: 3 }] }, "certification_requirements[0].grace"],
      [{ ...REGISTRY, certification_requirements: [REQS[1], { ...REQS[0], id: "cpr" }] }, "certification_requirements[1].id"],
      [{ ...REGISTRY, automations: [{ ...AUTOS[0], do: [{ op: "schedule_renewal" }] }] }, "automations[0].do[0].requirement"],
    ];
    for (const [doc, field] of structural) {
      const e = yield* expectError(yield* plan(a, doc), 422, "validation_failed", `plan ${field}`);
      yield* check(fieldsOf(e).includes(field), `plan ${field}`, fieldsOf(e));
    }
    const doc = {
      ...REGISTRY,
      certification_requirements: [
        { ...REQS[0], expires: "cert/badge_number" },
        { ...REQS[1], expires: "person/nope" },
        { ...REQS[2], shape: "contractor", applies_when: C("contractor/x", "equal", 1) },
        { ...REQS[3], expires: "employee/role" },
        {
          id: "typed",
          name: "Typed",
          shape: "employee",
          expires: "cert/cpr_expires",
          renew_within_days: 5,
          applies_when: C("employee/role", "lessThan", "driver"),
        },
        { id: "visitor-only", name: "Visitor only", shape: "visitor", expires: "cert/cpr_expires", renew_within_days: 5 },
      ],
      automations: [
        {
          id: "a0",
          shape: "employee",
          on: { changed: ["employee/role"] },
          do: [
            { op: "schedule_renewal", requirement: "nope" },
            { op: "schedule_renewal", requirement: "visitor-only" },
            { op: "schedule_renewal", requirement: "cpr" },
          ],
        },
      ],
    };
    const expected = [
      "certification_requirements[0].expires",
      "certification_requirements[1].expires",
      "certification_requirements[2].shape",
      "certification_requirements[3].expires",
      "certification_requirements[4].applies_when.operator",
      "automations[0].do[0].requirement",
      "automations[0].do[1].requirement",
    ];
    const p = yield* plan(a, doc);
    yield* eqJ(p.status, 200, `plan (${p.text.slice(0, 300)})`);
    yield* eqJ((yield* p.body).applicable, false, "not applicable");
    yield* eqJ(
      (yield* p.body).issues.map((i) => i.field),
      expected,
      "issues in document order",
    );
    yield* eqJ(
      fieldsOf(yield* expectError(yield* put(a, 0, doc), 422, "validation_failed", "PUT")),
      expected,
      "PUT refuses with same issues",
    );
  }),
);

test(
  "impact: removing a requirement or retiring its expiry attribute",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, REGISTRY);
    const p1 = yield* plan(a, { ...REGISTRY, certification_requirements: REQS.filter((r) => r.id !== "forklift") });
    yield* eqJ(
      (yield* p1.body).issues.map((i) => i.field),
      ["automations[0].do[0].requirement"],
      "automation loses its requirement",
    );
    yield* same((yield* p1.body).changes, [{ kind: "certification_requirement", key: "forklift", change: "removed" }], "change kind name");
    const noForklift = {
      ...REGISTRY,
      attributes: ATTRS.map((x) => (x.key === "cert/forklift_expires" ? { ...x, retired: true } : x)),
      shapes: [{ ...EMPLOYEE, attributes: EMPLOYEE.attributes.filter((k) => k !== "cert/forklift_expires") }, VISITOR],
    };
    const p2 = yield* plan(a, noForklift);
    yield* eqJ(
      (yield* p2.body).issues.map((i) => i.field),
      ["certification_requirements[0].expires", "automations[0].on.changed[0]"],
      "requirement and trigger both depend on the attribute",
    );
  }),
);

test(
  "certifications route: every status, dates, ordering, per shape",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, { ...REGISTRY, automations: [] });
    const on = "2026-11-18";
    const A = yield* createOk(a, "employee", {
      "person/email": "a@x.co",
      "employee/role": "driver",
      "cert/forklift_expires": "2026-12-01",
      "cert/cpr_expires": "2027-06-01",
    });
    const r = yield* certs(a, A.id, { on });
    yield* eqJ(r.status, 200, `certifications (${r.text.slice(0, 300)})`);
    yield* same(
      yield* r.body,
      {
        data: [
          row("cpr", "valid", "2027-06-01", 60),
          row("forklift", "due", "2026-12-01", 30),
          row("remote-safety", "undetermined", "2027-06-01", 10),
        ],
      },
      "driver: valid / due / undetermined, sorted",
    );
    const B = yield* createOk(a, "employee", {
      "person/email": "b@x.co",
      "employee/role": "office",
      "employee/remote": false,
      "cert/cpr_expires": "2026-11-01",
    });
    yield* same(
      yield* (yield* certs(a, B.id, { on })).body,
      {
        data: [
          row("cpr", "expired", "2026-11-01", 60),
          row("forklift", "not_applicable"),
          row("remote-safety", "not_applicable", "2026-11-01", 10),
        ],
      },
      "office: expired / not_applicable (dates whenever the fact exists)",
    );
    const Cc = yield* createOk(a, "employee", { "person/email": "c@x.co", "employee/role": "driver", "employee/remote": true });
    yield* same(
      yield* (yield* certs(a, Cc.id, { on })).body,
      { data: [row("cpr", "missing"), row("forklift", "missing"), row("remote-safety", "missing")] },
      "missing",
    );
    const edge = yield* createOk(a, "employee", {
      "person/email": "d@x.co",
      "employee/role": "driver",
      "cert/forklift_expires": on,
      "cert/cpr_expires": minus(on, -60),
    });
    yield* same(
      (yield* (yield* certs(a, edge.id, { on })).body).data.slice(0, 2),
      [row("cpr", "due", minus(on, -60), 60), row("forklift", "due", on, 30)],
      "boundaries: on == renew_by is due; on == expires is due, not expired",
    );
    yield* same(
      (yield* (yield* certs(a, edge.id, { on: minus(on, -1) })).body).data[1],
      row("forklift", "expired", on, 30),
      "day after expiry",
    );
    const V = yield* createOk(a, "visitor", { "person/email": "v@x.co", "cert/cpr_expires": "2026-11-20" });
    yield* same(
      yield* (yield* certs(a, V.id, { on })).body,
      { data: [row("visitor-cpr", "due", "2026-11-20", 5)] },
      "only the visitor shape's requirements",
    );
  }),
);

test(
  "certifications route: validation and 404",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, REGISTRY);
    const e = yield* createOk(a, "employee", { "person/email": "a@x.co" });
    for (const body of [{ on: "2026-02-30" }, { on: "18/11/2026" }, { on: 20261118 }, {}]) {
      const err = yield* expectError(yield* certs(a, e.id, body), 422, "validation_failed", `on ${JSON.stringify(body)}`);
      yield* check(fieldsOf(err).includes("on"), "field on", fieldsOf(err));
    }
    yield* expectError(yield* certs(a, "en_AAAAAAAAAAAAAAAAAAAAA", { on: "2026-11-18" }), 404, "not_found", "unknown entity");
    yield* eqJ((yield* req(Empty, "DELETE", `/v2/entities/${e.id}`, { account: a })).status, 204, "delete");
    yield* expectError(yield* certs(a, e.id, { on: "2026-11-18" }), 404, "not_found", "deleted entity");
  }),
);

test(
  "automation mixes both packs' ops; outbox carries op fields",
  Effect.gen(function* () {
    const a = newAccount();
    yield* putOk(a, 0, REGISTRY);
    const e = yield* createOk(a, "employee", {
      "person/email": "a@x.co",
      "employee/role": "office",
      "cert/forklift_expires": "2027-01-01",
    });
    yield* eqJ(e.effects, [], "office: when is F");
    const p = yield* req(Mutation, "PATCH", `/v2/entities/${e.id}`, { account: a, body: { facts: { "employee/role": "driver" } } });
    yield* eqJ((yield* p.body).effects, [], "role change is not a trigger");
    const q = yield* req(Mutation, "PATCH", `/v2/entities/${e.id}`, {
      account: a,
      body: { facts: { "cert/forklift_expires": "2027-02-01" } },
    });
    yield* eqJ(q.status, 200, "patch");
    yield* same(
      (yield* q.body).effects,
      [
        { automation_id: "forklift-renewal", op: "schedule_renewal", requirement: "forklift" },
        { automation_id: "forklift-renewal", op: "send_form", form: "forklift-refresher" },
      ],
      "effects from both packs, in order",
    );
    const o = yield* req(Outbox, "GET", "/v2/outbox", { account: a });
    yield* same(
      (yield* o.body).data.map(({ seq, at, ...rest }) => rest),
      [
        { entity_id: e.id, automation_id: "forklift-renewal", op: "schedule_renewal", requirement: "forklift" },
        { entity_id: e.id, automation_id: "forklift-renewal", op: "send_form", form: "forklift-refresher" },
      ],
      "outbox items",
    );
  }),
);

run();
