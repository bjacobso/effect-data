import { Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiGroup, HttpApiEndpoint, HttpApiBuilder, HttpApiSchema } from "effect/http-api";
import { Engine, type ApplyMode, type EngineValue } from "../core/engine.ts";
import { type Registry, issue } from "../core/model.ts";
import { storedQuery, inlineQuery } from "./queries.ts";
import { realDate } from "../core/values.ts";
import { Store } from "../storage/Store.ts";
import { ensure, Invalid, NotFound } from "../Errors.ts";
import { AccountMiddleware, ValidationMiddleware, AccountLive, ValidationLive, Tenant, respond, entityId, errors } from "./boundary.ts";
import {
  EntitySchema,
  MutatedEntity,
  createSchema,
  patchSchema,
  params,
  scalar,
  PlanSchema,
  RolloutSchema,
  ViolationStatus,
  ViolationPage,
} from "./schemas.ts";
export function coreApi(engine: EngineValue) {
  const registry = Schema.Struct({ ...engine.fields, version: Schema.Int });
  return HttpApi.make("data")
    .add(
      HttpApiGroup.make("core")
        .add(
          storedQuery,
          inlineQuery,
          HttpApiEndpoint.get("registry", "/v2/registry", {
            success: Schema.Struct({ ...registry.fields, rollout: RolloutSchema }),
            error: errors,
          }),
          HttpApiEndpoint.post("plan", "/v2/registry/plan", { payload: engine.payload(), success: PlanSchema, error: errors }),
          HttpApiEndpoint.put("apply", "/v2/registry", { payload: engine.payload(true), success: registry, error: errors }),
          HttpApiEndpoint.get("jsonSchema", "/v2/registry/json-schema/:shape", {
            params: { shape: Schema.String },
            success: Schema.Unknown,
            error: errors,
          }),
          HttpApiEndpoint.post("create", "/v2/entities", {
            payload: createSchema,
            success: HttpApiSchema.WithHeaders(MutatedEntity.pipe(HttpApiSchema.status(201)), { location: Schema.String }),
            error: errors,
          }),
          HttpApiEndpoint.patch("patch", "/v2/entities/:id", { params, payload: patchSchema, success: MutatedEntity, error: errors }),
          HttpApiEndpoint.get("get", "/v2/entities/:id", {
            params,
            query: { as_of: Schema.optionalKey(Schema.String) },
            success: EntitySchema,
            error: errors,
          }),
          HttpApiEndpoint.delete("remove", "/v2/entities/:id", { params, success: HttpApiSchema.NoContent, error: errors }),
          HttpApiEndpoint.get("referrers", "/v2/entities/:id/referrers", {
            params,
            success: Schema.Struct({
              data: Schema.Array(
                Schema.Struct({
                  entity_id: Schema.String,
                  attribute: Schema.String,
                  on_delete: Schema.Literals(["block", "clear"]),
                }),
              ),
            }),
            error: errors,
          }),
          HttpApiEndpoint.get("history", "/v2/entities/:id/history", {
            params,
            success: Schema.Struct({
              data: Schema.Array(
                Schema.Struct({
                  tx: Schema.Int,
                  at: Schema.String,
                  attribute: Schema.String,
                  op: Schema.String,
                  value: scalar,
                  reason: Schema.Literals(["api", "automation", "migration", "reference"]),
                  actor: Schema.String,
                }),
              ),
            }),
            error: errors,
          }),
          HttpApiEndpoint.get("violations", "/v2/violations", {
            query: {
              after: Schema.optionalKey(Schema.String),
              limit: Schema.optionalKey(Schema.String),
              status: Schema.optionalKey(ViolationStatus),
              attribute: Schema.optionalKey(Schema.String),
            },
            success: ViolationPage,
            error: errors,
          }),
          HttpApiEndpoint.get("outbox", "/v2/outbox", {
            query: { after: Schema.optionalKey(Schema.String), limit: Schema.optionalKey(Schema.String) },
            success: Schema.Struct({
              data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
              next_after: Schema.NullOr(Schema.Int),
            }),
            error: errors,
          }),
        )
        .middleware(ValidationMiddleware)
        .middleware(AccountMiddleware),
      HttpApiGroup.make("system").add(
        HttpApiEndpoint.get("health", "/healthz", { success: Schema.Struct({ status: Schema.String }), error: errors }),
      ),
    )
    .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error", errors: "all" });
}
export const CoreHttpLive = Layer.unwrap(
  Effect.gen(function* () {
    const engine = yield* Engine,
      store = yield* Store,
      api = coreApi(engine);
    return Layer.mergeAll(
      HttpApiBuilder.group(api, "system", (h) =>
        h.handle("health", () =>
          Effect.gen(function* () {
            yield* store.sql`SELECT 1`.pipe(Effect.orDie);
            return { status: "ok" };
          }),
        ),
      ),
      HttpApiBuilder.group(api, "core", (h) => {
        const registryInput = (payload: unknown) =>
          Effect.gen(function* () {
            yield* ensure(engine.structure(payload));
            const { base_version, mode, ...desired } = payload as Record<string, unknown>;
            return { base: Number(base_version), mode: mode as ApplyMode | undefined, desired: engine.normalize(desired as Registry) };
          });
        const onEntity = <A, E, R>(id: string, action: (id: string, account: string, actor: string) => Effect.Effect<A, E, R>) =>
          respond(
            Effect.gen(function* () {
              const tenant = yield* Tenant;
              return yield* action(yield* entityId(id), tenant.account, tenant.actor);
            }),
          );
        return h.handleAll({
          storedQuery: ({ params, payload }) => respond(Effect.flatMap(Tenant, (t) => store.runQuery(t.account, params.id, payload))),
          inlineQuery: ({ payload: { query, ...options } }) =>
            respond(Effect.flatMap(Tenant, (t) => store.runQuery(t.account, query, options))),
          registry: () =>
            respond(
              Effect.gen(function* () {
                const t = yield* Tenant,
                  s = store,
                  r = yield* s.getRegistry(t.account);
                return { version: r.version, ...r.registry, rollout: yield* s.rolloutStatus(t.account, r.version) };
              }),
            ),
          plan: ({ payload }) =>
            respond(
              Effect.gen(function* () {
                const t = yield* Tenant,
                  s = store,
                  r = yield* registryInput(payload);
                return yield* s.plan(t.account, r.desired, r.mode);
              }),
            ),
          apply: ({ payload }) =>
            respond(
              Effect.gen(function* () {
                const t = yield* Tenant,
                  s = store,
                  r = yield* registryInput(payload);
                return yield* s.apply(t.account, t.actor, r.desired, r.base, r.mode);
              }),
            ),
          jsonSchema: ({ params }) =>
            respond(
              Effect.gen(function* () {
                const t = yield* Tenant,
                  s = store,
                  r = yield* s.getRegistry(t.account),
                  schema = s.compiled(t.account, r.version, r.registry).schemas.get(params.shape);
                if (!schema) return yield* Effect.fail(new NotFound());
                const doc = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
                return { ...doc.schema, $defs: doc.definitions, $schema: "https://json-schema.org/draft/2020-12/schema" };
              }),
            ),
          create: ({ payload }) =>
            respond(
              Effect.gen(function* () {
                const t = yield* Tenant,
                  s = store,
                  e = yield* s.mutate(t.account, t.actor, payload);
                return HttpApiSchema.withHeaders({ body: e, headers: { location: `/v2/entities/${e.id}` } });
              }),
            ),
          patch: ({ params, payload }) =>
            onEntity(params.id, (id, account, actor) =>
              Effect.gen(function* () {
                if (!Object.keys(payload.facts).length)
                  return yield* Effect.fail(new Invalid({ issues: [issue("facts", "Expected non-empty facts")] }));
                return yield* store.mutate(account, actor, payload, id);
              }),
            ),
          get: ({ params, query }) =>
            onEntity(params.id, (id, account) =>
              Effect.gen(function* () {
                const s = store;
                if (query.as_of === undefined) return yield* s.getLive(account, id);
                const at = query.as_of;
                if (
                  !/^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)$/.test(at) ||
                  !realDate(at.slice(0, 10)) ||
                  !Number.isFinite(Date.parse(at))
                )
                  return yield* Effect.fail(new Invalid({ issues: [issue("as_of")] }));
                return yield* s.asOf(account, id, new Date(at).toISOString());
              }),
            ),
          remove: ({ params }) => onEntity(params.id, (id, account, actor) => store.remove(account, actor, id)),
          referrers: ({ params }) => onEntity(params.id, (id, account) => store.referrers(account, id)),
          history: ({ params }) => onEntity(params.id, (id, account) => store.history(account, id)),
          outbox: ({ query }) =>
            respond(
              Effect.gen(function* () {
                const t = yield* Tenant,
                  { after, limit } = yield* pagination(query);
                return yield* store.outbox(t.account, after, limit);
              }),
            ),
          violations: ({ query }) =>
            respond(
              Effect.gen(function* () {
                const t = yield* Tenant,
                  { after, limit } = yield* pagination(query);
                return yield* store.listViolations(t.account, query.status, query.attribute, after, limit);
              }),
            ),
        });
      }).pipe(Layer.provide([AccountLive, ValidationLive])),
    );
  }),
);

const pagination = (query: { after?: string; limit?: string }) =>
  Effect.gen(function* () {
    const read = (field: "after" | "limit", fallback: number, min: number, max: number) => {
      const value = query[field];
      return value === undefined
        ? fallback
        : /^\d+$/.test(value) && Number.isSafeInteger(+value) && +value >= min && +value <= max
          ? +value
          : undefined;
    };
    const after = read("after", 0, 0, Number.MAX_SAFE_INTEGER),
      limit = read("limit", 50, 1, 200);
    if (after === undefined || limit === undefined)
      return yield* Effect.fail(new Invalid({ issues: [issue(after === undefined ? "after" : "limit")] }));
    return { after, limit };
  });
