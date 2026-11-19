import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { Schema, Arbitrary, Effect } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { compose } from "../src/composition.ts";
import { engine } from "../src/core/engine.ts";
import { registryImpact } from "../src/core/registryImpact.ts";
import { collect } from "../src/core/registry.ts";
import { defineKind, defineOp } from "../src/core/model.ts";
import { policyKind, ops } from "../src/packs/onboarding/documents.ts";
const app = compose([{ name: "onboarding", kinds: [policyKind], ops }]);
import { evaluator, ruleIssues } from "../src/core/rules.ts";
import { type Attribute, type Registry, type Rule, type Entity, decodeIssues, canonical } from "../src/core/model.ts";
import { valueSchema } from "../src/core/values.ts";
import { evaluate } from "../src/packs/onboarding/index.ts";
import { fixture } from "./fixtures.ts";
const entity = (facts: Entity["facts"]): Entity => ({
  id: "en_AAAAAAAAAAAAAAAAAAAAA",
  shape: "employee",
  facts,
  version: 1,
  registry_version: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

describe("registry pipeline", () => {
  test("classified plans agree with full revalidation across registry pairs and valid live projections", () => {
    const id = (n: number) => `en_${String(n).padStart(21, "0")}`;
    fc.assert(
      fc.property(
        fc.record({
          startedUnique: fc.boolean(),
          makeUnique: fc.boolean(),
          required: fc.boolean(),
          keepMember: fc.boolean(),
          removeTarget: fc.boolean(),
          refType: fc.constantFrom("leave", "retarget", "string", "clear"),
          valueType: fc.constantFrom("string", "integer", "enum"),
          enumValues: fc.subarray(["a", "b", "\u0000", "\ud800"], { minLength: 1 }),
          addPolicy: fc.boolean(),
          rows: fc.array(fc.record({ value: fc.option(fc.constantFrom("a", "b", "\u0000", "\ud800")), linked: fc.boolean() })),
        }),
        (sample) => {
          const current: Registry = {
            attributes: [
              { key: "data/value", type: "string", unique: sample.startedUnique },
              { key: "data/link", type: "ref", target: "target" },
              { key: "data/name", type: "string" },
            ],
            shapes: [
              { key: "source", attributes: ["data/value", "data/link"] },
              { key: "target", attributes: ["data/name"] },
              { key: "other", attributes: ["data/name", "data/value"] },
            ],
            automations: [],
          };
          const live = [
            { ...entity({}), shape: "target", id: id(0) },
            ...sample.rows.map(({ value, linked }, i) => ({
              ...entity({
                ...(value === null ? {} : { "data/value": sample.startedUnique ? value + i : value }),
                ...(linked && i % 2 === 0 ? { "data/link": id(0) } : {}),
              }),
              shape: i % 2 === 0 ? "source" : "other",
              id: id(i + 1),
            })),
          ].reverse();
          const link = current.attributes[1]!;
          const desired: Registry = {
            ...current,
            attributes: [
              {
                key: "data/value",
                type: sample.valueType,
                unique: sample.makeUnique,
                ...(sample.valueType === "enum" ? { values: sample.enumValues } : {}),
                label: "Value",
              },
              sample.refType === "string"
                ? { key: link.key, type: "string" }
                : sample.refType === "retarget"
                  ? { ...link, target: "other" }
                  : sample.refType === "clear"
                    ? { ...link, on_delete: "clear" }
                    : link,
              current.attributes[2]!,
              { key: "data/extra", type: "boolean" },
            ],
            shapes: [
              {
                key: "source",
                attributes: ["data/link", "data/extra", ...(sample.keepMember ? ["data/value"] : [])],
                required: sample.required && sample.keepMember ? ["data/value"] : [],
              },
              ...current.shapes.slice(sample.removeTarget ? 2 : 1),
            ],
            policies: sample.addPolicy ? [{ id: "extra", shape: "source", applies_when: true, requires: [{ form: "test" }] }] : [],
          };
          expect(app.plan(current, current, live).violations).toEqual([]);
          const impact = registryImpact(current, desired);
          const candidates = live.filter((e) => impact.shapes.has(e.shape));
          const targets = new Map(live.filter((e) => impact.targets.has(e.shape)).map((e) => [e.id, e.shape]));
          expect(app.plan(current, desired, candidates, 1, undefined, { impact, targets })).toEqual(app.plan(current, desired, live, 1));
        },
      ),
      { numRuns: 400 },
    );
  });

  test("fixture checks, compiles real schemas, plans canonical differences", () => {
    const r = fixture(),
      c = app.compile(r);
    expect(app.structure(r)).toEqual([]);
    expect(app.check(r)).toEqual([]);
    expect(decodeIssues(c.schemas.get("employee")!, { "person/email": "a", "employee/level": 1.5 }).map((x) => x.field)).toEqual([
      "employee/level",
    ]);
    expect(c.reactions.get("employee/state")?.map((a) => a.id)).toEqual(["hire"]);
    expect(c.rules.get(canonical({ fact: "employee/state", operator: "equal", value: "CO" }))?.({ "employee/state": "CO" })).toBe("T");
    expect(app.plan(r, JSON.parse(JSON.stringify(r)), [], 4)).toMatchObject({
      from_version: 4,
      to_version: 5,
      applicable: true,
      changes: [],
    });
    const desired = fixture();
    desired.attributes![0]!.label = "Email";
    expect(app.plan(r, desired, []).changes).toEqual([{ kind: "attribute", key: "person/email", change: "modified" }]);
  });
  test("plan drops removed attributes, reports required/type/unique/removal violations", () => {
    const r = fixture(),
      desired = fixture();
    desired.automations = [];
    desired.policies = [];
    desired.shapes![0]!.attributes = desired.shapes![0]!.attributes.filter((k: string) => k !== "employee/state");
    expect(app.plan(r, desired, [entity({ "person/email": "a", "employee/state": "CA" })]).applicable).toBe(true);
    desired.attributes![0]!.type = "integer";
    expect(app.plan(r, desired, [entity({ "person/email": "a" })]).violations.map((x) => x.field)).toEqual(["facts.person/email"]);
    const second = { ...entity({ "person/email": "a" }), id: "en_BBBBBBBBBBBBBBBBBBBBB" };
    expect(app.plan(r, r, [second, entity({ "person/email": "a" })]).violations.map((x) => x.entity_id)).toEqual([second.id]);
    expect(app.plan(r, { ...r, shapes: [], policies: [], automations: [] }, [second]).violations.map((x) => x.field)).toEqual(["shape"]);
  });
  test("a fifth kind contributes schemas, references, and checks without checker changes", () => {
    const extended = engine(
      collect(
        [
          ...compose([]).kinds,
          defineKind(Schema.Struct({ id: Schema.String, target: Schema.String }), {
            name: "view",
            collection: "views",
            identity: "id",
            fields: ["id", "target"],
            order: 50,
            references: (d) => [{ path: "target", to: "shape", key: d.target }],
            check: () => [],
          }),
        ],
        {},
      ).kinds,
    );
    const r = { ...extended.empty(), views: [{ id: "x", target: "missing" }] };
    expect(extended.structure(r)).toEqual([]);
    expect(extended.check(r).map((x) => x.field)).toEqual(["views[0].target"]);
    expect(compose([]).empty()).toEqual({ attributes: [], shapes: [], automations: [] });
  });
  test("unknown properties, duplicates, operation/operator paths and depth", () => {
    const r = fixture();
    r.attributes![0]!.unknown = true;
    expect(app.structure(r).map((x) => x.field)).toContain("attributes[0].unknown");
    const d = fixture();
    d.attributes!.push({ ...d.attributes![0]! });
    expect(app.structure(d).map((x) => x.field)).toContain("attributes[7].key");
    const a = fixture();
    a.automations![0]!.do = [{ op: "bad" }];
    expect(app.structure(a).map((x) => x.field)).toContain("automations[0].do[0].op");
    for (const op of ["toString", "constructor", "__proto__"]) {
      const bad = fixture();
      bad.automations![0]!.do = [{ op }];
      expect(app.structure(bad).map((x) => x.field)).toContain("automations[0].do[0].op");
    }
    const p = fixture();
    p.policies![0]!.applies_when.operator = "bad";
    expect(app.structure(p).map((x) => x.field)).toContain("policies[0].applies_when.operator");
    let rule: Rule = true;
    for (let i = 0; i < 19; i++) rule = { not: rule };
    expect(ruleIssues(rule)).toEqual([]);
    expect(ruleIssues({ not: rule }).length).toBe(1);
  });
  test("numeric operands, exact set values, chronological date conditions", () => {
    const r = fixture();
    r.policies![0]!.applies_when = { fact: "employee/level", operator: "lessThan", value: 20.5 };
    expect(app.check(r)).toEqual([]);
    expect(evaluator(r.policies![0]!.applies_when)({ "employee/level": 20 })).toBe("T");
    r.automations![0]!.do = [{ op: "set", attribute: "employee/level", value: 20.5 }];
    expect(app.check(r).map((x) => x.field)).toEqual(["automations[0].do[0].value"]);
    const date = { fact: "employee/start", operator: "lessThan", value: "2026-02-01" };
    r.automations = [];
    r.policies![0]!.applies_when = date;
    expect(app.check(r)).toEqual([]);
    expect(evaluator(date)({ "employee/start": "2026-01-01" })).toBe("T");
    expect(evaluator(date)({})).toBe("U");
  });
  test("ref declarations require a target and reject target metadata on other types", () => {
    const r = app.empty();
    r.attributes = [
      { key: "x/missing", type: "ref" },
      { key: "x/scalar", type: "string", target: "s", on_delete: "block" },
    ];
    expect(app.structure(r).map((x) => x.field)).toEqual(["attributes[0].target", "attributes[1].target", "attributes[1].on_delete"]);
    r.attributes = [{ key: "x/link", type: "ref", target: "missing", on_delete: "clear" }];
    r.shapes = [{ key: "s", attributes: ["x/link"], required: ["x/link"] }];
    expect(app.check(r)).toEqual([
      { field: "attributes[0].target", issue: "Unknown shape" },
      { field: "shapes[0].required[0]", issue: "Required ref cannot be cleared" },
    ]);
    r.attributes[0] = { key: "x/link", type: "ref", target: "s" };
    expect(app.check(r)).toEqual([]);
    expect(app.compile(r).edges.get("x/link")).toEqual({ target: "s", on_delete: "block" });
    expect(r.attributes[0]).not.toHaveProperty("on_delete");
    const doc = Schema.toJsonSchemaDocument(app.compile(r).schemas.get("s")!);
    expect(doc.schema).toMatchObject({ properties: { "x/link": { pattern: "^en_[A-Za-z0-9_-]{21}$" } } });
  });
  test("ref rules support exact id comparisons and presence without consulting live data", () => {
    const r = fixture();
    const e = entity({});
    r.attributes.push({ key: "employee/link", type: "ref", target: "employee" });
    r.shapes[0]!.attributes = [...r.shapes[0]!.attributes, "employee/link"];
    for (const [operator, value] of [
      ["equal", e.id],
      ["notEqual", e.id],
      ["in", [e.id]],
      ["notIn", [e.id]],
      ["exists", undefined],
      ["doesNotExist", undefined],
    ] as const) {
      r.policies![0]!.applies_when = { fact: "employee/link", operator, ...(value === undefined ? {} : { value }) };
      expect(app.check(r)).toEqual([]);
    }
    for (const [condition, field] of [
      [{ operator: "contains", value: e.id }, "operator"],
      [{ operator: "lessThan", value: e.id }, "operator"],
      [{ operator: "equal", value: e.id, ignore_case: false }, "ignore_case"],
      [{ operator: "in", value: [e.id, "not an id"] }, "value"],
    ] as const) {
      r.policies![0]!.applies_when = { fact: "employee/link", ...condition };
      expect(app.check(r).map((x) => x.field)).toEqual([`policies[0].applies_when.${field}`]);
    }
  });
  test("removing a target shape reports both the registry issue and dangling retained facts", () => {
    const r: Registry = {
      attributes: [
        { key: "x/name", type: "string" },
        { key: "x/link", type: "ref", target: "target" },
      ],
      shapes: [
        { key: "employee", attributes: ["x/link"] },
        { key: "target", attributes: ["x/name"] },
      ],
      automations: [],
    };
    const target = { ...entity({}), id: "en_BBBBBBBBBBBBBBBBBBBBB", shape: "target" };
    const source = entity({ "x/link": target.id });
    const plan = app.plan(r, { ...r, shapes: r.shapes.slice(0, 1) }, [source, target]);
    expect(plan.issues.map((x) => x.field)).toEqual(["attributes[1].target"]);
    expect(plan.violations).toEqual([{ entity_id: source.id, field: "facts.x/link", issue: "Dangling reference" }]);
  });
  test("unresolved refs suppress dependent checks; issues preserve field order", () => {
    const r = fixture();
    r.automations![0]!.when = { fact: "x/missing", operator: "lessThan", value: true, ignore_case: true };
    r.automations![0]!.do = [{ op: "set", attribute: "x/missing", value: null }];
    expect(app.check(r).map((x) => x.field)).toEqual(["automations[0].when.fact", "automations[0].do[0].attribute"]);
  });
  test("pack evaluates required-wins and three-valued rules; JSON Schema is useful", () => {
    const r = fixture();
    r.policies!.push({
      ...r.policies![0],
      id: "unknown",
      applies_when: { fact: "employee/salary", operator: "greaterThan", value: 100 },
      requires: [{ form: "co-tax" }, { form: "bonus" }],
    });
    expect(evaluate(r, entity({ "person/email": "a", "employee/state": "CO" }))).toEqual({ required: ["co-tax"], undetermined: ["bonus"] });
    const doc = Schema.toJsonSchemaDocument(app.compile(r).schemas.get("employee")!, { onExcessProperty: "error" });
    expect(doc.schema).toMatchObject({ type: "object", required: ["person/email"], additionalProperties: false });
  });
});

test("generated reference completeness has an independent enumeration oracle", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 12 }), fc.nat(), fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }), (n, pick, flags) => {
      const keys = Array.from({ length: n }, (_, i) => `x/a${i}`),
        lost = pick % n;
      const condition = (key: string) => ({ fact: key, operator: "exists" });
      const isRef = (i: number) => i === 0 || flags[i];
      const target = (i: number) => (i % 2 ? "odd" : "even");
      const r: Registry = {
        attributes: [
          ...keys.map((key, i) => (isRef(i) ? { key, type: "ref", target: target(i) } : { key, type: "string" })),
          { key: "x/anchor", type: "string" },
        ],
        shapes: [
          { key: "s", attributes: keys },
          { key: "even", attributes: ["x/anchor"] },
          { key: "odd", attributes: ["x/anchor"] },
        ],
        policies: keys.map((key, i) => ({
          id: `p${i}`,
          name: "P",
          shape: "s",
          applies_when: { all: [true, condition(key)] },
          requires: [{ form: "f", when: { not: condition(key) } }],
        })),
        automations: keys.map((key, i) => ({
          id: `a${i}`,
          shape: "s",
          on: { changed: [key] },
          when: condition(key),
          do: [{ op: "set", attribute: key, value: isRef(i) ? entity({}).id : "v" }],
        })),
      };
      expect(app.structure(r)).toEqual([]);
      expect(app.check(r)).toEqual([]);
      const removedShape = target(pick);
      const without = { ...r, shapes: r.shapes.filter((s) => s.key !== removedShape) };
      expect(app.check(without).map((x) => x.field)).toEqual(
        keys.flatMap((_, i) => (isRef(i) && target(i) === removedShape ? [`attributes[${i}].target`] : [])),
      );
      r.attributes!.splice(lost, 1);
      const expected = [
        `shapes[0].attributes[${lost}]`,
        `policies[${lost}].applies_when.all[1].fact`,
        `policies[${lost}].requires[0].when.not.fact`,
        `automations[${lost}].on.changed[0]`,
        `automations[${lost}].when.fact`,
        `automations[${lost}].do[0].attribute`,
      ];
      expect(app.check(r).map((x) => x.field)).toEqual(expected);
    }),
    { numRuns: 100 },
  );
});

