import { Context, Effect, Layer, Schema, SchemaIssue, Cause, Option, ByteSize } from "effect";
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpServerError } from "effect/http";
import { BadCursor, NotFound, Conflict, Invalid } from "../Errors.ts";
import { issue, path, type Issue } from "../core/model.ts";
export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optionalKey(Schema.Array(Schema.Struct({ field: Schema.String, issue: Schema.String }))),
  }),
});
export const errors = [400, 404, 409, 413, 422, 500].map((status) => ErrorEnvelope.pipe(HttpApiSchema.status(status)));
export const errorResponse = (status: number, code: string, details: readonly Issue[] = []) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message: code, ...(details.length ? { details } : {}) } }, { status });
export function respond<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.catch((e) =>
      Effect.succeed(
        e instanceof BadCursor
          ? errorResponse(400, "bad_request", [issue("after", "Invalid query cursor")])
          : e instanceof NotFound
            ? errorResponse(404, "not_found")
            : e instanceof Conflict
              ? errorResponse(409, "conflict", e.issues)
              : e instanceof Invalid
                ? errorResponse(422, "validation_failed", e.issues)
                : errorResponse(500, "internal"),
      ),
    ),
  );
}
export const entityId = (id: string) =>
  /^[A-Za-z0-9_-]{21}$/.test(id.slice(3)) && id.startsWith("en_") ? Effect.succeed(id) : Effect.fail(new NotFound());
export class Tenant extends Context.Service<Tenant, { account: string; actor: string }>()("http/Tenant") {}
export class AccountMiddleware extends HttpApiMiddleware.Service<AccountMiddleware, { provides: Tenant }>()("http/Account", {
  error: errors,
}) {}
export class ValidationMiddleware extends HttpApiMiddleware.Service<ValidationMiddleware>()("http/Validation", { error: errors }) {}
export const AccountLive = Layer.succeed(
  AccountMiddleware,
  AccountMiddleware.of((next) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest,
        account = req.headers["x-account-id"],
        actor = req.headers["x-actor"] ?? "anonymous";
      if (!account || !/^acct_[A-Za-z0-9_-]{1,64}$/.test(account)) return errorResponse(400, "bad_request");
      if (!actor.length || Array.from(actor).length > 200) return errorResponse(422, "validation_failed", [issue("X-Actor")]);
      return yield* Effect.provideService(next, Tenant, { account, actor });
    }),
  ),
);
const formatter = SchemaIssue.makeFormatterStandardSchemaV1();
export const ValidationLive = HttpApiMiddleware.layerSchemaErrorTransform(ValidationMiddleware, (error) =>
  Effect.gen(function* () {
    const issues = formatter(error.cause.issue).issues;
    if (error.kind === "Payload") {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if ((yield* request.text.pipe(Effect.orDie)) === "") return errorResponse(400, "bad_request");
    }
    return issues.some((x) => x.message === "Expected a valid JSON body")
      ? errorResponse(400, "bad_request")
      : errorResponse(
          error.kind === "Payload" || error.kind === "Query" ? 422 : 500,
          error.kind === "Payload" || error.kind === "Query" ? "validation_failed" : "internal",
          issues.map((x) => issue(path(x.path), x.message)),
        );
  }),
);
export const EdgeLive = HttpRouter.middleware<{ handles: HttpServerError.HttpServerError }>()(
  (next) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (Number(req.headers["content-length"]) > 1048576) return errorResponse(413, "bad_request");
      return yield* next.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1)),
        Effect.catchCause((cause) => {
          const found = Cause.findErrorOption(cause),
            e = Cause.squash(cause);
          if (Option.isSome(found) && !HttpServerError.isHttpServerError(found.value)) return Effect.fail(found.value);
          const status = HttpServerError.isHttpServerError(e)
            ? e.reason._tag === "RouteNotFound"
              ? 404
              : e.reason._tag === "RequestParseError" && e.reason.reason === "BodyTooLarge"
                ? 413
                : 400
            : 500;
          return Effect.succeed(errorResponse(status, status === 404 ? "not_found" : status === 500 ? "internal" : "bad_request"));
        }),
        Effect.map((r) => (r.status === 415 ? errorResponse(400, "bad_request") : r)),
      );
    }),
  { global: true },
);
