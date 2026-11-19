import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Hidden values can survive conversion to a ref with a legacy value that
  // isn't an entity id. Keep the stored edge, without indexing long values.
  yield* sql`DROP INDEX live_refs_target`;
  yield* sql`CREATE INDEX live_refs_target ON live_refs(account_id,target_id) WHERE length(target_id)=24`;
});
