import { Schema } from "effect";
import { defineKind, distinct, findAttribute, findShape, id, issue, key, list, shapeKey } from "./model.ts";
import { ruleRefs, ruleSchema, typedRule } from "./rules.ts";

export const QuerySchema = Schema.Struct({
  id,
  shape: shapeKey,
  where: Schema.optionalKey(ruleSchema),
  order_by: list(Schema.Struct({ attribute: key, direction: Schema.Literals(["asc", "desc"]) }), 0, 3),
});
export type Query = typeof QuerySchema.Type;

export const queryKind = defineKind(QuerySchema, {
  name: "query",
  collection: "queries",
  identity: "id",
  order: 45,
  fields: ["id", "shape", "where", "order_by"],
  references: (d) => [
    { path: "shape", to: "shape", key: d.shape },
    ...(d.where === undefined ? [] : ruleRefs(d.where, "where", d.shape)),
    ...d.order_by.map(({ attribute }, i) => ({
      path: `order_by[${i}].attribute`,
      to: "attribute",
      key: attribute,
      context: { shape: d.shape },
    })),
  ],
  check: (d, r) => [
    ...(d.where === undefined ? [] : typedRule(d.where, "where", d.shape, r)),
    ...d.order_by.flatMap(({ attribute }, i) => {
      const a = findAttribute(r, attribute);
      return a && !a.retired && findShape(r, d.shape)?.attributes.includes(attribute) && ["ref", "boolean"].includes(a.type)
        ? [issue(`order_by[${i}].attribute`, "Cannot order by ref or boolean")]
        : [];
    }),
  ],
  structure: (d) =>
    distinct(
      d.order_by.map(({ attribute }) => attribute),
      "order_by",
    ).map(({ field, issue: message }) => issue(`${field}.attribute`, message)),
  rules: (d) => (d.where === undefined ? [] : [d.where]),
});
