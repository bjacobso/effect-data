import { Effect } from "effect";
import { SqlClient } from "effect/sql";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE account_clocks (account_id text PRIMARY KEY, tx bigint NOT NULL, at_ms bigint NOT NULL)`;
  yield* sql`INSERT INTO account_clocks SELECT account_id,max(tx),(extract(epoch FROM max(at)::timestamptz)*1000)::bigint FROM events GROUP BY account_id`;
  yield* sql`CREATE TABLE unique_values (id bigserial PRIMARY KEY, account_id text NOT NULL, attribute text NOT NULL, hash text NOT NULL, value jsonb NOT NULL)`;
  yield* sql`CREATE INDEX unique_values_lookup ON unique_values(account_id,attribute,hash)`;
  yield* sql`INSERT INTO unique_values(account_id,attribute,hash,value) SELECT DISTINCT account_id,attribute,md5(value::text),value FROM live_unique`;
  yield* sql`ALTER TABLE live_unique ADD COLUMN value_id bigint REFERENCES unique_values(id)`;
  yield* sql`UPDATE live_unique AS l SET value_id=v.id FROM unique_values AS v WHERE l.account_id=v.account_id AND l.attribute=v.attribute AND l.value=v.value`;
  yield* sql`ALTER TABLE live_unique ALTER COLUMN value_id SET NOT NULL`;
  yield* sql`DROP INDEX unique_live_value`;
  yield* sql`CREATE UNIQUE INDEX unique_live_value ON live_unique(account_id,attribute,value_id)`;
});
