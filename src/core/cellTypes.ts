import type { Attribute } from "./model.ts";

export type CellColumn = "s" | "n" | "b" | "d";

export type CellType = { type: string; column: CellColumn; fold: boolean };

export function cellTypes(attributes: readonly Attribute[]) {
  return new Map<string, CellType>(
    attributes.map(({ key, type }) => {
      const column: CellColumn = type === "date" ? "d" : type === "boolean" ? "b" : type === "number" || type === "integer" ? "n" : "s";
      return [key, { type, column, fold: type === "string" || type === "enum" }] as const;
    }),
  );
}

export type CellTypes = ReturnType<typeof cellTypes>;
