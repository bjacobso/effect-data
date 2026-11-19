import { compare, issue, type Entity, type Issue, type Value } from "./model.ts";

export type ViolationIssue = "duplicate" | "dangling_reference";
export type Violation = Issue & { entity_id: string; deferred?: ViolationIssue };
export type EntityReview = {
  issues: Issue[];
  refs: { key: string; value: Value; target: string; deferred: boolean }[];
  slots: { key: string; identity: string }[];
};

export function reviewIssues(
  id: string,
  review: EntityReview,
  targets: ReadonlyMap<string, string>,
  duplicate: (identity: string) => boolean,
): Violation[] {
  const errors: (Issue & { deferred?: ViolationIssue })[] = [...review.issues];
  for (const { key, value, target, deferred } of review.refs)
    if (typeof value !== "string" || targets.get(value) !== target) {
      const field = `facts.${key}`;
      const existing = errors.findIndex((x) => x.field === field);
      if (existing >= 0) errors.splice(existing, 1);
      errors.push({ ...issue(field, "Dangling reference"), ...(deferred && existing < 0 ? { deferred: "dangling_reference" } : {}) });
    }
  for (const { key, identity } of review.slots)
    if (duplicate(identity)) errors.push({ ...issue(`facts.${key}`, "Duplicate unique value"), deferred: "duplicate" });
  return errors.map((x) => ({ entity_id: id, ...x }));
}

// Build indexes once during the snapshot scan. A delta can affect its own
// checks, referrers of a removed target, or the first id in a duplicate group.
export function registryReview(inspect: (entity: Entity) => EntityReview | undefined) {
  type Group = { first: string; ids: Set<string> };
  const reviews = new Map<string, EntityReview>();
  const targets = new Map<string, string>();
  const readers = new Map<string, Set<string>>();
  const slots = new Map<string, string | Group>();
  const dirty = new Set<string>();
  const violations = new Map<string, Violation[]>();
  let initial = true;
  const revisit = (id: string) => {
    if (!initial) dirty.add(id);
  };

  function addSlot(identity: string, id: string) {
    const group = slots.get(identity);
    if (!group) slots.set(identity, id);
    else if (typeof group === "string") {
      const first = compare(id, group) < 0 ? id : group;
      slots.set(identity, { first, ids: new Set([group, id]) });
      if (first === id) revisit(group);
    } else {
      group.ids.add(id);
      if (compare(id, group.first) < 0) {
        revisit(group.first);
        group.first = id;
      }
    }
  }

  function removeSlot(identity: string, id: string) {
    const group = slots.get(identity)!;
    if (typeof group === "string") slots.delete(identity);
    else {
      group.ids.delete(id);
      if (group.first === id) {
        const [first, ...rest] = group.ids;
        group.first = rest.reduce((lowest, candidate) => (compare(candidate, lowest) < 0 ? candidate : lowest), first!);
        revisit(group.first);
      }
      if (group.ids.size === 1) slots.set(identity, group.first);
    }
  }

  function setTarget(id: string, shape: string | undefined) {
    if (targets.get(id) === shape) return;
    if (shape === undefined) targets.delete(id);
    else targets.set(id, shape);
    if (!initial) for (const source of readers.get(id) ?? []) dirty.add(source);
  }

  function setEntity(id: string, entity: Entity | undefined) {
    const before = reviews.get(id);
    const after = entity && inspect(entity);
    if (!before && !after) return;
    for (const { identity } of before?.slots ?? []) removeSlot(identity, id);
    for (const { identity } of after?.slots ?? []) addSlot(identity, id);
    for (const value of new Set(before?.refs.map((ref) => ref.value)))
      if (typeof value === "string") {
        const sources = readers.get(value)!;
        sources.delete(id);
        if (!sources.size) readers.delete(value);
      }
    for (const value of new Set(after?.refs.map((ref) => ref.value)))
      if (typeof value === "string") {
        const sources = readers.get(value) ?? new Set<string>();
        sources.add(id);
        readers.set(value, sources);
      }
    if (after) reviews.set(id, after);
    else reviews.delete(id);
    revisit(id);
  }

  function finish() {
    for (const id of initial ? reviews.keys() : dirty) {
      const review = reviews.get(id);
      const found = !review
        ? []
        : reviewIssues(id, review, targets, (identity) => {
            const group = slots.get(identity)!;
            return typeof group !== "string" && group.first !== id;
          });
      if (found.length) violations.set(id, found);
      else violations.delete(id);
    }
    initial = false;
    dirty.clear();
    return [...violations.values()].flat();
  }
  return { setEntity, setTarget, finish };
}
