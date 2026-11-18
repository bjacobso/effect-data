#!/usr/bin/env node
// effect-data certification pack conformance (Pass 3). Requires the server to run with the
// certification and onboarding packs enabled (the default PACKS).
// Usage: BASE_URL=http://localhost:8086 node conformance/data-certs.mjs [--filter text]
// Contract: ../PLAN.md "Pass 3".

import { randomBytes } from "node:crypto";

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
if (!BASE_URL) { console.error("BASE_URL is required"); process.exit(2); }
const fi = process.argv.indexOf("--filter");
const FILTER = fi > -1 ? process.argv[fi + 1] : null;
const newAccount = () => `acct_${randomBytes(8).toString("hex")}`;

class Failure extends Error {}
const check = (c, msg, got) => { if (!c) throw new Failure(got === undefined ? msg : `${msg}\n      got: ${JSON.stringify(got).slice(0, 700)}`); };
function eqJ(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Failure(`${msg}\n      expected: ${e.slice(0, 900)}\n      got:      ${(a ?? "undefined").slice(0, 900)}`);
}
const canon = (x) => Array.isArray(x) ? x.map(canon) : x && typeof x === "object"
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
const same = (a, e, msg) => eqJ(canon(a), canon(e), msg);

async function req(method, path, { account, body, raw } = {}) {
  const h = {};
  if (account !== null) h["X-Account-Id"] = account;
  let payload;
  if (raw !== undefined) { payload = raw; h["Content-Type"] = "application/json"; }
  else if (body !== undefined) { payload = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  const res = await fetch(BASE_URL + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, json };
}
function expectError(r, status, code, ctx) {
  eqJ(r.status, status, `${ctx}: status (${r.text.slice(0, 400)})`);
  check(r.json?.error?.code === code, `${ctx}: error.code ${code}`, r.json ?? r.text.slice(0, 200));
  return r.json.error;
}
const fieldsOf = (err) => (err.details ?? []).map((d) => d.field);

// ---------------- fixtures ----------------
const C = (fact, operator, value) => ({ fact, operator, ...(value === undefined ? {} : { value }) });
const ATTRS = [
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
  { id: "forklift", name: "Forklift licence", shape: "employee", expires: "cert/forklift_expires",
    renew_within_days: 30, applies_when: C("employee/role", "equal", "driver") },
  { id: "cpr", name: "CPR", shape: "employee", expires: "cert/cpr_expires", renew_within_days: 60 },
  { id: "remote-safety", name: "Home office safety", shape: "employee", expires: "cert/cpr_expires",
    renew_within_days: 10, applies_when: C("employee/remote", "equal", true) },
  { id: "visitor-cpr", name: "Visitor CPR", shape: "visitor", expires: "cert/cpr_expires", renew_within_days: 5 },
];
const AUTOS = [
  { id: "forklift-renewal", shape: "employee", on: { changed: ["cert/forklift_expires"] },
    when: C("employee/role", "equal", "driver"),
    do: [{ op: "schedule_renewal", requirement: "forklift" }, { op: "send_form", form: "forklift-refresher" }] },
];
const REGISTRY = { attributes: ATTRS, shapes: [EMPLOYEE, VISITOR], policies: [], certification_requirements: REQS, automations: AUTOS };

const put = (account, base_version, doc) => req("PUT", "/v2/registry", { account, body: { base_version, ...doc } });
const plan = (account, doc) => req("POST", "/v2/registry/plan", { account, body: doc });
async function putOk(account, base, doc) {
  const r = await put(account, base, doc);
  eqJ(r.status, 200, `PUT registry (${r.text.slice(0, 500)})`);
  return r.json;
}
async function createOk(account, shape, facts) {
  const r = await req("POST", "/v2/entities", { account, body: { shape, facts } });
  eqJ(r.status, 201, `create (${r.text.slice(0, 400)})`);
  return r.json;
}
const certs = (account, id, body) => req("POST", `/v2/entities/${id}/certifications`, { account, body });
const minus = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
const row = (requirement, status, expires, days) =>
  ({ requirement, status, ...(expires ? { expires, renew_by: minus(expires, days) } : {}) });

// ---------------- cases ----------------
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("collections: optional on input, present on output, round-trip", async () => {
  const a = newAccount();
  const empty = await req("GET", "/v2/registry", { account: a });
  eqJ(empty.status, 200, "GET");
  eqJ(empty.json.certification_requirements, [], "empty collection present");
  eqJ(empty.json.policies, [], "other pack's collection present");
  const r = await putOk(a, 0, { attributes: ATTRS, shapes: [EMPLOYEE] });
  same({ policies: r.policies, certification_requirements: r.certification_requirements, automations: r.automations },
    { policies: [], certification_requirements: [], automations: [] }, "absent collections default to []");
  const r2 = await putOk(a, 1, REGISTRY);
  same((await req("GET", "/v2/registry", { account: a })).json, { version: 2, ...REGISTRY }, "full round-trip");
  eqJ(r2.version, 2, "version");
});

test("static checks: structure, expires, shape, kind references", async () => {
  const a = newAccount();
  const structural = [
    [{ ...REGISTRY, certification_requirements: [{ ...REQS[1], renew_within_days: 0 }] }, "certification_requirements[0].renew_within_days"],
    [{ ...REGISTRY, certification_requirements: [{ ...REQS[1], renew_within_days: 2.5 }] }, "certification_requirements[0].renew_within_days"],
    [{ ...REGISTRY, certification_requirements: [{ ...REQS[1], grace: 3 }] }, "certification_requirements[0].grace"],
    [{ ...REGISTRY, certification_requirements: [REQS[1], { ...REQS[0], id: "cpr" }] }, "certification_requirements[1].id"],
    [{ ...REGISTRY, automations: [{ ...AUTOS[0], do: [{ op: "schedule_renewal" }] }] }, "automations[0].do[0].requirement"],
  ];
  for (const [doc, field] of structural) {
    const e = expectError(await plan(a, doc), 422, "validation_failed", `plan ${field}`);
    check(fieldsOf(e).includes(field), `plan ${field}`, fieldsOf(e));
  }
  const doc = {
    ...REGISTRY,
    certification_requirements: [
      { ...REQS[0], expires: "cert/badge_number" },
      { ...REQS[1], expires: "person/nope" },
      { ...REQS[2], shape: "contractor", applies_when: C("contractor/x", "equal", 1) },
      { ...REQS[3], expires: "employee/role" },
      { id: "typed", name: "Typed", shape: "employee", expires: "cert/cpr_expires", renew_within_days: 5,
        applies_when: C("employee/role", "lessThan", "driver") },
      { id: "visitor-only", name: "Visitor only", shape: "visitor", expires: "cert/cpr_expires", renew_within_days: 5 },
    ],
    automations: [
      { id: "a0", shape: "employee", on: { changed: ["employee/role"] },
        do: [{ op: "schedule_renewal", requirement: "nope" }, { op: "schedule_renewal", requirement: "visitor-only" },
             { op: "schedule_renewal", requirement: "cpr" }] },
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
  const p = await plan(a, doc);
  eqJ(p.status, 200, `plan (${p.text.slice(0, 300)})`);
  eqJ(p.json.applicable, false, "not applicable");
  eqJ(p.json.issues.map((i) => i.field), expected, "issues in document order");
  eqJ(fieldsOf(expectError(await put(a, 0, doc), 422, "validation_failed", "PUT")), expected, "PUT refuses with same issues");
});

test("impact: removing a requirement or its expiry attribute", async () => {
  const a = newAccount();
  await putOk(a, 0, REGISTRY);
  const p1 = await plan(a, { ...REGISTRY, certification_requirements: REQS.filter((r) => r.id !== "forklift") });
  eqJ(p1.json.issues.map((i) => i.field), ["automations[0].do[0].requirement"], "automation loses its requirement");
  same(p1.json.changes, [{ kind: "certification_requirement", key: "forklift", change: "removed" }], "change kind name");
  const noForklift = {
    ...REGISTRY,
    attributes: ATTRS.filter((x) => x.key !== "cert/forklift_expires"),
    shapes: [{ ...EMPLOYEE, attributes: EMPLOYEE.attributes.filter((k) => k !== "cert/forklift_expires") }, VISITOR],
  };
  const p2 = await plan(a, noForklift);
  eqJ(p2.json.issues.map((i) => i.field), [
    "certification_requirements[0].expires",
    "automations[0].on.changed[0]",
  ], "requirement and trigger both depend on the attribute");
});

test("certifications route: every status, dates, ordering, per shape", async () => {
  const a = newAccount();
  await putOk(a, 0, { ...REGISTRY, automations: [] });
  const on = "2026-11-18";
  const A = await createOk(a, "employee", { "person/email": "a@x.co", "employee/role": "driver",
    "cert/forklift_expires": "2026-12-01", "cert/cpr_expires": "2027-06-01" });
  const r = await certs(a, A.id, { on });
  eqJ(r.status, 200, `certifications (${r.text.slice(0, 300)})`);
  same(r.json, { data: [
    row("cpr", "valid", "2027-06-01", 60),
    row("forklift", "due", "2026-12-01", 30),
    row("remote-safety", "undetermined", "2027-06-01", 10),
  ] }, "driver: valid / due / undetermined, sorted");
  const B = await createOk(a, "employee", { "person/email": "b@x.co", "employee/role": "office",
    "employee/remote": false, "cert/cpr_expires": "2026-11-01" });
  same((await certs(a, B.id, { on })).json, { data: [
    row("cpr", "expired", "2026-11-01", 60),
    row("forklift", "not_applicable"),
    row("remote-safety", "not_applicable", "2026-11-01", 10),
  ] }, "office: expired / not_applicable (dates whenever the fact exists)");
  const Cc = await createOk(a, "employee", { "person/email": "c@x.co", "employee/role": "driver", "employee/remote": true });
  same((await certs(a, Cc.id, { on })).json, { data: [row("cpr", "missing"), row("forklift", "missing"), row("remote-safety", "missing")] }, "missing");
  const edge = await createOk(a, "employee", { "person/email": "d@x.co", "employee/role": "driver",
    "cert/forklift_expires": on, "cert/cpr_expires": minus(on, -60) });
  same((await certs(a, edge.id, { on })).json.data.slice(0, 2), [
    row("cpr", "due", minus(on, -60), 60),
    row("forklift", "due", on, 30),
  ], "boundaries: on == renew_by is due; on == expires is due, not expired");
  same((await certs(a, edge.id, { on: minus(on, -1) })).json.data[1], row("forklift", "expired", on, 30), "day after expiry");
  const V = await createOk(a, "visitor", { "person/email": "v@x.co", "cert/cpr_expires": "2026-11-20" });
  same((await certs(a, V.id, { on })).json, { data: [row("visitor-cpr", "due", "2026-11-20", 5)] }, "only the visitor shape's requirements");
});

test("certifications route: validation and 404", async () => {
  const a = newAccount();
  await putOk(a, 0, REGISTRY);
  const e = await createOk(a, "employee", { "person/email": "a@x.co" });
  for (const body of [{ on: "2026-02-30" }, { on: "18/11/2026" }, { on: 20261118 }, {}]) {
    const err = expectError(await certs(a, e.id, body), 422, "validation_failed", `on ${JSON.stringify(body)}`);
    check(fieldsOf(err).includes("on"), "field on", fieldsOf(err));
  }
  expectError(await certs(a, "en_AAAAAAAAAAAAAAAAAAAAA", { on: "2026-11-18" }), 404, "not_found", "unknown entity");
  eqJ((await req("DELETE", `/v2/entities/${e.id}`, { account: a })).status, 204, "delete");
  expectError(await certs(a, e.id, { on: "2026-11-18" }), 404, "not_found", "deleted entity");
});

test("automation mixes both packs' ops; outbox carries op fields", async () => {
  const a = newAccount();
  await putOk(a, 0, REGISTRY);
  const e = await createOk(a, "employee", { "person/email": "a@x.co", "employee/role": "office", "cert/forklift_expires": "2027-01-01" });
  eqJ(e.effects, [], "office: when is F");
  const p = await req("PATCH", `/v2/entities/${e.id}`, { account: a, body: { facts: { "employee/role": "driver" } } });
  eqJ(p.json.effects, [], "role change is not a trigger");
  const q = await req("PATCH", `/v2/entities/${e.id}`, { account: a, body: { facts: { "cert/forklift_expires": "2027-02-01" } } });
  eqJ(q.status, 200, "patch");
  same(q.json.effects, [
    { automation_id: "forklift-renewal", op: "schedule_renewal", requirement: "forklift" },
    { automation_id: "forklift-renewal", op: "send_form", form: "forklift-refresher" },
  ], "effects from both packs, in order");
  const o = await req("GET", "/v2/outbox", { account: a });
  same(o.json.data.map(({ seq, at, ...rest }) => rest), [
    { entity_id: e.id, automation_id: "forklift-renewal", op: "schedule_renewal", requirement: "forklift" },
    { entity_id: e.id, automation_id: "forklift-renewal", op: "send_form", form: "forklift-refresher" },
  ], "outbox items");
});

// ---------------- runner ----------------
let pass = 0, fail = 0;
for (const c of cases) {
  if (FILTER && !c.name.includes(FILTER)) continue;
  try { await c.fn(); pass++; console.log(`  ok   ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}\n      ${e instanceof Failure ? e.message : e.stack}`); }
}
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
