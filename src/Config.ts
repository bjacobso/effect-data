import { Config, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
export const port = Config.Port("PORT").pipe(Config.withDefault(8086));
export const databaseUrl = Config.Redacted("DATABASE_URL").pipe(Config.withDefault(Redacted.make("postgres://localhost:5432/onb_data")));
export const DatabaseLive = PgClient.layerConfig({ url: databaseUrl, maxConnections: Config.succeed(20) });
