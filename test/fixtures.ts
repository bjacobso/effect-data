import type { Registry, Attribute, Shape, Automation } from "../src/core/model.ts";
export const fixture = (): Registry & {
  attributes: (Attribute & Record<string, any>)[];
  shapes: (Shape & Record<string, any>)[];
  automations: (Automation & Record<string, any>)[];
  policies: Record<string, any>[];
} => ({
  attributes: [
    { key: "person/email", type: "string", unique: true },
    { key: "employee/state", type: "enum", values: ["CA", "CO"] },
    { key: "employee/salary", type: "number" },
    { key: "employee/level", type: "integer" },
    { key: "employee/start", type: "date" },
    { key: "employee/remote", type: "boolean" },
    { key: "person/note", type: "string" },
  ],
  shapes: [
    {
      key: "employee",
      attributes: [
        "person/email",
        "employee/state",
        "employee/salary",
        "employee/level",
        "employee/start",
        "employee/remote",
        "person/note",
      ],
      required: ["person/email"],
    },
  ],
  policies: [
    {
      id: "co",
      name: "CO",
      shape: "employee",
      applies_when: { fact: "employee/state", operator: "equal", value: "CO" },
      requires: [{ form: "co-tax" }],
    },
  ],
  automations: [
    {
      id: "hire",
      shape: "employee",
      on: { changed: ["employee/state"] },
      when: { fact: "employee/state", operator: "equal", value: "CO" },
      do: [
        { op: "set", attribute: "employee/salary", value: 50 },
        { op: "notify", message: "hire" },
      ],
    },
  ],
});
