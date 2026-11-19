import { randomBytes } from "node:crypto";
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Cause, Data, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

const baseUrl = (process.env.BASE_URL ?? "").replace(/\/$/, "");
export const newAccount = () => `acct_${randomBytes(8).toString("hex")}`;
class ExpectationFailed extends Data.TaggedError("ExpectationFailed")<{ message: string }> {}
const fail = (message: string) => Effect.fail(new ExpectationFailed({ message }));
export const check = (condition: boolean, message: string, got?: unknown) =>
  condition ? Effect.void : fail(got === undefined ? message : `${message}\n      got: ${JSON.stringify(got).slice(0, 700)}`);
export const eqJ = (actual: unknown, expected: unknown, message: string) => {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expected);
  return check(a === e, `${message}\n      expected: ${e?.slice(0, 900)}\n      got:      ${a?.slice(0, 900)}`);
};
export const canon = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canon);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canon(v)]),
  );
};
export const same = (actual: unknown, expected: unknown, message: string) => eqJ(canon(actual), canon(expected), message);

const Issue = Schema.Struct({ field: Schema.String, issue: Schema.String });
const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals(["bad_request", "not_found", "conflict", "validation_failed"]),
    message: Schema.String,
    details: Schema.optionalKey(Schema.Array(Issue)),
  }),
});
const fromText = <A>(schema: Schema.Codec<A>) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
type Reply = { status: number; text: string; error?: typeof ErrorBody.Type.error };
export const req = <A>(
  schema: Schema.Codec<A>,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  { account, body, raw, actor }: { account: string | null; body?: unknown; raw?: string; actor?: string | undefined },
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(method)(baseUrl + path);
    if (account !== null) request = HttpClientRequest.setHeader(request, "X-Account-Id", account);
    if (actor) request = HttpClientRequest.setHeader(request, "X-Actor", actor);
    if (raw !== undefined || body !== undefined)
      request = HttpClientRequest.bodyText(request, raw ?? JSON.stringify(body), "application/json");
    const response = yield* client.execute(request);
    const { status, headers } = response;
    const text = yield* response.text;
    if (status >= 400) {
      const { error } = yield* fromText(ErrorBody)(text);
      return { status, headers, text, error, body: fail(`${method} ${path}: HTTP ${status} ${text}`) };
    }
    const decoded = status === 204 ? yield* Schema.decodeUnknownEffect(schema)(text) : yield* fromText(schema)(text);
    return { status, headers, text, body: Effect.succeed(decoded) };
  });

export const fieldsOf = (error: typeof ErrorBody.Type.error) => (error.details ?? []).map((detail) => detail.field);
export const expectError = (reply: Reply, status: number, code: string, context: string) =>
  Effect.gen(function* () {
    yield* eqJ(reply.status, status, `${context}: status (${reply.text.slice(0, 400)})`);
    if (!reply.error || reply.error.code !== code)
      return yield* fail(`${context}: expected error.code ${code}, got ${reply.text.slice(0, 400)}`);
    return reply.error;
  });
export const expectField = (error: typeof ErrorBody.Type.error, field: string, context: string) =>
  check(fieldsOf(error).includes(field), `${context}: details should include field "${field}"`, fieldsOf(error));

type Case = { name: string; run: Effect.Effect<void, unknown, HttpClient.HttpClient> };
export const suite = () => {
  const cases: Case[] = [];
  const test = (name: string, run: Case["run"]) => {
    cases.push({ name, run });
  };
  const run = () => {
    if (!baseUrl) {
      console.error("BASE_URL is required");
      process.exitCode = 2;
      return;
    }
    const i = process.argv.indexOf("--filter");
    const filter = i < 0 ? undefined : process.argv[i + 1];
    NodeRuntime.runMain(
      Effect.gen(function* () {
        let passed = 0,
          failed = 0;
        for (const entry of cases) {
          if (filter && !entry.name.includes(filter)) continue;
          const result = yield* Effect.exit(entry.run);
          if (result._tag === "Success") {
            passed++;
            console.log(`  ok   ${entry.name}`);
          } else {
            failed++;
            console.log(`  FAIL ${entry.name}\n      ${Cause.pretty(result.cause)}`);
          }
        }
        console.log(`${passed}/${passed + failed} passed`);
        if (failed) return yield* fail(`${failed} conformance case(s) failed`);
      }).pipe(Effect.provide(NodeHttpClient.layerUndici)),
      { disableErrorReporting: true },
    );
  };
  return { test, run };
};

