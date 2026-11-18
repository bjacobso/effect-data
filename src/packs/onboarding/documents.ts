import { Schema } from "effect";
import {
  id,
  shapeKey,
  text,
  list,
  distinct,
  compare,
  type Registry,
  type Entity,
  type Rule,
  canonical,
  defineKind,
  defineOp,
} from "../../core/model.ts";
import type { Compiled } from "../../core/engine.ts";
import { ruleSchema, ruleRefs, typedRule, evaluator, and, type Tri } from "../../core/rules.ts";
export const PolicySchema = Schema.Struct({
  id,
  name: text(1, 200),
  shape: shapeKey,
  applies_when: ruleSchema,
  requires: list(Schema.Struct({ form: id, when: Schema.optionalKey(ruleSchema) }), 1, 50),
});
export const policyKind = defineKind(PolicySchema, {
  name: "policy",
  collection: "policies",
  identity: "id",
  order: 30,
  fields: ["id", "name", "shape", "applies_when", "requires"],
  references: (d) => [
    { path: "shape", to: "shape", key: d.shape },
    ...ruleRefs(d.applies_when, "applies_when", d.shape),
    ...d.requires.flatMap((r, i) => (r.when === undefined ? [] : ruleRefs(r.when, `requires[${i}].when`, d.shape))),
  ],
  check: (d, r) => [
    ...typedRule(d.applies_when, "applies_when", d.shape, r),
    ...d.requires.flatMap((q, i) => (q.when === undefined ? [] : typedRule(q.when, `requires[${i}].when`, d.shape, r))),
  ],
  structure: (d) =>
    distinct(
      d.requires.map((q) => q.form),
      "requires",
    ).map((x) => ({ ...x, field: `${x.field}.form` })),
  rules: (d) => [d.applies_when, ...d.requires.flatMap((q) => (q.when === undefined ? [] : [q.when]))],
});
export const ops = {
  send_form: defineOp(Schema.Struct({ op: Schema.Literal("send_form"), form: id }), { handler: (a) => ({ type: "outbox", payload: a }) }),
  notify: defineOp(Schema.Struct({ op: Schema.Literal("notify"), message: text(1, 500) }), {
    handler: (a) => ({ type: "outbox", payload: a }),
  }),
};
export function evaluate(registry: Registry, entity: Entity, compiled?: Compiled) {
  const evaluateRule = (r: Rule) => (compiled?.rules.get(canonical(r)) ?? evaluator(r))(entity.facts),
    statuses = new Map<string, Tri[]>();
  for (const p of Schema.decodeUnknownSync(list(PolicySchema))(registry.policies ?? []))
    if (p.shape === entity.shape)
      for (const req of p.requires) {
        const status = and([evaluateRule(p.applies_when), req.when === undefined ? "T" : evaluateRule(req.when)]);
        statuses.set(req.form, [...(statuses.get(req.form) ?? []), status]);
      }
  return {
    required: [...statuses]
      .filter(([, v]) => v.includes("T"))
      .map(([k]) => k)
      .sort(compare),
    undetermined: [...statuses]
      .filter(([, v]) => !v.includes("T") && v.includes("U"))
      .map(([k]) => k)
      .sort(compare),
  };
}
