import { Schema } from "effect";
export const scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
export const EntitySchema = Schema.Struct({
  id: Schema.String,
  shape: Schema.String,
  facts: Schema.Record(Schema.String, scalar),
  version: Schema.Int,
  registry_version: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export const MutatedEntity = Schema.Struct({ ...EntitySchema.fields, effects: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) });
export const createSchema = Schema.Struct({ shape: Schema.String, facts: Schema.Record(Schema.String, Schema.Json) });
export const patchSchema = Schema.Struct({
  facts: Schema.Record(Schema.String, Schema.Json),
  expected_version: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export const params = { id: Schema.String };
export const IssueSchema = Schema.Struct({ field: Schema.String, issue: Schema.String });
export const PlanSchema = Schema.Struct({
  from_version: Schema.Int,
  to_version: Schema.Int,
  applicable: Schema.Boolean,
  issues: Schema.Array(IssueSchema),
  changes: Schema.Array(Schema.Struct({ kind: Schema.String, key: Schema.String, change: Schema.String })),
  violations: Schema.Array(Schema.Struct({ ...IssueSchema.fields, entity_id: Schema.String })),
});
