import { Effect, Schema } from "effect";
import { HttpApi, HttpApiGroup, HttpApiEndpoint, HttpApiBuilder } from "effect/http-api";
import {
  AccountMiddleware,
  ValidationMiddleware,
  AccountLive,
  ValidationLive,
  Tenant,
  respond,
  entityId,
  errors,
} from "../../http/boundary.ts";
import { params } from "../../http/schemas.ts";
import { Store } from "../../storage/Store.ts";
import { evaluate } from "./documents.ts";
import { Layer } from "effect";
export const OnboardingGroup = HttpApiGroup.make("onboarding")
  .add(
    HttpApiEndpoint.post("evaluate", "/v2/entities/:id/evaluate", {
      params,
      success: Schema.Struct({ required: Schema.Array(Schema.String), undetermined: Schema.Array(Schema.String) }),
      error: errors,
    }),
  )
  .middleware(ValidationMiddleware)
  .middleware(AccountMiddleware);
const api = HttpApi.make("data").add(OnboardingGroup);
export const OnboardingHttpLive = HttpApiBuilder.group(api, "onboarding", (h) =>
  Effect.gen(function* () {
    const store = yield* Store;
    return h.handle("evaluate", ({ params }) =>
      respond(
        Effect.gen(function* () {
          const tenant = yield* Tenant,
            id = yield* entityId(params.id),
            { entity, registry, config } = yield* store.readEntity(tenant.account, id);
          return evaluate(registry, entity, config);
        }),
      ),
    );
  }),
).pipe(Layer.provide([AccountLive, ValidationLive]));
