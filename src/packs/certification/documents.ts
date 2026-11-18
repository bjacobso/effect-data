import { Schema } from "effect";
import {
  id,
  text,
  key,
  shapeKey,
  list,
  defineKind,
  defineOp,
  findAttribute,
  findShape,
  issue,
  compare,
  canonical,
  type Registry,
  type Entity,
  type Rule,
} from "../../core/model.ts";
import { ruleSchema, ruleRefs, typedRule, evaluator } from "../../core/rules.ts";
import type { Compiled } from "../../core/engine.ts";
export const RequirementSchema = Schema.Struct({
  id,
  name: text(1, 200),
  shape: shapeKey,
  expires: key,
  renew_within_days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
  applies_when: Schema.optionalKey(ruleSchema),
});
const requirements = (r: Registry) => Schema.decodeUnknownSync(list(RequirementSchema))(r.certification_requirements ?? []);
export const requirementKind = defineKind(RequirementSchema, {
  name: "certification_requirement",
  collection: "certification_requirements",
  identity: "id",
  order: 35,
  fields: ["id", "name", "shape", "expires", "renew_within_days", "applies_when"],
  references: (d) => [
    { path: "shape", to: "shape", key: d.shape },
    { path: "expires", to: "attribute", key: d.expires, context: { shape: d.shape } },
    ...(d.applies_when === undefined ? [] : ruleRefs(d.applies_when, "applies_when", d.shape)),
  ],
  check: (d, r) => {
    const attr = findAttribute(r, d.expires);
    return [
      ...(attr && findShape(r, d.shape)?.attributes.includes(d.expires) && attr.type !== "date"
        ? [issue("expires", "Expected a date attribute")]
        : []),
      ...(d.applies_when === undefined ? [] : typedRule(d.applies_when, "applies_when", d.shape, r)),
    ];
  },
  rules: (d) => (d.applies_when === undefined ? [] : [d.applies_when]),
});
export const ops = {
  schedule_renewal: defineOp(Schema.Struct({ op: Schema.Literal("schedule_renewal"), requirement: id }), {
    references: (a) => [{ path: "requirement", to: "certification_requirement", key: a.requirement }],
    check: (a, shape, r) => {
      const target = requirements(r).find((d) => d.id === a.requirement);
      return target && target.shape !== shape ? [issue("requirement", "Requirement belongs to another shape")] : [];
    },
    handler: (a) => ({ type: "outbox", payload: a }),
  }),
};
type Status = "valid" | "due" | "expired" | "missing" | "undetermined" | "not_applicable";
export function certifications(registry: Registry, entity: Entity, on: string, compiled?: Compiled) {
  const evaluate = (r: Rule) => (compiled?.rules.get(canonical(r)) ?? evaluator(r))(entity.facts),
    onMs = Date.parse(`${on}T00:00:00Z`);
  return {
    data: requirements(registry)
      .filter((r) => r.shape === entity.shape)
      .sort((a, b) => compare(a.id, b.id))
      .map((r) => {
        const applies = r.applies_when === undefined ? "T" : evaluate(r.applies_when),
          expires = entity.facts[r.expires];
        const expiryMs = typeof expires === "string" ? Date.parse(`${expires}T00:00:00Z`) : undefined,
          renewMs = expiryMs === undefined ? undefined : expiryMs - r.renew_within_days * 86400000;
        const status: Status =
          applies === "F"
            ? "not_applicable"
            : applies === "U"
              ? "undetermined"
              : expiryMs === undefined
                ? "missing"
                : expiryMs < onMs
                  ? "expired"
                  : onMs >= renewMs!
                    ? "due"
                    : "valid";
        return {
          requirement: r.id,
          status,
          ...(renewMs === undefined ? {} : { expires: String(expires), renew_by: new Date(renewMs).toISOString().split("T")[0]! }),
        };
      }),
  };
}
