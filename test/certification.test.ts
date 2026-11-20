import { expect, test } from "vitest";
import { Effect } from "effect";
import { compose, selectPacks } from "../src/composition.ts";
import { Engine } from "../src/core/engine.ts";
import { KindRegistry } from "../src/core/registry.ts";
import { Packs } from "../src/Packs.ts";
import { certifications } from "../src/packs/certification/documents.ts";
import type { Registry, Entity } from "../src/core/model.ts";
const app = compose(selectPacks("onboarding,certification"));
export const fixture = (): Registry => ({
  attributes: [
    { key: "x/date", type: "date" },
    { key: "x/role", type: "enum", values: ["driver", "office"] },
    { key: "x/text", type: "string" },
  ],
  shapes: [
    { key: "employee", attributes: ["x/date", "x/role", "x/text"] },
    { key: "visitor", attributes: ["x/date"] },
  ],
  policies: [],
  certification_requirements: [{ id: "license", name: "Licence", shape: "employee", expires: "x/date", renew_within_days: 30 }],
  automations: [
    {
      id: "send",
      shape: "employee",
      on: { changed: ["x/date"] },
      do: [
        { op: "schedule_renewal", requirement: "license" },
        { op: "notify", message: "sent" },
      ],
    },
  ],
});
const entity = (facts: Entity["facts"]): Entity => ({
  id: "en_AAAAAAAAAAAAAAAAAAAAA",
  shape: "employee",
  facts,
  version: 1,
  registry_version: 1,
  created_at: "",
  updated_at: "",
});

test("certification registry checks and compiles using existing kind/op primitives", () => {
  const r = fixture();
  expect(app.structure(r)).toEqual([]);
  expect(app.check(r)).toEqual([]);
  expect(app.kinds.map((k) => k.name)).toEqual(["attribute", "shape", "policy", "certification_requirement", "automation", "query"]);
  expect(app.compile(r).schemas.has("employee")).toBe(true);
  const removed = { ...r, certification_requirements: [] };
  expect(app.plan(r, removed, []).issues.map((x) => x.field)).toEqual(["automations[0].do[0].requirement"]);
  expect(app.plan(r, removed, []).changes).toEqual([{ kind: "certification_requirement", key: "license", change: "removed" }]);
});

test("expiry typing, missing references, shape scoping, and typed rules produce one ordered issue", () => {
  const r = fixture(),
    base = r.certification_requirements![0]!;
  r.certification_requirements = [
    { ...base, id: "wrong-type", expires: "x/text" },
    { ...base, id: "unknown", expires: "missing/expiry" },
    {
      ...base,
      id: "no-shape",
      shape: "missing",
      expires: "missing/expiry",
      applies_when: { fact: "missing/fact", operator: "lessThan", value: true },
    },
    { ...base, id: "other", shape: "visitor", expires: "x/role" },
    { ...base, id: "typed", applies_when: { fact: "x/role", operator: "lessThan", value: "driver" } },
    { ...base, id: "visitor", shape: "visitor" },
  ];
  r.automations[0]!.do = [
    { op: "schedule_renewal", requirement: "missing" },
    { op: "schedule_renewal", requirement: "visitor" },
  ];
  expect(app.check(r).map((x) => x.field)).toEqual([
    "certification_requirements[0].expires",
    "certification_requirements[1].expires",
    "certification_requirements[2].shape",
    "certification_requirements[3].expires",
    "certification_requirements[4].applies_when.operator",
    "automations[0].do[0].requirement",
    "automations[0].do[1].requirement",
  ]);
});

test("all certification statuses retain dates whenever present and use UTC calendar arithmetic", () => {
  const r = fixture();
  r.automations = [];
  const base = r.certification_requirements![0]!;
  const status = (facts: Entity["facts"], on: string) => certifications(r, entity(facts), on, app.compile(r)).data[0];
  expect(status({}, "2024-02-01")).toEqual({ requirement: "license", status: "missing" });
  expect(status({ "x/date": "2024-03-01" }, "2024-01-30")).toMatchObject({ status: "valid", renew_by: "2024-01-31" });
  expect(status({ "x/date": "2024-03-01" }, "2024-01-31")).toMatchObject({ status: "due", renew_by: "2024-01-31" });
  expect(status({ "x/date": "2024-03-01" }, "2024-03-01")).toMatchObject({ status: "due" });
  expect(status({ "x/date": "2024-03-01" }, "2024-03-02")).toMatchObject({ status: "expired" });
  r.certification_requirements = [{ ...base, applies_when: { fact: "x/role", operator: "equal", value: "driver" } }];
  expect(status({ "x/date": "2024-03-01" }, "2024-02-01")).toMatchObject({
    status: "undetermined",
    expires: "2024-03-01",
    renew_by: "2024-01-31",
  });
  expect(status({ "x/date": "2024-03-01", "x/role": "office" }, "2024-04-01")).toMatchObject({
    status: "not_applicable",
    expires: "2024-03-01",
  });
});

test("enabled collections are optional inputs and normalized outputs; disabled collections are rejected", () => {
  expect(app.structure({})).toEqual([]);
  expect(app.normalize({})).toEqual(app.empty());
  const single = compose(selectPacks("onboarding"));
  expect(single.structure({ certification_requirements: [] }).map((x) => x.field)).toEqual(["certification_requirements"]);
  expect(single.empty()).not.toHaveProperty("certification_requirements");
  expect(app.plan({} as Registry, {} as Registry, []).applicable).toBe(true);
  expect(app.check({} as Registry)).toEqual([]);
});

test("selection preserves pack order, supports zero/one/multiple packs and rejects unknown names", () => {
  expect(selectPacks("certification,onboarding").map((p) => p.name)).toEqual(["certification", "onboarding"]);
  expect(compose(selectPacks("")).empty()).toEqual({ attributes: [], shapes: [], automations: [], queries: [] });
  expect(() => selectPacks("not-a-pack")).toThrow("Unknown pack");
  expect(() => selectPacks("onboarding,onboarding")).toThrow("Duplicate pack");
});

test("compose and Layers use the same registry, operations and selected packs", async () => {
  for (const selected of ["", "onboarding", "certification", "certification,onboarding"]) {
    const packs = selectPacks(selected),
      composed = compose(packs);
    const actual = await Effect.runPromise(
      Effect.gen(function* () {
        const e = yield* Engine,
          k = yield* KindRegistry,
          p = yield* Packs;
        return { empty: e.empty(), kinds: k.kinds.map((d) => d.name), ops: Object.keys(e.ops), packs: p.map((d) => d.name) };
      }).pipe(Effect.provide(composed.layer)),
    );
    expect(actual).toEqual({
      empty: composed.empty(),
      kinds: composed.kinds.map((k) => k.name),
      ops: Object.keys(composed.ops),
      packs: packs.map((p) => p.name),
    });
  }
});
