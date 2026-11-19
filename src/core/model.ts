import { Schema, SchemaIssue } from "effect";
export type Value = string | number | boolean;
export type Facts = Record<string, Value>;
export type Doc = Record<string, unknown>;
export type EdgePolicy = "block" | "clear";
export type Edge = { target: string; on_delete: EdgePolicy };
export type Attribute = Partial<Edge> & { key: string; type: string; values?: readonly string[]; label?: string; unique?: boolean };
export type Shape = { key: string; attributes: readonly string[]; required?: readonly string[] };
export type Condition = { fact: string; operator: string; value?: Value | Value[]; ignore_case?: boolean };
export type Rule = boolean | { all: Rule[] } | { any: Rule[] } | { not: Rule } | Condition;
export type Action = Doc & { op: string };
export type Automation = { id: string; shape: string; on: { changed: readonly string[] }; when?: Rule; do: readonly Action[] };
export type Registry = { attributes: Attribute[]; shapes: Shape[]; automations: Automation[]; [collection: string]: Doc[] };
export type Issue = { field: string; issue: string };
export type Ref = { path: string; to: string; key: string; context?: { shape?: string; members?: readonly string[] } };
export interface Kind<S extends Schema.Top> {
  name: string;
  collection: string;
  identity: string;
  order: number;
  schema: S;
  fields: string[];
  references(doc: S["Type"]): Ref[];
  check(doc: S["Type"], registry: Registry): Issue[];
  rules?(doc: S["Type"]): Rule[];
  structure?(doc: S["Type"]): Issue[];
}
export type Instruction = { type: "set"; attribute: string; value: Value | null } | { type: "outbox"; payload: Doc };
export interface Op<S extends Schema.Top> {
  schema: S;
  references?(action: S["Type"], shape: string): Ref[];
  check?(action: S["Type"], shape: string, registry: Registry): Issue[];
  handler(action: S["Type"]): Instruction;
}
export type Entity = {
  id: string;
  shape: string;
  facts: Facts;
  version: number;
  registry_version: number;
  created_at: string;
  updated_at: string;
};
export const defineKind = <S extends Schema.Top>(schema: S, options: Omit<Kind<S>, "schema">): Kind<S> => ({ schema, ...options });
export const defineOp = <S extends Schema.Top>(schema: S, options: Omit<Op<S>, "schema">): Op<S> => ({ schema, ...options });
export const issue = (field: string, message = "Invalid value"): Issue => ({ field, issue: message });
export const path = (parts: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> = []) =>
  parts.reduce<string>((s, p) => {
    const k = typeof p === "object" ? p.key : p;
    return typeof k === "number" ? `${s}[${k}]` : `${s}${s ? "." : ""}${String(k)}`;
  }, "");
const formatter = SchemaIssue.makeFormatterStandardSchemaV1();
export function decodeIssues(schema: Schema.Codec<unknown>, input: unknown): Issue[] {
  const result = Schema.decodeUnknownResult(schema, { onExcessProperty: "error", errors: "all" })(input);
  return result._tag === "Failure" ? formatter(result.failure.issue).issues.map((x) => issue(path(x.path), x.message)) : [];
}
export const object = (x: unknown): x is Doc => x !== null && typeof x === "object" && !Array.isArray(x);
export const canonical = (x: unknown): string =>
  JSON.stringify(
    Array.isArray(x)
      ? x.map((v) => JSON.parse(canonical(v)))
      : object(x)
        ? Object.fromEntries(
            Object.keys(x)
              .sort(compare)
              .map((k) => [k, JSON.parse(canonical(x[k]))]),
          )
        : x,
  );
export function compare(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!),
    y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export const text = (min: number, max: number) =>
  Schema.String.check(
    Schema.makeFilter((s: string) => Array.from(s).length >= min && Array.from(s).length <= max, {
      toJsonSchema: () => ({ minLength: min, maxLength: max }),
    }),
  );
export const key = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/));
export const shapeKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/));
export const id = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/));
export const list = <S extends Schema.Codec<unknown>>(schema: S, min = 0, max = 500) =>
  Schema.Array(schema).check(Schema.isMinLength(min), Schema.isMaxLength(max));
export const distinct = (values: readonly unknown[], field: string): Issue[] =>
  values.flatMap((v, i) => (values.indexOf(v) < i ? [issue(`${field}[${i}]`, "Duplicate value")] : []));
export const prefix = (base: string, issues: Issue[]) => issues.map((x) => ({ ...x, field: `${base}${x.field ? "." : ""}${x.field}` }));
export const findShape = (r: Registry, k: string) => r.shapes.find((s) => s.key === k);
export const findAttribute = (r: Registry, k: string) => r.attributes.find((a) => a.key === k);
