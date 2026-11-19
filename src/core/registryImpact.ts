import { attributeEdges } from "./kinds.ts";
import { canonical, type Registry } from "./model.ts";

export type ShapeImpact = {
  fields: Set<string>;
  unique: Set<string>;
  refs: Set<string>;
};

// A committed entity satisfies the current registry, so only stricter or
// changed constraints can introduce violations. Removal also needs projection work.
export function registryImpact(current: Registry, desired: Registry) {
  const shapes = new Map<string, ShapeImpact>();
  const targets = new Set<string>();
  const attributes = new Map(current.attributes.map((a) => [a.key, a]));
  const previousEdges = attributeEdges(current.attributes);
  const desiredEdges = attributeEdges(desired.attributes);
  const desiredShapes = new Map(desired.shapes.map((s) => [s.key, s]));
  const nextAttributes = new Map(desired.attributes.map((a) => [a.key, a]));
  for (const before of current.shapes) {
    const next = desiredShapes.get(before.key);
    const impact: ShapeImpact = { fields: new Set(), unique: new Set(), refs: new Set() };
    if (!next || before.attributes.some((key) => !next.attributes.includes(key))) shapes.set(before.key, impact);
    if (!next) continue;
    for (const key of next.required ?? []) if (!before.required?.includes(key)) impact.fields.add(key);
    for (const key of before.attributes) {
      if (!next.attributes.includes(key)) continue;
      const old = attributes.get(key);
      const attr = nextAttributes.get(key);
      if (old?.type !== attr?.type || canonical(old?.values ?? null) !== canonical(attr?.values ?? null)) impact.fields.add(key);
      if (attr?.unique && !old?.unique) impact.unique.add(key);
      const edge = desiredEdges.get(key);
      if (edge && (canonical(previousEdges.get(key) ?? null) !== canonical(edge) || !desiredShapes.has(edge.target))) {
        impact.refs.add(key);
        if (desiredShapes.has(edge.target)) targets.add(edge.target);
      }
    }
    if (impact.fields.size || impact.unique.size || impact.refs.size) shapes.set(before.key, impact);
  }
  return { shapes, targets };
}

export type RegistryImpact = ReturnType<typeof registryImpact>;
