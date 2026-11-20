import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { cellTypes, type CellType, type CellTypes } from "../core/cellTypes.ts";
import type { Entity, Registry, Value } from "../core/model.ts";
import { realDate } from "../core/values.ts";

export const exceptionalText = (s: string) => s.includes("\0") || !s.isWellFormed();
export const cellDate = (s: string) => (s.startsWith("0000") ? `0001${s.slice(4)} BC` : s);

type Key = { entity_id: string; attribute: string };
type Cell = Key & { shape: string; s?: string; folded?: string; n?: number; b?: boolean; d?: string; exceptional?: true };

function cell(entity: Entity, attribute: string, value: Value, type: CellType): Cell {
  const key = { entity_id: entity.id, shape: entity.shape, attribute };
  switch (type.column) {
    case "n":
      if (typeof value === "number") return { ...key, n: value };
      break;
    case "b":
      if (typeof value === "boolean") return { ...key, b: value };
      break;
    case "d":
      if (typeof value === "string" && realDate(value)) return { ...key, d: cellDate(value) };
      break;
    case "s":
      if (typeof value === "string" && !exceptionalText(value)) {
        const folded = type.fold ? value.toLowerCase() : value;
        return folded === value ? { ...key, s: value } : { ...key, s: value, folded };
      }
      break;
  }
  // JSON text preserves strings PostgreSQL cannot represent and hidden data
  // left behind by a type change that cannot yet be restored.
  return { ...key, s: JSON.stringify(value), exceptional: true };
}

export function cells(sql: SqlClient.SqlClient) {
  const insert = (account: string, rows: Cell[], update: boolean) => sql`
    INSERT INTO cells(account_id,entity_id,shape,attribute,s,folded,n,b,d,exceptional)
    SELECT ${account},entity_id,shape,attribute,s,folded,n,b,d,coalesce(exceptional,false)
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS r(entity_id text,shape text,attribute text,s text,folded text,n numeric,b boolean,d date,exceptional boolean)
    ${
      update
        ? sql`ON CONFLICT(account_id,entity_id,attribute) DO UPDATE
      SET s=excluded.s,folded=excluded.folded,n=excluded.n,b=excluded.b,d=excluded.d,exceptional=excluded.exceptional`
        : sql``
    }`;

  const write = (account: string, entities: Iterable<{ entity: Entity; keys: Iterable<string>; deleted: boolean }>, types: CellTypes) =>
    Effect.gen(function* () {
      const rows: Cell[] = [];
      const removed: Key[] = [];
      const deleted: string[] = [];
      for (const { entity, keys, deleted: gone } of entities) {
        if (gone) {
          deleted.push(entity.id);
          continue;
        }
        for (const attribute of keys) {
          const value = entity.facts[attribute];
          if (value === undefined) removed.push({ entity_id: entity.id, attribute });
          else rows.push(cell(entity, attribute, value, types.get(attribute)!));
        }
      }
      if (deleted.length) yield* sql`DELETE FROM cells WHERE account_id=${account} AND entity_id IN ${sql.in(deleted)}`;
      if (removed.length)
        yield* sql`DELETE FROM cells c USING jsonb_to_recordset(${JSON.stringify(removed)}::jsonb)
      AS r(entity_id text,attribute text) WHERE c.account_id=${account} AND c.entity_id=r.entity_id AND c.attribute=r.attribute`;
      if (rows.length) yield* insert(account, rows, true);
    });

  const rebuild = (account: string, types: CellTypes, attribute?: string) =>
    Effect.gen(function* () {
      let after = "";
      while (true) {
        const page: readonly { id: string; document: string }[] = yield* attribute === undefined
          ? sql<{ id: string; document: string }>`SELECT id,document FROM entities
              WHERE account_id=${account} AND id>${after} AND NOT deleted ORDER BY id LIMIT 2000`
          : sql<{ id: string; document: string }>`SELECT e.id,e.document FROM (
                SELECT entity_id FROM cells WHERE account_id=${account} AND attribute=${attribute}
                  AND entity_id>${after} ORDER BY entity_id LIMIT 2000
              ) c JOIN entities e ON e.account_id=${account} AND e.id=c.entity_id ORDER BY c.entity_id`;
        if (!page.length) return;
        const rows = page.flatMap(({ document }) => {
          const entity = JSON.parse(document) as Entity;
          return Object.entries(entity.facts)
            .filter(([key]) => attribute === undefined || key === attribute)
            .map(([key, value]) => cell(entity, key, value, types.get(key)!));
        });
        // Bound serialization and statement size for entities with many facts.
        let batch: Cell[] = [],
          size = 0;
        for (const row of rows) {
          batch.push(row);
          size += (row.s?.length ?? 0) + (row.folded?.length ?? 0) + 128;
          if (size >= 1_000_000) {
            yield* insert(account, batch, attribute !== undefined);
            batch = [];
            size = 0;
          }
        }
        if (batch.length) yield* insert(account, batch, attribute !== undefined);
        after = page.at(-1)!.id;
      }
    });

  const backfill = Effect.gen(function* () {
    const registries = yield* sql<{ account_id: string; document: string }>`SELECT account_id,document FROM registries ORDER BY account_id`;
    for (const { account_id, document } of registries) yield* rebuild(account_id, cellTypes((JSON.parse(document) as Registry).attributes));
  });

  return { write, rebuild, backfill };
}
