import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // An entity's shape is fixed at creation. Index just those events so a
  // registry operation can select affected live entities without JSON casts.
  yield* sql`CREATE INDEX events_created_shape ON events(account_id,shape,entity_id COLLATE "C") WHERE kind='create'`;
});
