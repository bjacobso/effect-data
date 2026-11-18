#!/usr/bin/env node
// effect-data POC black-box conformance suite (attribute registry, facts, automations).
// Usage: BASE_URL=http://localhost:8086 node conformance/data.mjs [--filter text]
// Dependency-free (Node 22+). Fresh random account per case. Contract: ../PLAN.md.

import { randomBytes } from "node:crypto";

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
if (!BASE_URL) { console.error("BASE_URL is required"); process.exit(2); }
const fi = process.argv.indexOf("--filter");
const FILTER = fi > -1 ? process.argv[fi + 1] : null;
const newAccount = () => `acct_${randomBytes(8).toString("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID_RE = /^en_[A-Za-z0-9_-]{21}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class Failure extends Error {}
const check = (c, msg, got) => { if (!c) throw new Failure(got === undefined ? msg : `${msg}\n      got: ${JSON.stringify(got).slice(0, 700)}`); };
function eqJ(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Failure(`${msg}\n      expected: ${e.slice(0, 900)}\n      got:      ${(a ?? "undefined").slice(0, 900)}`);
}
const canon = (x) => Array.isArray(x) ? x.map(canon) : x && typeof x === "object"
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
const same = (a, e, msg) => eqJ(canon(a), canon(e), msg);

async function req(method, path, { account, body, raw, actor } = {}) {
  const h = {};
  if (account !== null) h["X-Account-Id"] = account;
  if (actor) h["X-Actor"] = actor;
  let payload;
  if (raw !== undefined) { payload = raw; h["Content-Type"] = "application/json"; }
  else if (body !== undefined) { payload = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  const res = await fetch(BASE_URL + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, json, headers: res.headers };
}
function expectError(r, status, code, ctx) {
  eqJ(r.status, status, `${ctx}: status (${r.text.slice(0, 400)})`);
  check(r.json?.error?.code === code, `${ctx}: error.code ${code}`, r.json ?? r.text.slice(0, 200));
  return r.json.error;
}
const fieldsOf = (err) => (err.details ?? []).map((d) => d.field);
function expectField(err, field, ctx) {
  check(fieldsOf(err).includes(field), `${ctx}: details should include field "${field}"`, fieldsOf(err));
}

// ---------------- fixtures ----------------
const ATTRS = [
  { key: "person/email", type: "string", unique: true },
  { key: "person/nickname", type: "string" },
  { key: "employee/work_state", type: "enum", values: ["CA", "CO", "NY"] },
  { key: "employee/salary", type: "number", label: "Salary" },
  { key: "employee/start_date", type: "date" },
  { key: "employee/remote", type: "boolean", unique: false },
  { key: "employee/level", type: "integer" },
];
const EMPLOYEE = { key: "employee", label: "Employee",
  attributes: ["person/email", "person/nickname", "employee/work_state", "employee/salary",
    "employee/start_date", "employee/remote", "employee/level"],
  required: ["person/email"] };
const CONTRACTOR = { key: "contractor", attributes: ["person/email", "person/nickname"] };
const C = (fact, operator, value, extra = {}) => ({ fact, operator, ...(value === undefined ? {} : { value }), ...extra });
const POLICIES = [
  { id: "colorado", name: "Colorado withholding", shape: "employee",
    applies_when: C("employee/work_state", "equal", "CO"), requires: [{ form: "co-dr0004" }, { form: "w-4" }] },
  { id: "high-earner", name: "Non-solicit", shape: "employee",
    applies_when: C("employee/salary", "greaterThanInclusive", 100000), requires: [{ form: "non-solicit" }] },
  { id: "remote", name: "Remote kit", shape: "employee", applies_when: true,
    requires: [{ form: "remote-kit", when: C("employee/remote", "equal", true) },
               { form: "office-badge", when: { not: C("employee/remote", "equal", true) } }] },
];
const AUTOMATIONS = [
  { id: "co-onboarding", shape: "employee", on: { changed: ["employee/work_state"] },
    when: C("employee/work_state", "equal", "CO"),
    do: [{ op: "send_form", form: "co-dr0004" }, { op: "notify", message: "Colorado hire" },
         { op: "set", attribute: "employee/salary", value: 50000 }] },
  { id: "salary-watch", shape: "employee", on: { changed: ["employee/salary"] },
    do: [{ op: "notify", message: "salary changed" }] },
];
const REGISTRY = { attributes: ATTRS, shapes: [EMPLOYEE, CONTRACTOR], policies: POLICIES, automations: AUTOMATIONS };

// Other enabled packs may add collections; they must be empty arrays here and are otherwise ignored.
const CORE_KEYS = ["version", "attributes", "shapes", "policies", "automations"];
function known(doc, ctx) {
  for (const [k, v] of Object.entries(doc ?? {}))
    if (!CORE_KEYS.includes(k)) check(Array.isArray(v) && v.length === 0, `${ctx}: extra collection ${k} must be []`, v);
  return Object.fromEntries(Object.entries(doc ?? {}).filter(([k]) => CORE_KEYS.includes(k)));
}
const getReg = (account) => req("GET", "/v2/registry", { account });
const plan = (account, doc, base_version) => req("POST", "/v2/registry/plan", { account, body: { ...(base_version === undefined ? {} : { base_version }), ...doc } });
const put = (account, base_version, doc, actor) => req("PUT", "/v2/registry", { account, body: { base_version, ...doc }, actor });
async function putOk(account, base, doc, actor) {
  const r = await put(account, base, doc, actor);
  eqJ(r.status, 200, `PUT registry (${r.text.slice(0, 500)})`);
  return r.json;
}
const create = (account, shape, facts, actor) => req("POST", "/v2/entities", { account, body: { shape, facts }, actor });
async function createOk(account, shape, facts, actor) {
  const r = await create(account, shape, facts, actor);
  eqJ(r.status, 201, `create ${shape} (${r.text.slice(0, 500)})`);
  return r.json;
}
const patch = (account, id, facts, expected_version, actor) =>
  req("PATCH", `/v2/entities/${id}`, { account, body: { facts, ...(expected_version === undefined ? {} : { expected_version }) }, actor });
async function patchOk(account, id, facts, ev, actor) {
  const r = await patch(account, id, facts, ev, actor);
  eqJ(r.status, 200, `patch (${r.text.slice(0, 500)})`);
  return r.json;
}
const effectsOf = (e) => e.effects.map(({ automation_id, op, form, message, attribute, value }) =>
  canon({ automation_id, op, ...(form !== undefined ? { form } : {}), ...(message !== undefined ? { message } : {}),
    ...(attribute !== undefined ? { attribute } : {}), ...(value !== undefined ? { value } : {}) }));

// ---------------- cases ----------------
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("health and empty registry", async () => {
  const h = await req("GET", "/healthz", { account: null });
  eqJ(h.status, 200, "healthz");
  const a = newAccount();
  const r = await getReg(a);
  eqJ(r.status, 200, "GET empty registry");
  same(known(r.json, "empty"), { version: 0, attributes: [], shapes: [], policies: [], automations: [] }, "empty registry");
});

test("registry: put, round-trip, no inserted defaults", async () => {
  const a = newAccount();
  const r = await putOk(a, 0, REGISTRY, "ada");
  eqJ(r.version, 1, "version after first PUT");
  same({ ...known(r, "PUT"), version: undefined }, { ...REGISTRY, version: undefined }, "PUT response round-trips");
  const g = await getReg(a);
  same(known(g.json, "GET"), { version: 1, ...REGISTRY }, "GET round-trips exactly");
  const again = await putOk(a, 1, REGISTRY);
  eqJ(again.version, 2, "every successful PUT increments version");
});

test("registry: structural 422 on both plan and PUT", async () => {
  const a = newAccount();
  const bad = [
    [{ ...REGISTRY, attributes: [{ key: "Email", type: "string" }, ...ATTRS] }, "attributes[0].key"],
    [{ ...REGISTRY, attributes: [{ key: "x/state", type: "enum" }, ...ATTRS] }, "attributes[0].values"],
    [{ ...REGISTRY, attributes: [{ key: "x/n", type: "number", values: ["a"] }, ...ATTRS] }, "attributes[0].values"],
    [{ ...REGISTRY, attributes: [{ key: "x/n", type: "decimal" }, ...ATTRS] }, "attributes[0].type"],
    [{ ...REGISTRY, attributes: [{ key: "x/n", type: "string", colour: "red" }, ...ATTRS] }, "attributes[0].colour"],
    [{ ...REGISTRY, attributes: [...ATTRS, { key: "person/email", type: "string" }] }, `attributes[${ATTRS.length}].key`],
    [{ ...REGISTRY, shapes: [EMPLOYEE, { ...CONTRACTOR, key: "employee" }] }, "shapes[1].key"],
    [{ ...REGISTRY, policies: [POLICIES[0], { ...POLICIES[1], id: "colorado" }] }, "policies[1].id"],
    [{ ...REGISTRY, automations: [{ ...AUTOMATIONS[0], do: [{ op: "launch", form: "x" }] }] }, "automations[0].do[0].op"],
    [{ ...REGISTRY, policies: [{ ...POLICIES[0], applies_when: C("employee/work_state", "equals", "CO") }] }, "policies[0].applies_when.operator"],
  ];
  for (const [doc, field] of bad) {
    expectField(expectError(await plan(a, doc), 422, "validation_failed", `plan ${field}`), field, `plan ${field}`);
    expectField(expectError(await put(a, 0, doc), 422, "validation_failed", `PUT ${field}`), field, `PUT ${field}`);
  }
  const m = await req("PUT", "/v2/registry", { account: a, raw: "{nope" });
  expectError(m, 400, "bad_request", "malformed JSON");
  eqJ((await getReg(a)).json.version, 0, "nothing stored");
});

test("registry: reference issues — plan explains (200), PUT refuses (422), document order", async () => {
  const a = newAccount();
  const doc = {
    attributes: ATTRS,
    shapes: [{ key: "employee", attributes: ["person/email", "employee/ghost", "employee/work_state", "employee/salary"],
               required: ["employee/remote"] }],
    policies: [
      { id: "p0", name: "unknown fact", shape: "employee", applies_when: C("person/nickname", "exists"), requires: [{ form: "f" }] },
      { id: "p1", name: "typed", shape: "employee",
        applies_when: C("employee/work_state", "lessThan", "CO"),
        requires: [{ form: "f", when: C("person/email", "equal", 5) }] },
      { id: "p2", name: "no shape", shape: "manager", applies_when: true, requires: [{ form: "f" }] },
    ],
    automations: [
      { id: "a0", shape: "employee", on: { changed: ["employee/level"] },
        do: [{ op: "set", attribute: "employee/salary", value: "lots" }, { op: "set", attribute: "employee/work_state", value: "TX" }] },
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
  const p = await plan(a, doc);
  eqJ(p.status, 200, `plan status (${p.text.slice(0, 300)})`);
  eqJ(p.json.applicable, false, "not applicable");
  eqJ(p.json.from_version, 0, "from_version"); eqJ(p.json.to_version, 1, "to_version");
  eqJ(p.json.issues.map((i) => i.field), expected, "issue fields in document order");
  check(p.json.issues.every((i) => typeof i.issue === "string" && i.issue.length > 0), "issue text", p.json.issues);
  const e = expectError(await put(a, 0, doc), 422, "validation_failed", "PUT with reference issues");
  eqJ(fieldsOf(e), expected, "PUT details = plan issues");
  eqJ((await getReg(a)).json.version, 0, "nothing stored");
});

test("registry: stale base 409; plan ignores base; change list", async () => {
  const a = newAccount();
  await putOk(a, 0, REGISTRY);
  expectError(await put(a, 0, REGISTRY), 409, "conflict", "stale base_version");
  const noop = await plan(a, REGISTRY, 0);
  eqJ(noop.status, 200, "plan with stale base still plans");
  same({ applicable: noop.json.applicable, changes: noop.json.changes, issues: noop.json.issues, violations: noop.json.violations },
    { applicable: true, changes: [], issues: [], violations: [] }, "no-op plan");
  const desired = {
    attributes: [...ATTRS.filter((x) => x.key !== "employee/level"), { key: "employee/title", type: "string" },
    ],
    shapes: [{ ...EMPLOYEE, attributes: [...EMPLOYEE.attributes.filter((k) => k !== "employee/level"), "employee/title"] }],
    policies: [POLICIES[0], { ...POLICIES[1], name: "Non-solicit agreement" }],
    automations: AUTOMATIONS,
  };
  desired.attributes = desired.attributes.map((x) => x.key === "person/nickname" ? { ...x, label: "Nickname" } : x);
  const p = await plan(a, desired);
  eqJ(p.json.issues, [], "desired is valid");
  eqJ(p.json.changes, [
    { kind: "attribute", key: "employee/level", change: "removed" },
    { kind: "attribute", key: "employee/title", change: "added" },
    { kind: "attribute", key: "person/nickname", change: "modified" },
    { kind: "shape", key: "contractor", change: "removed" },
    { kind: "shape", key: "employee", change: "modified" },
    { kind: "policy", key: "high-earner", change: "modified" },
    { kind: "policy", key: "remote", change: "removed" },
  ], "changes sorted by kind then key");
  eqJ(p.json.applicable, true, "applicable (no live entities)");
});

test("impact: removing an attribute shows every dependent document", async () => {
  const a = newAccount();
  await putOk(a, 0, REGISTRY);
  const desired = {
    ...REGISTRY,
    attributes: ATTRS.filter((x) => x.key !== "employee/work_state"),
    shapes: [{ ...EMPLOYEE, attributes: EMPLOYEE.attributes.filter((k) => k !== "employee/work_state") }, CONTRACTOR],
  };
  const p = await plan(a, desired);
  eqJ(p.status, 200, "plan 200");
  eqJ(p.json.applicable, false, "not applicable");
  eqJ(p.json.issues.map((i) => i.field), [
    "policies[0].applies_when.fact",
    "automations[0].on.changed[0]",
    "automations[0].when.fact",
  ], "every reference to the removed attribute");
  expectError(await put(a, 1, desired), 422, "validation_failed", "PUT refuses");
});

test("entities: create, Location, validation, registry_version", async () => {
  const a = newAccount();
  await putOk(a, 0, { ...REGISTRY, automations: [] });
  const r = await create(a, "employee", { "person/email": "ada@x.co", "employee/work_state": "CA", "employee/level": 3, "person/nickname": null });
  eqJ(r.status, 201, `create (${r.text.slice(0, 300)})`);
  const e = r.json;
  check(ID_RE.test(e.id), "id format", e.id);
  eqJ(r.headers.get("location"), `/v2/entities/${e.id}`, "Location");
  same({ shape: e.shape, facts: e.facts, version: e.version, registry_version: e.registry_version, effects: e.effects },
    { shape: "employee", facts: { "person/email": "ada@x.co", "employee/work_state": "CA", "employee/level": 3 }, version: 1, registry_version: 1, effects: [] },
    "created entity (null omitted)");
  check(TS_RE.test(e.created_at) && e.created_at === e.updated_at, "timestamps", e);
  const g = await req("GET", `/v2/entities/${e.id}`, { account: a });
  eqJ(g.status, 200, "GET");
  same(g.json, Object.fromEntries(Object.entries(e).filter(([k]) => k !== "effects")), "GET equals create minus effects");
  expectError(await req("GET", `/v2/entities/${e.id}`, { account: newAccount() }), 404, "not_found", "other account");
  const bad = [
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
    expectField(expectError(await create(a, shape, facts), 422, "validation_failed", `create ${field}`), field, `create ${field}`);
  }
});

test("entities: PATCH, retract, no-op, expected_version, empty facts", async () => {
  const a = newAccount();
  await putOk(a, 0, { ...REGISTRY, automations: [] });
  const e = await createOk(a, "employee", { "person/email": "ada@x.co", "employee/salary": 10 });
  const p = await patchOk(a, e.id, { "employee/salary": null, "employee/remote": true }, 1);
  same({ facts: p.facts, version: p.version, effects: p.effects },
    { facts: { "person/email": "ada@x.co", "employee/remote": true }, version: 2, effects: [] }, "patched");
  check(p.updated_at > e.updated_at, "updated_at advances", p);
  const n = await patchOk(a, e.id, { "employee/remote": true, "employee/salary": null });
  eqJ([n.version, n.updated_at], [2, p.updated_at], "no-op PATCH changes nothing");
  expectError(await patch(a, e.id, { "employee/level": 2 }, 1), 409, "conflict", "stale expected_version");
  expectField(expectError(await patch(a, e.id, {}), 422, "validation_failed", "empty facts"), "facts", "empty facts");
  expectField(expectError(await patch(a, e.id, { "person/email": null }), 422, "validation_failed", "retract required"), "facts.person/email", "retract required");
  expectError(await patch(a, "en_AAAAAAAAAAAAAAAAAAAAA", { "employee/level": 2 }), 404, "not_found", "unknown id");
});

test("automations: trigger on changed attribute, when, effects, outbox, depth 1", async () => {
  const a = newAccount();
  await putOk(a, 0, REGISTRY);
  const e = await createOk(a, "employee", { "person/email": "ada@x.co", "employee/work_state": "CA" });
  eqJ(e.effects, [], "CA hire: co-onboarding's when is F, salary-watch not triggered");
  const p = await patchOk(a, e.id, { "employee/work_state": "CO" }, undefined, "hr");
  eqJ(effectsOf(p), [
    { automation_id: "co-onboarding", form: "co-dr0004", op: "send_form" },
    { automation_id: "co-onboarding", message: "Colorado hire", op: "notify" },
    { attribute: "employee/salary", automation_id: "co-onboarding", op: "set", value: 50000 },
  ], "effects in order; the set does not trigger salary-watch (depth 1)");
  eqJ(p.facts["employee/salary"], 50000, "set applied");
  const o = await req("GET", "/v2/outbox", { account: a });
  eqJ(o.status, 200, "outbox");
  eqJ(o.json.data.map(({ entity_id, automation_id, op, form, message }) => canon({ entity_id, automation_id, op, ...(form ? { form } : {}), ...(message ? { message } : {}) })), [
    { automation_id: "co-onboarding", entity_id: e.id, form: "co-dr0004", op: "send_form" },
    { automation_id: "co-onboarding", entity_id: e.id, message: "Colorado hire", op: "notify" },
  ], "outbox has send_form and notify only");
  check(o.json.data[0].seq < o.json.data[1].seq && TS_RE.test(o.json.data[0].at), "seq increases", o.json.data);
  const s = await patchOk(a, e.id, { "employee/salary": 60000 });
  eqJ(effectsOf(s), [{ automation_id: "salary-watch", message: "salary changed", op: "notify" }], "API salary change triggers salary-watch");
  const n = await patchOk(a, e.id, { "person/nickname": "A" });
  eqJ(n.effects, [], "unrelated attribute triggers nothing");
  const c = await createOk(a, "employee", { "person/email": "bo@x.co", "employee/work_state": "CO" });
  eqJ(effectsOf(c).map((x) => x.automation_id), ["co-onboarding", "co-onboarding", "co-onboarding"], "create counts as change");
  const contractor = await createOk(a, "contractor", { "person/email": "cy@x.co" });
  eqJ(contractor.effects, [], "automations are per shape");
});

test("automations: when sees earlier automations' sets; outbox paging", async () => {
  const a = newAccount();
  const autos = [
    { id: "first", shape: "employee", on: { changed: ["employee/work_state"] }, do: [{ op: "set", attribute: "employee/level", value: 2 }] },
    { id: "second", shape: "employee", on: { changed: ["employee/work_state"] }, when: C("employee/level", "equal", 2),
      do: [{ op: "notify", message: "level 2" }] },
  ];
  await putOk(a, 0, { ...REGISTRY, policies: [], automations: autos });
  const e = await createOk(a, "employee", { "person/email": "ada@x.co", "employee/work_state": "NY" });
  eqJ(effectsOf(e).map((x) => `${x.automation_id}:${x.op}`), ["first:set", "second:notify"], "second sees first's set");
  for (const s of ["CA", "CO", "NY", "CA"]) await patchOk(a, e.id, { "employee/work_state": s });
  const all = [];
  let after = undefined;
  for (let i = 0; i < 10; i++) {
    const r = await req("GET", `/v2/outbox?limit=2${after === undefined ? "" : `&after=${after}`}`, { account: a });
    eqJ(r.status, 200, "outbox page");
    if (r.json.data.length === 0) { eqJ(r.json.next_after, null, "empty page next_after null"); break; }
    all.push(...r.json.data);
    eqJ(r.json.next_after, r.json.data.at(-1).seq, "next_after = last seq");
    after = r.json.next_after;
  }
  eqJ(all.length, 5, "5 notifies across pages");
  check(all.every((x, i) => i === 0 || x.seq > all[i - 1].seq), "strictly increasing", all.map((x) => x.seq));
  expectField(expectError(await req("GET", "/v2/outbox?limit=0", { account: a }), 422, "validation_failed", "limit 0"), "limit", "limit");
});

test("uniqueness is per attribute, across shapes, among live entities", async () => {
  const a = newAccount();
  await putOk(a, 0, { ...REGISTRY, automations: [] });
  const e = await createOk(a, "employee", { "person/email": "ada@x.co" });
  expectField(expectError(await create(a, "contractor", { "person/email": "ada@x.co" }), 409, "conflict", "dup across shapes"), "facts.person/email", "dup");
  await createOk(a, "employee", { "person/email": "Ada@x.co" });
  await createOk(a, "contractor", { "person/nickname": "same" });
  await createOk(a, "contractor", { "person/nickname": "same" });
  eqJ((await req("DELETE", `/v2/entities/${e.id}`, { account: a })).status, 204, "delete");
  await createOk(a, "contractor", { "person/email": "ada@x.co" });
});

test("history, as_of and delete from the facts log", async () => {
  const a = newAccount();
  await putOk(a, 0, REGISTRY);
  const e = await createOk(a, "employee", { "person/email": "ada@x.co", "employee/work_state": "CA" }, "ada");
  await sleep(5);
  const p1 = await patchOk(a, e.id, { "employee/work_state": "CO" }, undefined, "hr");
  await sleep(5);
  const p2 = await patchOk(a, e.id, { "employee/salary": null }, undefined, "hr");
  const h = await req("GET", `/v2/entities/${e.id}/history`, { account: a });
  eqJ(h.status, 200, "history");
  const rows = h.json.data.map(({ attribute, op, value, reason, actor }) => ({ attribute, op, value, reason, actor }));
  eqJ(rows, [
    { attribute: "employee/work_state", op: "assert", value: "CA", reason: "api", actor: "ada" },
    { attribute: "person/email", op: "assert", value: "ada@x.co", reason: "api", actor: "ada" },
    { attribute: "employee/work_state", op: "assert", value: "CO", reason: "api", actor: "hr" },
    { attribute: "employee/salary", op: "assert", value: 50000, reason: "automation", actor: "automation:co-onboarding" },
    { attribute: "employee/salary", op: "retract", value: 50000, reason: "api", actor: "hr" },
  ], "history rows (tx, then attribute)");
  const txs = h.json.data.map((x) => x.tx);
  check(txs.every((t, i) => i === 0 || t >= txs[i - 1]) && txs[0] < txs[2], "tx ordering", txs);
  check(h.json.data.every((x) => TS_RE.test(x.at)), "at format", h.json.data);
  const at = async (ts) => req("GET", `/v2/entities/${e.id}?as_of=${encodeURIComponent(ts)}`, { account: a });
  const v1 = await at(e.created_at);
  eqJ(v1.status, 200, "as_of creation");
  same(v1.json.facts, { "person/email": "ada@x.co", "employee/work_state": "CA" }, "as_of creation facts");
  eqJ(v1.json.version, 1, "as_of version");
  const v2 = await at(p1.updated_at);
  same(v2.json.facts, { "person/email": "ada@x.co", "employee/work_state": "CO", "employee/salary": 50000 }, "as_of after automation");
  expectError(await at(new Date(Date.parse(e.created_at) - 1000).toISOString()), 404, "not_found", "before creation");
  expectField(expectError(await at("yesterday"), 422, "validation_failed", "bad as_of"), "as_of", "as_of");
  eqJ((await req("DELETE", `/v2/entities/${e.id}`, { account: a })).status, 204, "delete");
  expectError(await req("GET", `/v2/entities/${e.id}`, { account: a }), 404, "not_found", "deleted");
  same((await at(p2.updated_at)).json?.facts, { "person/email": "ada@x.co", "employee/work_state": "CO" }, "as_of before delete");
  eqJ((await req("GET", `/v2/entities/${e.id}/history`, { account: a })).status, 200, "history of deleted entity");
  expectError(await req("DELETE", `/v2/entities/${e.id}`, { account: a }), 404, "not_found", "delete twice");
});

test("evaluate: three-valued policies over facts", async () => {
  const a = newAccount();
  await putOk(a, 0, { ...REGISTRY, automations: [] });
  const ev = async (id) => { const r = await req("POST", `/v2/entities/${id}/evaluate`, { account: a }); eqJ(r.status, 200, "evaluate"); return r.json; };
  const e1 = await createOk(a, "employee", { "person/email": "a@x.co", "employee/work_state": "CO" });
  same(await ev(e1.id), { required: ["co-dr0004", "w-4"], undetermined: ["non-solicit", "office-badge", "remote-kit"] }, "missing salary and remote are unknown");
  await patchOk(a, e1.id, { "employee/salary": 150000, "employee/remote": false });
  same(await ev(e1.id), { required: ["co-dr0004", "non-solicit", "office-badge", "w-4"], undetermined: [] }, "all known");
  const e2 = await createOk(a, "employee", { "person/email": "b@x.co", "employee/work_state": "NY", "employee/salary": 10, "employee/remote": true });
  same(await ev(e2.id), { required: ["remote-kit"], undetermined: [] }, "NY remote");
  const c = await createOk(a, "contractor", { "person/email": "c@x.co" });
  same(await ev(c.id), { required: [], undetermined: [] }, "no policies for contractor");
});

test("registry evolution: violations, 409, migration retracts", async () => {
  const a = newAccount();
  await putOk(a, 0, { ...REGISTRY, automations: [] });
  const e1 = await createOk(a, "employee", { "person/email": "a@x.co", "person/nickname": "dup", "employee/level": 3 });
  const e2 = await createOk(a, "employee", { "person/email": "b@x.co", "person/nickname": "dup", "employee/salary": 5, "employee/level": 4 });
  const c = await createOk(a, "contractor", { "person/email": "c@x.co" });
  const [lo, hi] = [e1.id, e2.id].sort();
  const desired = {
    ...REGISTRY, automations: [],
    attributes: ATTRS.map((x) => x.key === "person/nickname" ? { ...x, unique: true } : x),
    shapes: [{ ...EMPLOYEE, required: ["person/email", "employee/salary"] }],
  };
  const p = await plan(a, desired);
  eqJ(p.json.issues, [], "no static issues");
  const expected = [
    { entity_id: c.id, field: "shape" },
    { entity_id: e1.id, field: "facts.employee/salary" },
    { entity_id: hi, field: "facts.person/nickname" },
  ].sort((x, y) => (x.entity_id < y.entity_id ? -1 : x.entity_id > y.entity_id ? 1 : x.field < y.field ? -1 : 1));
  eqJ(p.json.violations.map(({ entity_id, field }) => ({ entity_id, field })), expected, "violations sorted");
  check(!p.json.violations.some((v) => v.entity_id === lo && v.field === "facts.person/nickname"), "lowest id keeps the value");
  eqJ(p.json.applicable, false, "not applicable");
  const e = expectError(await put(a, 1, desired), 409, "conflict", "PUT with violations");
  same(fieldsOf(e).sort(), expected.map((v) => `${v.entity_id}.${v.field}`).sort(), "PUT details");
  // Removing an attribute from the shape retracts its facts, audited as migration.
  const shrink = { ...REGISTRY, automations: [], policies: REGISTRY.policies.filter((x) => x.id !== "high-earner"),
    attributes: ATTRS.filter((x) => x.key !== "employee/level" && x.key !== "employee/salary"),
    shapes: [{ ...EMPLOYEE, attributes: EMPLOYEE.attributes.filter((k) => k !== "employee/level" && k !== "employee/salary") }, CONTRACTOR] };
  const ps = await plan(a, shrink);
  same({ applicable: ps.json.applicable, issues: ps.json.issues, violations: ps.json.violations }, { applicable: true, issues: [], violations: [] }, "shrink plan");
  const r = await putOk(a, 1, shrink, "admin");
  eqJ(r.version, 2, "applied");
  const g = await req("GET", `/v2/entities/${e2.id}`, { account: a });
  same(g.json.facts, { "person/email": "b@x.co", "person/nickname": "dup" }, "facts dropped");
  eqJ(g.json.registry_version, 2, "registry_version follows the migration write");
  const h = await req("GET", `/v2/entities/${e2.id}/history`, { account: a });
  eqJ(h.json.data.filter((x) => x.reason === "migration").map(({ attribute, op, value, actor }) => ({ attribute, op, value, actor })), [
    { attribute: "employee/level", op: "retract", value: 4, actor: "admin" },
    { attribute: "employee/salary", op: "retract", value: 5, actor: "admin" },
  ], "migration retracts");
  eqJ(c.registry_version, 1, "sanity");
});

test("concurrency: parallel writers in one account; unique race", async () => {
  const a = newAccount();
  await putOk(a, 0, { ...REGISTRY, automations: [] });
  const es = [];
  for (let i = 0; i < 10; i++) es.push(await createOk(a, "employee", { "person/email": `p${i}@x.co` }));
  const rs = await Promise.all(es.map((e, i) => patch(a, e.id, { "employee/level": i })));
  eqJ(rs.map((r) => r.status), es.map(() => 200), "all parallel PATCHes succeed");
  const race = await Promise.all([create(a, "employee", { "person/email": "race@x.co" }), create(a, "contractor", { "person/email": "race@x.co" })]);
  eqJ(race.map((r) => r.status).sort(), [201, 409], "exactly one wins the unique race");
  const regs = await Promise.all([put(a, 1, REGISTRY), put(a, 1, REGISTRY), put(a, 1, REGISTRY)]);
  eqJ(regs.map((r) => r.status).sort(), [200, 409, 409], "registry CAS");
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
