import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE rollouts (
    account_id text NOT NULL, registry_version integer NOT NULL,
    status text NOT NULL CHECK(status IN ('running','done','superseded')),
    shapes text[] NOT NULL, phase text NOT NULL CHECK(phase IN ('release','claim')),
    cursor text COLLATE "C" NOT NULL DEFAULT '', processed integer NOT NULL DEFAULT 0,
    total integer, started_at text NOT NULL, finished_at text,
    PRIMARY KEY(account_id,registry_version)
  )`;
  yield* sql`CREATE UNIQUE INDEX rollout_running ON rollouts(account_id) WHERE status='running'`;
  yield* sql`CREATE TABLE violations (
    account_id text NOT NULL, id bigserial NOT NULL, entity_id text NOT NULL,
    attribute text COLLATE "C" NOT NULL, issue text NOT NULL CHECK(issue IN ('duplicate','dangling_reference')),
    value jsonb NOT NULL, status text NOT NULL CHECK(status IN ('open','resolved')),
    registry_version integer NOT NULL, opened_tx bigint NOT NULL, opened_at text NOT NULL,
    resolved_tx bigint, resolved_at text, PRIMARY KEY(account_id,id)
  )`;
  yield* sql`CREATE UNIQUE INDEX violations_open ON violations(account_id,entity_id,attribute,issue) WHERE status='open'`;
  yield* sql`CREATE INDEX violations_history ON violations(account_id,entity_id,opened_at)`;
  yield* sql`CREATE INDEX violations_promote ON violations(account_id,attribute,md5(value::text),entity_id COLLATE "C")
    WHERE status='open' AND issue='duplicate'`;
  yield* sql`ALTER TABLE outbox ALTER COLUMN automation_id DROP NOT NULL`;
});
