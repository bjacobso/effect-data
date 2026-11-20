// End-to-end demo: onboarding at a small delivery company, told through the
// public HTTP API only. Nothing here imports from src/: it is what an external
// client written with Effect would look like.
//
//   make run                                   # in one terminal
//   BASE_URL=http://localhost:8086 node demo/onboarding.ts
import { randomBytes } from "node:crypto";
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Data, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

// ---------------------------------------------------------------- client

const baseUrl = (process.env.BASE_URL ?? "http://localhost:8086").replace(/\/$/, "");
const account = `acct_demo_${randomBytes(4).toString("hex")}`;

class Unexpected extends Data.TaggedError("Unexpected")<{ message: string }> {}

const Facts = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));
const Entity = Schema.Struct({
  id: Schema.String,
  shape: Schema.String,
  facts: Facts,
  version: Schema.Int,
  updated_at: Schema.String,
  violations: Schema.optionalKey(Schema.Array(Schema.Struct({ attribute: Schema.String, issue: Schema.String }))),
  effects: Schema.optionalKey(Schema.Array(Schema.Struct({ automation_id: Schema.String, op: Schema.String }))),
});
const Registry = Schema.Struct({
  version: Schema.Int,
  rollout: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ version: Schema.Int, status: Schema.String, processed: Schema.Int, total: Schema.Int })),
  ),
});
const Plan = Schema.Struct({
  applicable: Schema.Boolean,
  changes: Schema.Array(Schema.Struct({ kind: Schema.String, key: Schema.String, change: Schema.String })),
  violations: Schema.Array(
    Schema.Struct({ entity_id: Schema.String, field: Schema.String, issue: Schema.String, blocking: Schema.Boolean }),
  ),
});
const Evaluate = Schema.Struct({ required: Schema.Array(Schema.String), undetermined: Schema.Array(Schema.String) });
const Certifications = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      requirement: Schema.String,
      status: Schema.String,
      expires: Schema.optionalKey(Schema.String),
      renew_by: Schema.optionalKey(Schema.String),
    }),
  ),
});
const History = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      tx: Schema.Int,
      attribute: Schema.String,
      op: Schema.String,
      value: Schema.Unknown,
      reason: Schema.String,
      actor: Schema.String,
    }),
  ),
});
const Outbox = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      seq: Schema.Int,
      entity_id: Schema.String,
      automation_id: Schema.NullOr(Schema.String),
      op: Schema.String,
      form: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      issue: Schema.optionalKey(Schema.String),
    }),
  ),
});
const Violations = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      entity_id: Schema.String,
      attribute: Schema.String,
      issue: Schema.String,
      value: Schema.Unknown,
      status: Schema.String,
    }),
  ),
});
const Referrers = Schema.Struct({
  data: Schema.Array(Schema.Struct({ entity_id: Schema.String, attribute: Schema.String, on_delete: Schema.String })),
});
const ApiError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optionalKey(Schema.Array(Schema.Struct({ field: Schema.String, issue: Schema.String }))),
  }),
});

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Send a request and decode a successful reply with `schema`. Any other status is a failure. */
const call = <A>(schema: Schema.Codec<A>, method: Method, path: string, body?: unknown, actor?: string) =>
  Effect.gen(function* () {
    const { status, text } = yield* send(method, path, body, actor);
    if (status >= 300) return yield* new Unexpected({ message: `${method} ${path} → ${status} ${text}` });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text);
  });

/** Send a request we expect to be refused, and decode the error body. */
const refused = (expected: number, method: Method, path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { status, text } = yield* send(method, path, body);
    if (status !== expected) return yield* new Unexpected({ message: `${method} ${path}: expected ${expected}, got ${status} ${text}` });
    return (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApiError))(text)).error;
  });

const send = (method: Method, path: string, body?: unknown, actor?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(method)(baseUrl + path).pipe(HttpClientRequest.setHeader("X-Account-Id", account));
    if (actor) request = HttpClientRequest.setHeader(request, "X-Actor", actor);
    if (body !== undefined) request = HttpClientRequest.bodyText(request, JSON.stringify(body), "application/json");
    const response = yield* client.execute(request);
    return { status: response.status, text: yield* response.text };
  });

