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
  const recheckUnique = new Set<string>();
  const empty = (): ShapeImpact => ({ fields: new Set(), unique: new Set(), refs: new Set() });
  for (const before of current.shapes) {
    const next = desiredShapes.get(before.key);
    const impact = empty();
    if (!next) {
      shapes.set(before.key, impact);
      continue;
    }
    for (const key of next.required ?? []) if (!before.required?.includes(key)) impact.fields.add(key);
    for (const key of next.attributes) {
      const old = attributes.get(key);
      if (!old) continue;
      const attr = nextAttributes.get(key);
      const visible = before.attributes.includes(key);
      if (!visible || old.type !== attr?.type || canonical(old.values ?? null) !== canonical(attr?.values ?? null)) impact.fields.add(key);
      if (attr?.unique && (!visible || !old.unique)) recheckUnique.add(key);
      const edge = desiredEdges.get(key);
      if (edge && (!visible || canonical(previousEdges.get(key) ?? null) !== canonical(edge) || !desiredShapes.has(edge.target))) {
        impact.refs.add(key);
        if (desiredShapes.has(edge.target)) targets.add(edge.target);
      }
    }
    if (impact.fields.size || impact.refs.size) shapes.set(before.key, impact);
  }
  for (const shape of desired.shapes) {
    for (const key of shape.attributes) {
      if (!recheckUnique.has(key)) continue;
      const impact = shapes.get(shape.key) ?? empty();
      impact.unique.add(key);
      shapes.set(shape.key, impact);
    }
  }
  return { shapes, targets };
}

export type RegistryImpact = ReturnType<typeof registryImpact>;

export function slotChanges(current: Registry, desired: Registry) {
  const before = new Set(current.attributes.filter((a) => a.unique).map((a) => a.key));
  const after = new Set(desired.attributes.filter((a) => a.unique).map((a) => a.key));
  const previousShapes = new Map(current.shapes.map((s) => [s.key, s.attributes]));
  const nextShapes = new Map(desired.shapes.map((s) => [s.key, s.attributes]));
  const changes = new Map<string, { release: string[]; claim: string[] }>();
  for (const [shape, oldMembers] of previousShapes) {
    const nextMembers = nextShapes.get(shape) ?? [];
    const release = oldMembers.filter((key) => before.has(key) && (!after.has(key) || !nextMembers.includes(key)));
    const claim = nextMembers.filter((key) => after.has(key) && (!before.has(key) || !oldMembers.includes(key)));
    if (release.length || claim.length) changes.set(shape, { release, claim });
  }
  return changes;
}
