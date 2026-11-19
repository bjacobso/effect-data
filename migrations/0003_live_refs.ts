import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE live_refs (
    account_id text NOT NULL, entity_id text NOT NULL, attribute text COLLATE "C" NOT NULL, target_id text NOT NULL,
    PRIMARY KEY(account_id,entity_id,attribute)
  )`;
  yield* sql`CREATE INDEX live_refs_target ON live_refs(account_id,target_id)`;
  yield* sql`ALTER TABLE facts DROP CONSTRAINT facts_reason_check,
    ADD CONSTRAINT facts_reason_check CHECK(reason IN ('api','automation','migration','reference'))`;
});
