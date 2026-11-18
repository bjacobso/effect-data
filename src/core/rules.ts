import { Schema } from "effect";
import {
  type Rule,
  type Condition,
  type Facts,
  type Value,
  type Issue,
  type Ref,
  type Registry,
  object,
  issue,
  findShape,
  findAttribute,
  decodeIssues,
} from "./model.ts";
import { valueSchema } from "./values.ts";
export const operators = [
  "equal",
  "notEqual",
  "lessThan",
  "lessThanInclusive",
  "greaterThan",
  "greaterThanInclusive",
  "in",
  "notIn",
  "contains",
  "doesNotContain",
  "exists",
  "doesNotExist",
];
const scalar = (v: unknown) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
export function ruleIssues(r: unknown, p: PropertyKey[] = [], depth = 1): Schema.FilterIssue[] {
  const fail = (k: PropertyKey[] = p, message = "Invalid rule"): Schema.FilterIssue[] => [{ path: k, issue: message }];
  if (depth > 20) return fail(p, "Maximum rule depth is 20");
  if (typeof r === "boolean") return [];
  if (!object(r)) return fail();
  const branch = ["all", "any", "not"].find((k) => k in r);
  if (branch) {
    if (Object.keys(r).length !== 1) return fail();
    if (branch === "not") return ruleIssues(r.not, [...p, "not"], depth + 1);
    const children = r[branch];
    if (!Array.isArray(children) || children.length > 500) return fail([...p, branch]);
    return children.flatMap((n: unknown, i: number) => ruleIssues(n, [...p, branch, i], depth + 1));
  }
  const out = Object.keys(r)
    .filter((k) => !["fact", "operator", "value", "ignore_case"].includes(k))
    .flatMap((k) => fail([...p, k], "Unknown property"));
  if (typeof r.fact !== "string" || !/^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/.test(r.fact)) out.push(...fail([...p, "fact"]));
  if (!operators.includes(String(r.operator))) out.push(...fail([...p, "operator"]));
  if (["exists", "doesNotExist"].includes(String(r.operator))) {
    if ("value" in r) out.push(...fail([...p, "value"]));
  } else if (
    ["in", "notIn"].includes(String(r.operator))
      ? !Array.isArray(r.value) || !r.value.length || r.value.length > 500 || !r.value.every(scalar)
      : !scalar(r.value)
  )
    out.push(...fail([...p, "value"]));
  if ("ignore_case" in r && typeof r.ignore_case !== "boolean") out.push(...fail([...p, "ignore_case"]));
  return out;
}
export const ruleSchema = Schema.Json.check(
  Schema.makeFilter((r) => ruleIssues(r), { toJsonSchema: () => [{}, true] }),
) as Schema.Codec<Rule>;
export function conditions(r: Rule, p = ""): { node: Condition; path: string }[] {
  if (typeof r === "boolean") return [];
  if ("not" in r) return conditions(r.not, `${p}.not`);
  if ("all" in r || "any" in r) {
    const k = "all" in r ? "all" : "any";
    return ("all" in r ? r.all : r.any).flatMap((n: Rule, i: number) => conditions(n, `${p}.${k}[${i}]`));
  }
  return [{ node: r, path: p }];
}
export const ruleRefs = (r: Rule, p: string, shape: string): Ref[] =>
  conditions(r, p).map(({ node, path }) => ({ path: `${path}.fact`, to: "attribute", key: node.fact, context: { shape } }));
export function typedRule(r: Rule, p: string, shape: string, registry: Registry): Issue[] {
  return conditions(r, p).flatMap(({ node: n, path: p }) => {
    const a = findAttribute(registry, n.fact);
    if (!a || !findShape(registry, shape)?.attributes.includes(n.fact)) return [];
    const out: Issue[] = [];
    const ordering = /^(lessThan|greaterThan)/.test(n.operator);
    if (
      (ordering && !["integer", "number", "date"].includes(a.type)) ||
      (["contains", "doesNotContain"].includes(n.operator) && a.type !== "string")
    )
      out.push(issue(`${p}.operator`, "Operator incompatible with attribute type"));
    if (n.value !== undefined && !out.length) {
      const schema = ["integer", "number"].includes(a.type) ? Schema.Finite : valueSchema(a);
      if ((Array.isArray(n.value) ? n.value : [n.value]).some((v) => decodeIssues(schema, v).length))
        out.push(issue(`${p}.value`, "Operand incompatible with attribute type"));
    }
    if (n.ignore_case !== undefined && !["string", "enum"].includes(a.type))
      out.push(issue(`${p}.ignore_case`, "Only string and enum support ignore_case"));
    return out;
  });
}
export type Tri = "T" | "F" | "U";
export const and = (xs: Tri[]): Tri => (xs.includes("F") ? "F" : xs.includes("U") ? "U" : "T");
export function evaluator(r: Rule): (facts: Facts) => Tri {
  if (typeof r === "boolean") return () => (r ? "T" : "F");
  if ("not" in r) {
    const e = evaluator(r.not);
    return (f) => (({ T: "F", F: "T", U: "U" }) as const)[e(f)];
  }
  if ("all" in r || "any" in r) {
    const all = "all" in r,
      es = (all ? r.all : (r as { any: Rule[] }).any).map(evaluator);
    return (f) => {
      const xs = es.map((e) => e(f));
      return all ? and(xs) : xs.includes("T") ? "T" : xs.includes("U") ? "U" : "F";
    };
  }
  return (facts) => {
    const present = facts[r.fact];
    if (r.operator === "exists") return present == null ? "F" : "T";
    if (r.operator === "doesNotExist") return present == null ? "T" : "F";
    if (present == null) return "U";
    const lower = (x: Value) => (r.ignore_case && typeof x === "string" ? x.toLowerCase() : x);
    const f = lower(present),
      raw = r.value,
      v = Array.isArray(raw) ? raw.map(lower) : raw === undefined ? undefined : lower(raw);
    const eq = (x: unknown) => typeof f === typeof x && f === x;
    const order =
      typeof f === "number" && typeof v === "number"
        ? f < v
          ? -1
          : f > v
            ? 1
            : 0
        : typeof f === "string" && typeof v === "string"
          ? f < v
            ? -1
            : f > v
              ? 1
              : 0
          : undefined;
    let yes = false;
    switch (r.operator) {
      case "equal":
        yes = eq(v);
        break;
      case "notEqual":
        yes = !eq(v);
        break;
      case "in":
        yes = Array.isArray(v) && v.some(eq);
        break;
      case "notIn":
        yes = !Array.isArray(v) || !v.some(eq);
        break;
      case "contains":
      case "doesNotContain":
        yes = typeof f === "string" && typeof v === "string" && f.includes(v);
        if (r.operator === "doesNotContain") yes = !yes;
        break;
      case "lessThan":
        yes = order !== undefined && order < 0;
        break;
      case "lessThanInclusive":
        yes = order !== undefined && order <= 0;
        break;
      case "greaterThan":
        yes = order !== undefined && order > 0;
        break;
      case "greaterThanInclusive":
        yes = order !== undefined && order >= 0;
        break;
    }
    return yes ? "T" : "F";
  };
}