test("core and HTTP have no pack imports or domain vocabulary; packs do not import each other", () => {
  for (const area of ["core", "http"]) {
    const directory = new URL(`../src/${area}/`, import.meta.url);
    for (const name of readdirSync(directory, { recursive: true })
      .map(String)
      .filter((n) => n.endsWith(".ts"))) {
      const source = readFileSync(new URL(name, directory), "utf8");
      expect(source, `${area}/${name}`).not.toMatch(/\b(policy|policies|form|onboarding|certification|renewal|expires)\b/i);
      expect(source, name).not.toMatch(/(?:from|import\s*\()[^\n]*packs\//i);
      if (area === "core") expect(source, name).not.toMatch(/(?:from|import\s*\()[^\n]*(?:node:http|effect\/http|effect\/sql|storage\/)/);
    }
  }
  const root = new URL("../src/packs/", import.meta.url);
  for (const pack of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const directory = new URL(`${pack.name}/`, root);
    for (const name of readdirSync(directory, { recursive: true })
      .map(String)
      .filter((n) => n.endsWith(".ts"))) {
      const source = readFileSync(new URL(name, directory), "utf8");
      for (const match of source.matchAll(/(?:from|import\s*\()\s*["']([^"']+)["']/g)) {
        if (!match[1]!.startsWith(".")) continue;
        const target = new URL(match[1]!, new URL(name, directory));
        if (target.href.startsWith(root.href))
          expect(target.href.startsWith(directory.href), `${pack.name}/${name} imports ${match[1]}`).toBe(true);
      }
    }
  }
});

test("all condition operators and three-valued combinators", () => {
  const samples: [string, any, any, string][] = [
    ["equal", "ABC", "abc", "T"],
    ["notEqual", true, false, "T"],
    ["lessThan", 2, 3, "T"],
    ["lessThanInclusive", 2, 2, "T"],
    ["greaterThan", 3, 2, "T"],
    ["greaterThanInclusive", 2, 2, "T"],
    ["in", "A", ["a", "b"], "T"],
    ["notIn", "C", ["a", "b"], "T"],
    ["contains", "ABC", "b", "T"],
    ["doesNotContain", "ABC", "z", "T"],
    ["exists", false, undefined, "T"],
    ["doesNotExist", undefined, undefined, "T"],
  ];
  for (const [operator, fact, value, result] of samples) {
    const r = { fact: "x/a", operator, ...(value === undefined ? {} : { value }), ignore_case: true };
    expect(evaluator(r)(fact === undefined ? {} : { "x/a": fact })).toBe(result);
    if (!["exists", "doesNotExist"].includes(operator)) expect(evaluator(r)({})).toBe("U");
  }
  const missing = { fact: "x/a", operator: "equal", value: true };
  expect(evaluator({ all: [] })({})).toBe("T");
  expect(evaluator({ any: [] })({})).toBe("F");
  expect(evaluator({ not: missing })({})).toBe("U");
  expect(evaluator({ all: [missing, false] })({})).toBe("F");
  expect(evaluator({ any: [missing, true] })({})).toBe("T");
  expect(evaluator({ all: [missing, true] })({})).toBe("U");
  expect(evaluator({ any: [missing, false] })({})).toBe("U");
  expect(evaluator({ fact: "x/a", operator: "equal", value: 5 })({ "x/a": "5" })).toBe("F");
});

test("Unicode lengths, date validity, finite and safe-integer limits", () => {
  const r = fixture();
  r.attributes![0]!.label = "😀".repeat(200);
  expect(app.structure(r)).toEqual([]);
  r.attributes![0]!.label += "😀";
  expect(app.structure(r).map((x) => x.field)).toEqual(["attributes[0].label"]);
  const string = valueSchema({ key: "x/a", type: "string" });
  expect(decodeIssues(string, "😀".repeat(10000))).toEqual([]);
  expect(decodeIssues(string, "😀".repeat(10001))).not.toEqual([]);
  const date = valueSchema({ key: "x/a", type: "date" });
  expect(decodeIssues(date, "2024-02-29")).toEqual([]);
  for (const value of ["2026-02-29", "1900-02-29", "2026-13-01", "2026-2-01"]) expect(decodeIssues(date, value)).not.toEqual([]);
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, Infinity])
    expect(decodeIssues(valueSchema({ key: "x/a", type: "integer" }), value)).not.toEqual([]);
  for (const value of [Infinity, -Infinity, NaN]) expect(decodeIssues(valueSchema({ key: "x/a", type: "number" }), value)).not.toEqual([]);
});

test("unresolved document shape suppresses subordinate references and typed checks", () => {
  const r = fixture();
  r.policies[0]!.shape = "missing";
  r.policies[0]!.applies_when = { fact: "missing/fact", operator: "lessThan", value: true };
  r.policies[0]!.requires = [{ form: "f", when: { fact: "also/missing", operator: "exists" } }];
  r.automations[0]!.shape = "missing";
  r.automations[0]!.on.changed = ["missing/trigger"];
  r.automations[0]!.do = [{ op: "set", attribute: "missing/target", value: null }];
  expect(app.check(r).map((x) => x.field)).toEqual(["policies[0].shape", "automations[0].shape"]);
});

test("kind ordering is metadata, and callback arguments follow their schemas", () => {
  const a = defineKind(Schema.Struct({ id: Schema.String, target: Schema.String }), {
    name: "view",
    collection: "views",
    identity: "id",
    order: 5,
    fields: ["id", "target"],
    references: (doc) => {
      const target: string = doc.target;
      // @ts-expect-error an undeclared field is not available in a typed kind callback
      const invalid: number = doc.unlisted;
      return [{ path: "target", to: "shape", key: target }];
    },
    check: () => [],
  });
  const op = defineOp(Schema.Struct({ op: Schema.Literal("typed"), value: Schema.String }), {
    handler: (action) => {
      // @ts-expect-error action fields retain their declared types
      const invalid: number = action.value;
      return { type: "outbox", payload: action };
    },
  });
  const e = engine(collect([...app.kinds].reverse().concat(collect([a], { typed: op }).kinds), {}).kinds);
  expect(e.kinds.map((k) => k.name)).toEqual(["view", "attribute", "shape", "policy", "automation"]);
});
