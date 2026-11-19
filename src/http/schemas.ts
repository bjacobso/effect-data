import { Schema } from "effect";
export const scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
export const ViolationIssue = Schema.Literals(["duplicate", "dangling_reference"]);
const OpenViolation = Schema.Struct({ attribute: Schema.String, issue: ViolationIssue });
export const ViolationStatus = Schema.Literals(["open", "resolved"]);
export const ViolationPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      ...OpenViolation.fields,
      id: Schema.Int,
      entity_id: Schema.String,
      value: scalar,
      status: ViolationStatus,
      registry_version: Schema.Int,
      opened_tx: Schema.Int,
      opened_at: Schema.String,
      resolved_tx: Schema.NullOr(Schema.Int),
      resolved_at: Schema.NullOr(Schema.String),
    }),
  ),
  next_after: Schema.NullOr(Schema.Int),
});
export const RolloutSchema = Schema.NullOr(
  Schema.Struct({
    version: Schema.Int,
    status: Schema.Literals(["running", "done", "superseded"]),
    processed: Schema.Int,
    total: Schema.Int,
  }),
);
const EntityFields = Schema.Struct({
  id: Schema.String,
  shape: Schema.String,
  facts: Schema.Record(Schema.String, scalar),
  version: Schema.Int,
  registry_version: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export const EntitySchema = Schema.Struct({ ...EntityFields.fields, violations: Schema.Array(OpenViolation) });
export const MutatedEntity = Schema.Struct({ ...EntityFields.fields, effects: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) });
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
  violations: Schema.Array(Schema.Struct({ ...IssueSchema.fields, entity_id: Schema.String, blocking: Schema.Boolean })),
});
