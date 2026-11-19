import { Schema } from "effect";
import {
  key,
  shapeKey,
  text,
  id,
  list,
  distinct,
  issue,
  decodeIssues,
  prefix,
  findAttribute,
  findShape,
  defineKind,
  defineOp,
  type Action,
  type Attribute,
  type Edge,
} from "./model.ts";
import type { Ops } from "./registry.ts";
import { ruleSchema, ruleRefs, typedRule } from "./rules.ts";
import { valueSchema } from "./values.ts";
export const setOp = defineOp(
  Schema.Struct({
    op: Schema.Literal("set"),
    attribute: key,
    value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
  }),
  {
    handler: (a) => ({ type: "set", attribute: a.attribute, value: a.value }),
    references: (a, shape) => [{ path: "attribute", to: "attribute", key: a.attribute, context: { shape } }],
    check: (a, shape, r) => {
      const s = findShape(r, shape),
        attr = findAttribute(r, a.attribute);
      if (!attr || !s?.attributes.includes(a.attribute)) return [];
      return a.value === null
        ? s.required?.includes(a.attribute)
          ? [issue("value", "Cannot retract required attribute")]
          : []
        : decodeIssues(valueSchema(attr), a.value).length
          ? [issue("value", "Invalid attribute value")]
          : [];
    },
  },
);
export function attributeEdges(attributes: readonly Attribute[]) {
  const edges = new Map<string, Edge>();
  for (const a of attributes)
    if (a.type === "ref" && a.target !== undefined) edges.set(a.key, { target: a.target, on_delete: a.on_delete ?? "block" });
  return edges;
}
export const AttributeSchema = Schema.Struct({
  key,
  type: Schema.Literals(["string", "integer", "number", "boolean", "date", "enum", "ref"]),
  values: Schema.optionalKey(list(text(1, 200), 1, 100)),
  label: Schema.optionalKey(text(1, 200)),
  unique: Schema.optionalKey(Schema.Boolean),
  retired: Schema.optionalKey(Schema.Literal(true)),
  target: Schema.optionalKey(shapeKey),
  on_delete: Schema.optionalKey(Schema.Literals(["block", "clear"])),
});
export const attributeKind = defineKind(AttributeSchema, {
  name: "attribute",
  collection: "attributes",
  identity: "key",
  order: 10,
  fields: ["key", "type", "values", "label", "unique", "retired", "target", "on_delete"],
  references: (d) => (d.type === "ref" && d.target !== undefined ? [{ path: "target", to: "shape", key: d.target }] : []),
  check: () => [],
  structure: (d) => {
    const errors = [];
    if (d.type === "enum") {
      if (d.values === undefined) errors.push(issue("values", "Enum values required"));
      else errors.push(...distinct(d.values, "values"));
    } else if (d.values !== undefined) errors.push(issue("values", "Only enum supports values"));
    if (d.type === "ref") {
      if (d.target === undefined) errors.push(issue("target", "Ref target required"));
    } else {
      if (d.target !== undefined) errors.push(issue("target", "Only refs support target"));
      if (d.on_delete !== undefined) errors.push(issue("on_delete", "Only refs support on_delete"));
    }
    return errors;
  },
});
export const ShapeSchema = Schema.Struct({
  key: shapeKey,
  attributes: list(key, 1, 200),
  required: Schema.optionalKey(list(key)),
  label: Schema.optionalKey(text(1, 200)),
});
export const shapeKind = defineKind(ShapeSchema, {
  name: "shape",
  collection: "shapes",
  identity: "key",
  order: 20,
  fields: ["key", "attributes", "required", "label"],
  references: (d) => [
    ...d.attributes.map((k, i) => ({ path: `attributes[${i}]`, to: "attribute" as const, key: k })),
    ...(d.required ?? []).map((k, i) => ({ path: `required[${i}]`, to: "attribute" as const, key: k, context: { members: d.attributes } })),
  ],
  check: (d, r) =>
    (d.required ?? []).flatMap((key, i) => {
      const a = d.attributes.includes(key) ? findAttribute(r, key) : undefined;
      return a?.type === "ref" && a.on_delete === "clear" ? [issue(`required[${i}]`, "Required ref cannot be cleared")] : [];
    }),
  structure: (d) => [...distinct(d.attributes, "attributes"), ...distinct(d.required ?? [], "required")],
});
export function automationKind(ops: Ops) {
  const actionSchema = Schema.make<Schema.Codec<Action>>(
    Schema.Json.check(
      Schema.makeFilter(
        (a) => {
          if (!a || typeof a !== "object" || Array.isArray(a)) return "Expected action";
          const name = String((a as Record<string, unknown>).op),
            op = Object.hasOwn(ops, name) ? ops[name] : undefined;
          return op
            ? decodeIssues(op.schema, a).map((x) => ({ path: x.field.split("."), issue: x.issue }))
            : [{ path: ["op"], issue: "Unknown operation" }];
        },
        {
          toJsonSchema: () => ({
            anyOf: Object.values(ops).map((op) => Schema.toJsonSchemaDocument(op.schema, { onExcessProperty: "error" }).schema),
          }),
        },
      ),
    ).ast,
  );
  return defineKind(
    Schema.Struct({
      id,
      shape: shapeKey,
      on: Schema.Struct({ changed: list(key, 1, 50) }),
      when: Schema.optionalKey(ruleSchema),
      do: list(actionSchema, 1, 10),
    }),
    {
      name: "automation",
      collection: "automations",
      identity: "id",
      order: 40,
      fields: ["id", "shape", "on", "when", "do"],
      references: (d) => [
        { path: "shape", to: "shape", key: d.shape },
        ...d.on.changed.map((k, i) => ({ path: `on.changed[${i}]`, to: "attribute" as const, key: k, context: { shape: d.shape } })),
        ...(d.when === undefined ? [] : ruleRefs(d.when, "when", d.shape)),
        ...d.do.flatMap((a, i) => (ops[a.op]?.references?.(a, d.shape) ?? []).map((x) => ({ ...x, path: `do[${i}].${x.path}` }))),
      ],
      check: (d, r) => [
        ...(d.when === undefined ? [] : typedRule(d.when, "when", d.shape, r)),
        ...d.do.flatMap((a, i) => prefix(`do[${i}]`, ops[a.op]?.check?.(a, d.shape, r) ?? [])),
      ],
      rules: (d) => (d.when === undefined ? [] : [d.when]),
      structure: (d) => distinct(d.on.changed, "on.changed"),
    },
  );
}
