import { Schema, SchemaRepresentation as R } from "effect";
import type { Attribute } from "./model.ts";
const datePattern = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
export const realDate = (s: string) =>
  datePattern.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const codePoints = () =>
  Schema.makeFilter((s: string) => Array.from(s).length <= 10000, {
    representation: { id: "data/codePoints", payload: null },
    toJsonSchema: () => ({ maxLength: 10000 }),
  });
const dateCheck = () =>
  Schema.makeFilter(realDate, {
    representation: { id: "data/date", payload: null },
    toJsonSchema: () => [{ format: "date" }, true],
  });
const revivers = [
  R.isFiniteReviver,
  R.isIntReviver,
  R.isPatternReviver,
  R.makeReviverFilter("data/codePoints", Schema.Null, codePoints),
  R.makeReviverFilter("data/date", Schema.Null, dateCheck),
];
export function valueSchema(a: Attribute): Schema.Codec<string | number | boolean> {
  const base: R.Representation =
    a.type === "enum"
      ? { _tag: "Union", types: a.values!.map((literal) => ({ _tag: "Literal", literal, checks: [] })), checks: [] }
      : { _tag: a.type === "boolean" ? "Boolean" : ["integer", "number"].includes(a.type) ? "Number" : "String", checks: [] };
  const ast = R.fromRepresentation({ representation: base, references: {} }, { revivers: [] }).ast;
  let schema: Schema.Codec<unknown> = Schema.make(ast);
  if (a.type === "string") schema = Schema.make<Schema.Codec<string>>(schema.ast).check(codePoints());
  if (a.type === "date") schema = Schema.make<Schema.Codec<string>>(schema.ast).check(Schema.isPattern(datePattern), dateCheck());
  if (a.type === "number") schema = Schema.make<Schema.Codec<number>>(schema.ast).check(Schema.isFinite());
  if (a.type === "integer") schema = Schema.make<Schema.Codec<number>>(schema.ast).check(Schema.isInt());
  const persisted = R.toJson(R.toRepresentation(schema.ast));
  return Schema.make<Schema.Codec<string | number | boolean>>(R.fromRepresentation(R.fromJson(persisted), { revivers }).ast);
}