// ---------------------------------------------------------------- narration

let stepNo = 0;
const step = (title: string) => Effect.sync(() => console.log(`\n\x1b[1m${++stepNo}. ${title}\x1b[0m`));
const say = (text: string) => Effect.sync(() => console.log(`   ${text}`));
const http = (line: string) => Effect.sync(() => console.log(`   \x1b[2m${line}\x1b[0m`));
const names = new Map<string, string>();
const who = (id: string) => names.get(id) ?? id;
const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "—");

// ---------------------------------------------------------------- the story

const C = (fact: string, operator: string, value?: unknown) => ({ fact, operator, ...(value === undefined ? {} : { value }) });

const registry = {
  attributes: [
    { key: "person/name", type: "string" },
    { key: "person/email", type: "string" },
    { key: "person/nickname", type: "string" },
    { key: "employee/work_state", type: "enum", values: ["CA", "CO", "NY"] },
    { key: "employee/role", type: "enum", values: ["driver", "office"] },
    { key: "employee/forklift_expires", type: "date", label: "Forklift licence expires" },
    { key: "employee/location", type: "ref", target: "location", on_delete: "block" },
    { key: "location/name", type: "string" },
  ],
  shapes: [
    { key: "location", attributes: ["location/name"], required: ["location/name"] },
    {
      key: "employee",
      attributes: [
        "person/name",
        "person/email",
        "person/nickname",
        "employee/work_state",
        "employee/role",
        "employee/forklift_expires",
        "employee/location",
      ],
      required: ["person/name", "person/email"],
    },
  ],
  policies: [
    {
      id: "colorado",
      name: "Colorado hires",
      shape: "employee",
      applies_when: C("employee/work_state", "equal", "CO"),
      requires: [{ form: "co-dr0004" }, { form: "co-driver-cert", when: C("employee/role", "equal", "driver") }],
    },
  ],
  certification_requirements: [
    {
      id: "forklift",
      name: "Forklift licence",
      shape: "employee",
      expires: "employee/forklift_expires",
      renew_within_days: 30,
      applies_when: C("employee/role", "equal", "driver"),
    },
  ],
  automations: [
    {
      id: "co-hire",
      shape: "employee",
      on: { changed: ["employee/work_state"] },
      when: C("employee/work_state", "equal", "CO"),
      do: [
        { op: "send_form", form: "co-dr0004" },
        { op: "notify", message: "New Colorado hire" },
      ],
    },
  ],
};

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const demo = Effect.gen(function* () {
  console.log(`effect-data demo against ${baseUrl}, account ${account}`);

  // 1 ---------------------------------------------------------------------
  yield* step("Describe the business as data: one registry document");
  yield* http("PUT /v2/registry");
  const v1 = yield* call(Registry, "PUT", "/v2/registry", { base_version: 0, ...registry });
  yield* say(`Registry is at version ${v1.version}: 8 attributes, 2 shapes (employee, location), a Colorado`);
  yield* say(`policy, a forklift-licence requirement and an automation for Colorado hires. No code, no deploy.`);

  // 2 ---------------------------------------------------------------------
  yield* step("Add a location and four employees");
  const create = (shape: string, facts: object, label: string) =>
    call(Entity, "POST", "/v2/entities", { shape, facts }, "hr:maria").pipe(Effect.tap((e) => Effect.sync(() => names.set(e.id, label))));
  const denver = yield* create("location", { "location/name": "Denver depot" }, "Denver depot");
  const ana = yield* create(
    "employee",
    {
      "person/name": "Ana",
      "person/email": "ana@acme.co",
      "employee/work_state": "CO",
      "employee/role": "driver",
      "employee/forklift_expires": day(10),
      "employee/location": denver.id,
    },
    "Ana",
  );
  const ben = yield* create(
    "employee",
    {
      "person/name": "Ben",
      "person/email": "ben@acme.co",
      "employee/work_state": "CO",
      "employee/role": "office",
      "employee/location": denver.id,
    },
    "Ben",
  );
  const cy = yield* create("employee", { "person/name": "Cy", "person/email": "cy@acme.co", "employee/work_state": "CO" }, "Cy");
  const dee = yield* create(
    "employee",
    { "person/name": "Dee", "person/email": "ana@acme.co", "employee/work_state": "CA", "employee/role": "driver" },
    "Dee",
  );
  yield* http("POST /v2/entities ×5");
  yield* say(`Ana: Colorado driver, forklift licence expires ${day(10)}.  Ben: Colorado office.`);
  yield* say(`Cy: Colorado, role not known yet.  Dee: California driver, reusing Ana's email by mistake.`);
  yield* say(`Writing Ana ran the co-hire automation in the same transaction: ${list((ana.effects ?? []).map((e) => `${e.op}`))}.`);

  // 3 ---------------------------------------------------------------------
  yield* step("Which forms does each person need? (true / false / can't tell yet)");
  for (const e of [ana, ben, cy, dee]) {
    yield* http(`POST /v2/entities/${e.id}/evaluate`);
    const r = yield* call(Evaluate, "POST", `/v2/entities/${e.id}/evaluate`);
    yield* say(`${who(e.id).padEnd(4)} required: ${list(r.required).padEnd(28)} undetermined: ${list(r.undetermined)}`);
  }
  yield* say(`Cy's driver certificate is "undetermined", not "no": the rule depends on a role nobody has entered.`);

  // 4 ---------------------------------------------------------------------
  yield* step(`Certifications as of today (${day(0)})`);
  for (const e of [ana, ben, dee]) {
    const r = yield* call(Certifications, "POST", `/v2/entities/${e.id}/certifications`, { on: day(0) });
    for (const c of r.data)
      yield* say(`${who(e.id).padEnd(4)} ${c.requirement}: ${c.status}${c.renew_by ? ` (renew by ${c.renew_by})` : ""}`);
  }

  // 5 ---------------------------------------------------------------------
  yield* step("Fill in the missing fact, and the answer changes");
  const before = cy.updated_at;
  yield* http(`PATCH /v2/entities/${cy.id}  { employee/role: "driver" }   X-Actor: hr:maria`);
  yield* call(Entity, "PATCH", `/v2/entities/${cy.id}`, { facts: { "employee/role": "driver" } }, "hr:maria");
  const cyNow = yield* call(Evaluate, "POST", `/v2/entities/${cy.id}/evaluate`);
  yield* say(`Cy now requires: ${list(cyNow.required)}; undetermined: ${list(cyNow.undetermined)}`);

  // 6 ---------------------------------------------------------------------
  yield* step("Every change is kept: history and time travel");
  yield* http(`GET /v2/entities/${cy.id}?as_of=${before}`);
  const past = yield* call(Entity, "GET", `/v2/entities/${cy.id}?as_of=${encodeURIComponent(before)}`);
  yield* say(`Cy as of ${before}: role = ${past.facts["employee/role"] ?? "(absent)"}`);
  yield* http(`GET /v2/entities/${cy.id}/history`);
  const h = yield* call(History, "GET", `/v2/entities/${cy.id}/history`);
  for (const row of h.data)
    yield* say(
      `tx ${row.tx}  ${row.op.padEnd(6)} ${row.attribute.padEnd(20)} ${JSON.stringify(row.value).padEnd(14)} ${row.reason} by ${row.actor}`,
    );

  // 7 ---------------------------------------------------------------------
  yield* step("The outbox: work for other systems, written in the same transaction");
  yield* http("GET /v2/outbox");
  const out = yield* call(Outbox, "GET", "/v2/outbox");
  for (const o of out.data)
    yield* say(`#${o.seq} ${who(o.entity_id).padEnd(4)} ${o.op.padEnd(10)} ${o.form ?? o.message ?? ""}   (automation ${o.automation_id})`);

  // 8 ---------------------------------------------------------------------
  yield* step("Change the schema safely: make email unique");
  const v2doc = {
    ...registry,
    attributes: registry.attributes.map((a) => (a.key === "person/email" ? { ...a, unique: true } : a)),
  };
  yield* http("POST /v2/registry/plan");
  const plan = yield* call(Plan, "POST", "/v2/registry/plan", v2doc);
  for (const c of plan.changes) yield* say(`plan: ${c.kind} ${c.key} ${c.change}`);
  for (const v of plan.violations)
    yield* say(`plan: ${who(v.entity_id)} ${v.field}: ${v.issue}${v.blocking ? "" : " (will be recorded, not blocking)"}`);
  yield* http("PUT /v2/registry  (default mode: rollout)");
  const v2 = yield* call(Registry, "PUT", "/v2/registry", { base_version: v1.version, ...v2doc });
  yield* say(`Applied version ${v2.version} straight away; existing data is checked in the background.`);
  let rollout = v2.rollout;
  while (rollout?.status !== "done") {
    yield* Effect.sleep("50 millis");
    rollout = (yield* call(Registry, "GET", "/v2/registry")).rollout;
  }
  yield* say(`Rollout done: ${rollout.processed}/${rollout.total} entities checked.`);
  const open = yield* call(Violations, "GET", "/v2/violations?status=open");
  for (const v of open.data)
    yield* say(`violation #${v.id}: ${who(v.entity_id)} ${v.attribute} = ${JSON.stringify(v.value)} is a ${v.issue}`);
  const dup = yield* refused(409, "POST", "/v2/entities", {
    shape: "employee",
    facts: { "person/name": "Eve", "person/email": "ben@acme.co" },
  });
  yield* say(`A new duplicate is refused at once: ${dup.code} at ${list((dup.details ?? []).map((d) => d.field))}`);
  yield* http(`PATCH /v2/entities/${dee.id}  { person/email: "dee@acme.co" }`);
  yield* call(Entity, "PATCH", `/v2/entities/${dee.id}`, { facts: { "person/email": "dee@acme.co" } }, "hr:maria");
  const still = yield* call(Violations, "GET", "/v2/violations?status=open");
  yield* say(`Fixing Dee's email resolves the record in the same write. Open violations left: ${still.data.length}.`);
  const events = (yield* call(Outbox, "GET", "/v2/outbox")).data.filter((o) => o.automation_id === null);
  yield* say(`The outbox told the world: ${list(events.map((o) => `${o.op} (${who(o.entity_id)})`))}`);

  // 9 ---------------------------------------------------------------------
  yield* step("References keep the data whole");
  yield* http(`DELETE /v2/entities/${denver.id}`);
  const blocked = yield* refused(409, "DELETE", `/v2/entities/${denver.id}`);
  yield* say(
    `Deleting the Denver depot is refused (${blocked.code}): ${list((blocked.details ?? []).map((d) => `${who(d.field.split(".")[0]!)} ${d.issue.toLowerCase()}`))}`,
  );
  const refs = yield* call(Referrers, "GET", `/v2/entities/${denver.id}/referrers`);
  yield* say(`GET /referrers: ${list(refs.data.map((r) => `${who(r.entity_id)} via ${r.attribute} (on_delete ${r.on_delete})`))}`);

  // 10 --------------------------------------------------------------------
  yield* step("Removing a field hides it; nothing is destroyed");
  yield* call(Entity, "PATCH", `/v2/entities/${ana.id}`, { facts: { "person/nickname": "Annie" } }, "hr:maria");
  const without = {
    ...v2doc,
    shapes: v2doc.shapes.map((s) => (s.key === "employee" ? { ...s, attributes: s.attributes.filter((a) => a !== "person/nickname") } : s)),
  };
  const v3 = yield* call(Registry, "PUT", "/v2/registry", { base_version: v2.version, ...without });
  const hidden = yield* call(Entity, "GET", `/v2/entities/${ana.id}`);
  yield* say(`v${v3.version} drops nickname from employee: Ana's nickname reads as ${hidden.facts["person/nickname"] ?? "(hidden)"}`);
  const v4 = yield* call(Registry, "PUT", "/v2/registry", { base_version: v3.version, ...v2doc });
  const back = yield* call(Entity, "GET", `/v2/entities/${ana.id}`);
  yield* say(`v${v4.version} puts it back: "${back.facts["person/nickname"]}". The apply wrote no facts either way.`);

  console.log(`\nDone. Everything above is in account ${account}; explore it with X-Account-Id: ${account}`);
});

NodeRuntime.runMain(demo.pipe(Effect.provide(NodeHttpClient.layerUndici)));
