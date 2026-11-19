import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Compiled } from "../core/engine.ts";
import type { ViolationIssue } from "../core/registryReview.ts";
import { decodeValue } from "./encoding.ts";
import type { Slot } from "./liveUnique.ts";

export type ViolationStatus = "open" | "resolved";
export type RecordKey = { entity_id: string; attribute: string; issue: ViolationIssue };
export type ViolationRecord = RecordKey & { id: string; encoded: string };
export type NewViolation = RecordKey & { encoded: string };
export type ViolationChange = RecordKey & { id: string; tx: number; at: string; status: ViolationStatus };
export const recordKey = ({ entity_id, attribute, issue }: RecordKey) => `${entity_id}:${attribute}:${issue}`;

export function violations(sql: SqlClient.SqlClient) {
  const openFor = (account: string, ids: string[]) =>
    sql<ViolationRecord>`SELECT id::text,entity_id,attribute,issue,value::text AS encoded FROM violations
      WHERE account_id=${account} AND status='open' AND entity_id IN ${sql.in(ids)}
      ORDER BY attribute,issue`;

  const atTime = (account: string, id: string, at: string) =>
    sql<Pick<RecordKey, "attribute" | "issue">>`SELECT attribute,issue FROM violations
      WHERE account_id=${account} AND entity_id=${id} AND opened_at<=${at}
        AND (resolved_at IS NULL OR resolved_at>${at}) ORDER BY attribute,issue`;
  const markResolved = (account: string, entity: string, keys?: string[], issue?: ViolationIssue) =>
    keys?.length === 0
      ? Effect.succeed([])
      : sql<ViolationRecord>`UPDATE violations SET status='resolved'
      WHERE account_id=${account} AND status='open' AND entity_id=${entity}
        ${keys ? sql`AND attribute IN ${sql.in(keys)}` : sql``} ${issue ? sql`AND issue=${issue}` : sql``}
      RETURNING id::text,entity_id,attribute,issue,value::text AS encoded`;

  const promote = (account: string, slot: Slot, config: Compiled) =>
    Effect.gen(function* () {
      if (!config.unique.has(slot.attribute)) return;
      const shapes = [...config.members].filter(([, keys]) => keys.has(slot.attribute)).map(([shape]) => shape);
      if (!shapes.length) return;
      const [candidate] = yield* sql<ViolationRecord>`
        SELECT v.id::text,v.entity_id,v.attribute,v.issue,v.value::text AS encoded
        FROM violations v
        JOIN events c ON c.account_id=v.account_id AND c.entity_id=v.entity_id AND c.kind='create'
        WHERE v.account_id=${account} AND v.issue='duplicate' AND v.status='open'
          AND v.attribute=${slot.attribute} AND md5(v.value::text)=md5(${slot.encoded}::jsonb::text)
          AND v.value=${slot.encoded}::jsonb AND c.shape IN ${sql.in(shapes)}
        ORDER BY v.entity_id COLLATE "C" LIMIT 1
        FOR UPDATE OF v`;
      return candidate;
    });

  const validRetargets = (account: string, previous: Compiled["edges"], desired: Compiled) => {
    const pairs = [...desired.edges].flatMap(([attribute, edge]) =>
      previous.get(attribute)?.target === edge.target
        ? []
        : [...desired.members].filter(([, keys]) => keys.has(attribute)).map(([shape]) => ({ attribute, shape, target: edge.target })),
    );
    if (!pairs.length) return Effect.succeed([]);
    return sql<ViolationRecord>`
      SELECT v.id::text,v.entity_id,v.attribute,v.issue,v.value::text AS encoded FROM violations v
      JOIN live_refs r USING(account_id,entity_id,attribute)
      JOIN events c ON c.account_id=v.account_id AND c.entity_id=v.entity_id AND c.kind='create'
      JOIN entities t ON t.account_id=r.account_id AND t.id=r.target_id AND NOT t.deleted
      JOIN events tc ON tc.account_id=t.account_id AND tc.entity_id=t.id AND tc.kind='create'
      JOIN jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) i(attribute text,shape text,target text)
        ON i.attribute=v.attribute AND i.shape=c.shape AND i.target=tc.shape
      WHERE v.account_id=${account} AND v.status='open' AND v.issue='dangling_reference'`;
  };
  const resolve = (account: string, changes: ViolationChange[]) =>
    changes.length
      ? sql`UPDATE violations v
      SET status='resolved',resolved_tx=i.tx,resolved_at=i.at
      FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) i(id bigint,tx bigint,at text)
      WHERE v.account_id=${account} AND v.id=i.id`.pipe(Effect.asVoid)
      : Effect.void;

  const open = (account: string, version: number, records: (NewViolation & { tx: number; at: string })[]) =>
    sql<ViolationRecord & { tx: string; at: string }>`
      INSERT INTO violations(account_id,entity_id,attribute,issue,value,status,registry_version,opened_tx,opened_at)
      SELECT ${account},entity_id,attribute,issue,encoded::jsonb,'open',${version},tx,at
      FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) i(entity_id text,attribute text,issue text,encoded text,tx bigint,at text)
      RETURNING id::text,entity_id,attribute,issue,value::text AS encoded,opened_tx::text AS tx,opened_at AS at`;

  const deliver = (account: string, changes: ViolationChange[]) =>
    changes.length
      ? sql`INSERT INTO outbox(account_id,at,entity_id,automation_id,document)
      SELECT ${account},at,entity_id,NULL,
        jsonb_build_object('op',op,'violation_id',id,'attribute',attribute,'issue',issue)::text
      FROM jsonb_to_recordset(${JSON.stringify(
        changes.map((v) => ({
          ...v,
          op: v.status === "open" ? "violation_opened" : "violation_resolved",
        })),
      )}::jsonb) i(at text,entity_id text,op text,id bigint,attribute text,issue text)
      ORDER BY at,id`.pipe(Effect.asVoid)
      : Effect.void;

  const list = (account: string, status: ViolationStatus | undefined, attribute: string | undefined, after: number, limit: number) =>
    sql<
      RecordKey & {
        id: string;
        value: string;
        status: ViolationStatus;
        registry_version: number;
        opened_tx: string;
        opened_at: string;
        resolved_tx: string | null;
        resolved_at: string | null;
      }
    >`SELECT id::text,entity_id,attribute,issue,value,status,registry_version,opened_tx::text,opened_at,resolved_tx::text,resolved_at
      FROM violations WHERE account_id=${account} AND id>${after}
        ${status ? sql`AND status=${status}` : sql``} ${attribute === undefined ? sql`` : sql`AND attribute=${attribute}`}
      ORDER BY violations.id LIMIT ${limit}`.pipe(
      Effect.map((rows) => ({
        data: rows.map((row) => ({
          ...row,
          id: Number(row.id),
          value: decodeValue(row.value),
          opened_tx: Number(row.opened_tx),
          resolved_tx: row.resolved_tx === null ? null : Number(row.resolved_tx),
        })),
        next_after: rows.length ? Number(rows.at(-1)!.id) : null,
      })),
    );
  return { openFor, atTime, markResolved, promote, validRetargets, resolve, open, deliver, list };
}
export type Violations = ReturnType<typeof violations>;
