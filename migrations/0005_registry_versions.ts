import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE registry_versions (
    account_id text NOT NULL, version integer NOT NULL, document text NOT NULL,
    at text NOT NULL, PRIMARY KEY(account_id, version)
  )`;
  yield* sql`CREATE INDEX registry_versions_at ON registry_versions(account_id, at DESC)`;
  yield* sql`INSERT INTO registry_versions(account_id,version,document,at)
    SELECT account_id,version,document,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM registries`;
});
