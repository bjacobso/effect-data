import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { issue } from "../core/model.ts";
import { Conflict } from "../Errors.ts";

export type Slot = { entity_id: string; attribute: string; encoded: string };
export const slotKey = (entity: string, attribute: string) => `${entity}:${attribute}`;

export function liveUnique(sql: SqlClient.SqlClient, hashOverride?: string) {
  const input = (slots: readonly Slot[]) => sql`
    SELECT entity_id,attribute,encoded::jsonb AS value,coalesce(${hashOverride ?? null},md5(encoded::jsonb::text)) AS hash
    FROM jsonb_to_recordset(${JSON.stringify(slots)}::jsonb) AS t(entity_id text,attribute text,encoded text)`;
  // Resolve the same value under a bounded set of advisory locks. In one
  // transaction a batch can touch at most 2,048 stripes, even for wide shapes.
  const lock = (account: string, slots: Slot[]) =>
    slots.length
      ? sql`
      SELECT pg_advisory_xact_lock(stripe) FROM (
        SELECT DISTINCT hashtextextended(${account} || '/' ||
          (hashtextextended(attribute || '/' || hash, 0) & 2047)::text,1) AS stripe
        FROM (${input(slots)}) i ORDER BY stripe
      ) stripes`.pipe(Effect.asVoid)
      : Effect.void;

  const insert = (account: string, slots: Slot[], existing = false) => sql`
    WITH candidates AS MATERIALIZED (${input(slots)}),
    picked AS MATERIALIZED (
      SELECT DISTINCT ON (attribute,hash,value) * FROM candidates
      ORDER BY attribute,hash,value,entity_id COLLATE "C"
    ), resolved AS MATERIALIZED (
      SELECT i.*,(SELECT u.id FROM unique_values u
        WHERE u.account_id=${account} AND u.attribute=i.attribute AND u.hash=i.hash AND u.value=i.value LIMIT 1) AS id
      FROM picked i
    ), inserted AS (
      INSERT INTO unique_values(account_id,attribute,hash,value)
      SELECT ${account},attribute,hash,value FROM resolved WHERE id IS NULL
      RETURNING id,attribute,hash,value
    )
    INSERT INTO live_unique(account_id,entity_id,attribute,value,value_id)
    SELECT ${account},r.entity_id,r.attribute,r.value,coalesce(r.id,i.id)
    FROM resolved r LEFT JOIN inserted i USING(attribute,hash,value)
    ${existing ? sql`ON CONFLICT DO NOTHING` : sql``}
    RETURNING entity_id,attribute`;

  const claim = (account: string, slot: Slot) =>
    insert(account, [slot]).pipe(
      Effect.mapError((e) =>
        e.reason._tag === "UniqueViolation" ? new Conflict({ issues: [issue(`facts.${slot.attribute}`, "Duplicate unique value")] }) : e,
      ),
    );
  const get = (account: string, ids: string[]) =>
    sql<Slot>`SELECT entity_id,attribute,value::text AS encoded FROM live_unique
      WHERE account_id=${account} AND entity_id IN ${sql.in(ids)}`;
  const release = (account: string, slots: Slot[]) =>
    slots.length
      ? sql`DELETE FROM live_unique u USING (${input(slots)}) i
      WHERE u.account_id=${account} AND u.entity_id=i.entity_id AND u.attribute=i.attribute AND u.value=i.value`.pipe(Effect.asVoid)
      : Effect.void;
  return { lock, insert, claim, get, release };
}

export type LiveUnique = ReturnType<typeof liveUnique>;
