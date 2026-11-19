import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Compiled } from "../core/engine.ts";
import { compare, issue, type Entity } from "../core/model.ts";
import { ensure } from "../Errors.ts";

type Edges = Compiled["edges"];
type Row = { account_id: string; entity_id: string; attribute: string; target_id: string };
type Incoming = Pick<Row, "entity_id" | "attribute">;

export function liveRefs(sql: SqlClient.SqlClient) {
  const insert = (rows: [Row, ...Row[]]) =>
    sql`INSERT INTO live_refs ${sql.insert(rows)}
      ON CONFLICT(account_id,entity_id,attribute) DO UPDATE SET target_id=EXCLUDED.target_id`;
  const validate = (account: string, entity: Entity, edges: Edges) =>
    Effect.gen(function* () {
      if (!edges.size) return;
      const refs = Object.entries(entity.facts).flatMap(([key, value]) => {
        const edge = edges.get(key);
        return edge ? [{ key, id: String(value), shape: edge.target }] : [];
      });
      const ids = [...new Set(refs.map((ref) => ref.id).filter((id) => id !== entity.id))];
      const shapes = new Map([[entity.id, entity.shape]]);
      if (ids.length) {
        const locked = yield* sql<{ id: string; document: string }>`SELECT id,document FROM entities
          WHERE account_id=${account} AND NOT deleted AND id IN ${sql.in(ids)} ORDER BY id COLLATE "C" FOR KEY SHARE`;
        for (const row of locked) shapes.set(row.id, (JSON.parse(row.document) as Entity).shape);
      }
      yield* ensure(
        refs
          .filter((ref) => shapes.get(ref.id) !== ref.shape)
          .sort((a, b) => compare(a.key, b.key))
          .map((ref) => issue(`facts.${ref.key}`, "Unknown reference")),
      );
    });
  const update = (account: string, entity: Entity, keys: readonly string[], config: Compiled) =>
    Effect.gen(function* () {
      const rows: Row[] = [],
        removed: string[] = [];
      for (const attribute of keys) {
        if (!config.edges.has(attribute)) continue;
        const value = entity.facts[attribute];
        if (value === undefined) removed.push(attribute);
        else rows.push({ account_id: account, entity_id: entity.id, attribute, target_id: config.storedRefTarget(value) });
      }
      if (removed.length)
        yield* sql`DELETE FROM live_refs
        WHERE account_id=${account} AND entity_id=${entity.id} AND attribute IN ${sql.in(removed)}`;
      if (rows[0]) yield* insert([rows[0], ...rows.slice(1)]);
    });
  const incoming = (account: string, target: string, targetShape: string, compiled: Compiled) =>
    sql<Incoming & { shape: string }>`SELECT r.entity_id,r.attribute,c.shape
      FROM live_refs r JOIN entities e ON e.account_id=r.account_id AND e.id=r.entity_id
      JOIN events c ON c.account_id=e.account_id AND c.entity_id=e.id AND c.kind='create'
      WHERE r.account_id=${account} AND r.target_id=${target} AND length(r.target_id)=24 AND NOT e.deleted
      ORDER BY r.entity_id COLLATE "C", r.attribute`.pipe(
      Effect.map((rows) =>
        rows.flatMap(({ shape, ...row }) => {
          const edge = compiled.edges.get(row.attribute);
          return edge?.target === targetShape && compiled.members.get(shape)?.has(row.attribute)
            ? [{ ...row, on_delete: edge.on_delete }]
            : [];
        }),
      ),
    );
  // Called under apply's exclusive account lock, for stored facts of any shape.
  const reconcile = (account: string, previous: Edges, desired: Compiled, entities: Iterable<Entity>) =>
    Effect.gen(function* () {
      const removed = [...previous.keys()].filter((key) => !desired.edges.has(key));
      if (removed.length) yield* sql`DELETE FROM live_refs WHERE account_id=${account} AND attribute IN ${sql.in(removed)}`;
      const added = [...desired.edges.keys()].filter((key) => !previous.has(key));
      if (!added.length) return;
      let batch: Row[] = [];
      for (const entity of entities)
        for (const attribute of added) {
          const target = entity.facts[attribute];
          if (target === undefined) continue;
          batch.push({ account_id: account, entity_id: entity.id, attribute, target_id: desired.storedRefTarget(target) });
          if (batch.length === 1_000) {
            yield* insert([batch[0]!, ...batch.slice(1)]);
            batch = [];
          }
        }
      if (batch[0]) yield* insert([batch[0], ...batch.slice(1)]);
    });
  return { validate, update, incoming, reconcile };
}
