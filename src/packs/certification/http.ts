import { Effect, Layer, Schema, SchemaIssue } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiGroup, HttpApiEndpoint, HttpApiMiddleware } from "effect/http-api";
import { params } from "../../http/schemas.ts";
import { AccountMiddleware, AccountLive, Tenant, respond, entityId, errors, errorResponse } from "../../http/boundary.ts";
import { issue, path } from "../../core/model.ts";
import { realDate } from "../../core/values.ts";
import { Store } from "../../storage/Store.ts";
import { certifications } from "./documents.ts";
const DateSchema = Schema.String.check(Schema.makeFilter(realDate, { toJsonSchema: () => [{ type: "string", format: "date" }, true] }));
class Validation extends HttpApiMiddleware.Service<Validation>()("certification/Validation", { error: errors }) {}
const formatter = SchemaIssue.makeFormatterStandardSchemaV1();
const ValidationLive = HttpApiMiddleware.layerSchemaErrorTransform(Validation, (error) => {
  const issues = formatter(error.cause.issue).issues;
  return Effect.succeed(
    issues.some((x) => x.message === "Expected a valid JSON body")
      ? errorResponse(400, "bad_request")
      : errorResponse(
          422,
          "validation_failed",
          issues.map((x) => issue(path(x.path) || "on", x.message)),
        ),
  );
});
export const CertificationGroup = HttpApiGroup.make("certification")
  .add(
    HttpApiEndpoint.post("certifications", "/v2/entities/:id/certifications", {
      params,
      payload: Schema.Struct({ on: DateSchema }),
      success: Schema.Struct({
        data: Schema.Array(
          Schema.Struct({
            requirement: Schema.String,
            status: Schema.Literals(["valid", "due", "expired", "missing", "undetermined", "not_applicable"]),
            expires: Schema.optionalKey(Schema.String),
            renew_by: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
      error: errors,
    }),
  )
  .middleware(Validation)
  .middleware(AccountMiddleware);
const api = HttpApi.make("data")
  .add(CertificationGroup)
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error", errors: "all" });
export const CertificationHttpLive = HttpApiBuilder.group(api, "certification", (h) =>
  Effect.gen(function* () {
    const store = yield* Store;
    return h.handle("certifications", ({ params, payload }) =>
      respond(
        Effect.gen(function* () {
          const t = yield* Tenant,
            id = yield* entityId(params.id),
            entity = yield* store.getLive(t.account, id),
            r = yield* store.getRegistry(t.account);
          return certifications(r.registry, entity, payload.on, store.compiled(t.account, r.version, r.registry));
        }),
      ),
    );
  }),
).pipe(Layer.provide([AccountLive, ValidationLive]));
