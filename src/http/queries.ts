import { Schema } from "effect";
import { HttpApiEndpoint } from "effect/http-api";
import { QuerySchema } from "../core/queryKind.ts";
import { errors } from "./boundary.ts";
import { EntitySchema } from "./schemas.ts";

const options = {
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  after: Schema.optionalKey(Schema.String),
  match: Schema.optionalKey(Schema.Literals(["true", "unknown"])),
};
const success = Schema.Struct({ data: Schema.Array(EntitySchema), next_after: Schema.NullOr(Schema.String) });

export const storedQuery = HttpApiEndpoint.post("storedQuery", "/v2/queries/:id/run", {
  params: { id: Schema.String },
  payload: Schema.Struct(options),
  success,
  error: errors,
});
export const inlineQuery = HttpApiEndpoint.post("inlineQuery", "/v2/query", {
  payload: Schema.Struct({ query: QuerySchema, ...options }),
  success,
  error: errors,
});
