import { Effect } from "effect";
import { SqlClient } from "effect/sql";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE registries (account_id text PRIMARY KEY, version integer NOT NULL, document text NOT NULL)`;
  yield* sql`CREATE TABLE entities (account_id text NOT NULL, id text NOT NULL, document text NOT NULL, deleted boolean NOT NULL DEFAULT false, PRIMARY KEY(account_id,id))`;
  yield* sql`CREATE TABLE events (account_id text NOT NULL, entity_id text NOT NULL, tx bigint NOT NULL, at text NOT NULL, kind text NOT NULL, shape text NOT NULL, version integer NOT NULL, registry_version integer NOT NULL, created_at text NOT NULL, PRIMARY KEY(account_id,tx))`;
  yield* sql`CREATE INDEX events_entity ON events(account_id,entity_id,tx)`;
  yield* sql`CREATE TABLE facts (account_id text NOT NULL, entity_id text NOT NULL, tx bigint NOT NULL, at text NOT NULL, attribute text COLLATE "C" NOT NULL, op text NOT NULL CHECK(op IN ('assert','retract')), value jsonb NOT NULL, reason text NOT NULL CHECK(reason IN ('api','automation','migration')), actor text NOT NULL, PRIMARY KEY(account_id,tx,attribute), FOREIGN KEY(account_id,tx) REFERENCES events(account_id,tx))`;
  yield* sql`CREATE INDEX facts_entity ON facts(account_id,entity_id,tx,attribute)`;
  yield* sql`CREATE FUNCTION immutable_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only log'; END $$`;
  yield* sql`CREATE TRIGGER facts_immutable BEFORE UPDATE OR DELETE ON facts FOR EACH ROW EXECUTE FUNCTION immutable_log()`;
  yield* sql`CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION immutable_log()`;
  yield* sql`CREATE TABLE live_unique (account_id text NOT NULL, entity_id text NOT NULL, attribute text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(account_id,entity_id,attribute))`;
  yield* sql`CREATE UNIQUE INDEX unique_live_value ON live_unique(account_id,attribute,md5(value::text))`;
  yield* sql`CREATE TABLE outbox (seq bigserial PRIMARY KEY, account_id text NOT NULL, at text NOT NULL, entity_id text NOT NULL, automation_id text NOT NULL, document text NOT NULL)`;
  yield* sql`CREATE INDEX outbox_account ON outbox(account_id,seq)`;
});