const strings = Schema.Array(Schema.String);
const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
const Action = Schema.Struct({
  op: Schema.String,
  form: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  attribute: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.NullOr(Scalar)),
  requirement: Schema.optionalKey(Schema.String),
});
const Attribute = Schema.Struct({
  key: Schema.String,
  type: Schema.Literals(["string", "integer", "number", "boolean", "date", "enum"]),
  values: Schema.optionalKey(strings),
  label: Schema.optionalKey(Schema.String),
  unique: Schema.optionalKey(Schema.Boolean),
});
const Shape = Schema.Struct({
  key: Schema.String,
  attributes: strings,
  required: Schema.optionalKey(strings),
  label: Schema.optionalKey(Schema.String),
});
const Policy = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  shape: Schema.String,
  applies_when: Schema.Json,
  requires: Schema.Array(Schema.Struct({ form: Schema.String, when: Schema.optionalKey(Schema.Json) })),
});
const Automation = Schema.Struct({
  id: Schema.String,
  shape: Schema.String,
  on: Schema.Struct({ changed: strings }),
  when: Schema.optionalKey(Schema.Json),
  do: Schema.Array(Action),
});
const Requirement = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  shape: Schema.String,
  expires: Schema.String,
  renew_within_days: Schema.Int,
  applies_when: Schema.optionalKey(Schema.Json),
});
const registryFields = {
  version: Schema.Int,
  attributes: Schema.Array(Attribute),
  shapes: Schema.Array(Shape),
  policies: Schema.Array(Policy),
  automations: Schema.Array(Automation),
};
export const Registry = Schema.StructWithRest(Schema.Struct(registryFields), [Schema.Record(Schema.String, Schema.Json)]);
export const CertRegistry = Schema.Struct({ ...registryFields, certification_requirements: Schema.Array(Requirement) });
export const Plan = Schema.Struct({
  from_version: Schema.Int,
  to_version: Schema.Int,
  applicable: Schema.Boolean,
  issues: Schema.Array(Issue),
  changes: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      key: Schema.String,
      change: Schema.Literals(["added", "removed", "modified"]),
    }),
  ),
  violations: Schema.Array(Schema.Struct({ entity_id: Schema.String, ...Issue.fields })),
});
export const Entity = Schema.Struct({
  id: Schema.String,
  shape: Schema.String,
  facts: Schema.Record(Schema.String, Scalar),
  version: Schema.Int,
  registry_version: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export const Mutation = Schema.Struct({
  ...Entity.fields,
  effects: Schema.Array(Schema.Struct({ automation_id: Schema.String, ...Action.fields })),
});
export const History = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      tx: Schema.Int,
      at: Schema.String,
      attribute: Schema.String,
      op: Schema.Literals(["assert", "retract"]),
      value: Scalar,
      reason: Schema.Literals(["api", "automation", "migration"]),
      actor: Schema.String,
    }),
  ),
});
export const Outbox = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      seq: Schema.Int,
      at: Schema.String,
      entity_id: Schema.String,
      automation_id: Schema.String,
      ...Action.fields,
    }),
  ),
  next_after: Schema.NullOr(Schema.Int),
});
export const Evaluate = Schema.Struct({ required: strings, undetermined: strings });
export const Certifications = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      requirement: Schema.String,
      status: Schema.Literals(["not_applicable", "undetermined", "missing", "expired", "due", "valid"]),
      expires: Schema.optionalKey(Schema.String),
      renew_by: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const Health = Schema.Struct({ status: Schema.Literal("ok") });
export const Empty = Schema.Literal("");
