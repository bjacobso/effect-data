import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { cells } from "../src/storage/cells.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE cells (
    account_id text NOT NULL, entity_id text COLLATE "C" NOT NULL,
    shape text NOT NULL, attribute text NOT NULL,
    s text COLLATE "C", folded text COLLATE "C", n numeric, b boolean, d date,
    exceptional boolean NOT NULL DEFAULT false,
    CHECK (num_nonnulls(s,n,b,d)=1)
  )`;
  yield* cells(sql).backfill;
  yield* sql`ALTER TABLE cells ADD PRIMARY KEY(account_id,entity_id,attribute)`;
  yield* sql`CREATE INDEX cells_attribute ON cells(account_id,attribute,entity_id)`;
  yield* sql`CREATE INDEX cells_s ON cells(account_id,attribute,left(s,384),entity_id) WHERE s IS NOT NULL AND NOT exceptional`;
  yield* sql`CREATE INDEX cells_folded ON cells(account_id,attribute,left(coalesce(folded,s),384),entity_id)
    WHERE s IS NOT NULL AND NOT exceptional`;
  yield* sql`CREATE INDEX cells_n ON cells(account_id,attribute,n,entity_id) WHERE n IS NOT NULL`;
  yield* sql`CREATE INDEX cells_b ON cells(account_id,attribute,b,entity_id) WHERE b IS NOT NULL`;
  yield* sql`CREATE INDEX cells_d ON cells(account_id,attribute,d,entity_id) WHERE d IS NOT NULL`;
  yield* sql`CREATE INDEX cells_exceptional ON cells(account_id,shape,attribute) WHERE exceptional`;
});
