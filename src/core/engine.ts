import { Context, Effect, Layer, Schema } from "effect";
import {
  type Registry,
  type Entity,
  type Issue,
  type Facts,
  type Shape,
  type Automation,
  list,
  issue,
  prefix,
  decodeIssues,
  compare,
  canonical,
  findShape,
  findAttribute,
} from "./model.ts";
import { evaluator } from "./rules.ts";
import { valueSchema } from "./values.ts";
import { KindRegistry, type RegisteredKind } from "./registry.ts";
export function engine(kinds: readonly RegisteredKind[]) {
  const empty = (): Registry => Object.fromEntries(kinds.map((k) => [k.collection, []])) as unknown as Registry;
  const fields: Record<string, Schema.Codec<unknown>> = Object.fromEntries(kinds.map((k) => [k.collection, list(k.schema)]));
  const normalize = (input: Partial<Registry>): Registry =>
    ({ ...empty(), ...Object.fromEntries(kinds.map((k) => [k.collection, input[k.collection] ?? []])) }) as Registry;
  const payload = (requiredBase = false) =>
    Schema.Struct({
      ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, Schema.optionalKey(schema)])),
      base_version: requiredBase
        ? Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
        : Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    });
  const structure = (input: unknown, requiredBase = false): Issue[] => {
    const errors = decodeIssues(payload(requiredBase), input);
    if (errors.length) return errors;
    const r = normalize(input as Registry);
    return kinds.flatMap((k) =>
      r[k.collection]!.flatMap((d, i, docs) =>
        prefix(`${k.collection}[${i}]`, [
          ...(docs.findIndex((x) => x[k.identity] === d[k.identity]) < i ? [issue(k.identity, "Duplicate identity")] : []),
          ...(k.structure?.(d) ?? []),
        ]),
      ),
    );
  };
  function check(r: Registry): Issue[] {
    r = normalize(r);
    return kinds.flatMap((k) =>
      (r[k.collection] ?? []).flatMap((d, i) => {
        const missingShape = k.references(d).find((ref) => ref.to === "shape" && !findShape(r, ref.key));
        if (missingShape) return prefix(`${k.collection}[${i}]`, [issue(missingShape.path, "Unknown shape")]);
        const errors = k
          .references(d)
          .flatMap((ref) => {
            const target = kinds.find((k) => k.name === ref.to);
            const resolved = target && r[target.collection]?.find((d) => d[target.identity] === ref.key);
            const members = ref.context?.members ?? (ref.context?.shape ? findShape(r, ref.context.shape)?.attributes : undefined);
            return !resolved || (ref.context?.shape && !members) || (members && !members.includes(ref.key))
              ? [issue(ref.path, `Unknown ${ref.to} in context`)]
              : [];
          })
          .concat(k.check(d, r));
        const rank = (p: string) => {
          const root = p.split(/[.[]/)[0]!;
          return k.fields.indexOf(root);
        };
        errors.sort((a, b) => rank(a.field) - rank(b.field) || natural(a.field, b.field));
        return prefix(`${k.collection}[${i}]`, errors);
      }),
    );
  }
  function compile(r: Registry) {
    const attributes = new Map((r.attributes ?? []).map((a) => [a.key, valueSchema(a)]));
    const schemas = new Map(
      (r.shapes ?? []).map((s) => [
        s.key,
        Schema.Struct(
          Object.fromEntries(
            s.attributes.map((key: string) => [
              key,
              s.required?.includes(key) ? attributes.get(key)! : Schema.optionalKey(attributes.get(key)!),
            ]),
          ),
        ) as Schema.Codec<Facts>,
      ]),
    );
    const rules = new Map<string, ReturnType<typeof evaluator>>();
    for (const kind of kinds)
      for (const d of r[kind.collection] ?? []) for (const rule of kind.rules?.(d) ?? []) rules.set(canonical(rule), evaluator(rule));
    const reactions = new Map<string, Automation[]>();
    for (const d of r.automations ?? []) for (const key of d.on.changed) reactions.set(key, [...(reactions.get(key) ?? []), d]);
    return { schemas, attributes, rules, reactions };
  }
  function validate(r: Registry, shape: string, facts: Facts): Issue[] {
    const s = findShape(r, shape);
    if (!s) return [issue("shape", "Unknown shape")];
    return decodeIssues(compile(r).schemas.get(shape)!, facts).map((x) => issue(`facts.${x.field}`, x.issue));
  }
  function plan(current: Registry, desired: Registry, live: Entity[], version = 0) {
    current = normalize(current);
    desired = normalize(desired);
    const issues = check(desired),
      changes: { kind: string; key: string; change: string }[] = [];
    for (const k of kinds) {
      const old = new Map((current[k.collection] ?? []).map((d) => [String(d[k.identity]), d])),
        next = new Map((desired[k.collection] ?? []).map((d) => [String(d[k.identity]), d]));
      for (const key of [...new Set([...old.keys(), ...next.keys()])].sort(compare)) {
        if (!old.has(key)) changes.push({ kind: k.name, key, change: "added" });
        else if (!next.has(key)) changes.push({ kind: k.name, key, change: "removed" });
        else if (canonical(old.get(key)) !== canonical(next.get(key))) changes.push({ kind: k.name, key, change: "modified" });
      }
    }
    const violations: (Issue & { entity_id: string })[] = [],
      seen = new Set<string>();
    const compiled = issues.length ? undefined : compile(desired);
    if (!issues.length)
      for (const e of [...live].sort((a, b) => compare(a.id, b.id))) {
        const s = findShape(desired, e.shape),
          facts = s ? retain(e.facts, s) : {};
        const errors = s
          ? decodeIssues(compiled!.schemas.get(e.shape)!, facts).map((x) => issue(`facts.${x.field}`, x.issue))
          : [issue("shape", "Unknown shape")];
        for (const [k, v] of Object.entries(facts))
          if (findAttribute(desired, k)?.unique) {
            const identity = canonical([k, v]);
            if (seen.has(identity)) errors.push(issue(`facts.${k}`, "Duplicate unique value"));
            else seen.add(identity);
          }
        violations.push(...errors.map((x) => ({ entity_id: e.id, ...x })));
      }
    violations.sort((a, b) => compare(a.entity_id, b.entity_id) || compare(a.field, b.field));
    return {
      from_version: version,
      to_version: version + 1,
      applicable: !issues.length && !violations.length,
      issues,
      changes,
      violations,
    };
  }
  return { kinds, fields, payload, empty, normalize, structure, check, compile, validate, plan };
}
function natural(a: string, b: string): number {
  const tokens = (s: string) => s.match(/[a-z_]+|[0-9]+/g) ?? [];
  const x = tokens(a),
    y = tokens(b),
    order = ["fact", "operator", "value", "ignore_case"];
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) {
      if (/^\d+$/.test(x[i]!) && /^\d+$/.test(y[i]!)) return +x[i]! - +y[i]!;
      const l = order.indexOf(x[i]!),
        r = order.indexOf(y[i]!);
      return l >= 0 && r >= 0 ? l - r : compare(x[i]!, y[i]!);
    }
  return x.length - y.length;
}
export const retain = (facts: Facts, s: Shape): Facts =>
  Object.fromEntries(Object.entries(facts).filter(([k]) => s.attributes.includes(k)));
export const merge = (facts: Facts, patch: Record<string, unknown>): Facts =>
  Object.fromEntries(Object.entries({ ...facts, ...patch }).filter(([, v]) => v !== null)) as Facts;
export type EngineValue = ReturnType<typeof engine> & { ops: import("./registry.ts").Ops };
export class Engine extends Context.Service<Engine, EngineValue>()("data/Engine") {
  static layer = Layer.effect(
    Engine,
    Effect.map(KindRegistry, (r) => ({ ...engine(r.kinds), ops: r.ops })),
  );
}
export type Compiled = ReturnType<EngineValue["compile"]>;
