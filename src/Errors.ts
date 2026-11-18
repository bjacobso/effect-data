import { Effect, Schema } from "effect";
import type { Issue } from "./core/model.ts";
const fields = { issues: Schema.Array(Schema.Struct({ field: Schema.String, issue: Schema.String })) };
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) {}
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", fields) {}
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", fields) {}
export const ensure = (issues: Issue[]) => (issues.length ? Effect.fail(new Invalid({ issues })) : Effect.void);
export const ensureApplicable = (issues: Issue[]) => (issues.length ? Effect.fail(new Conflict({ issues })) : Effect.void);
