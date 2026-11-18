import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { DatabaseLive } from "./Config.ts";
import { migrate } from "./Migrations.ts";
migrate.pipe(Effect.provide(DatabaseLive), NodeRuntime.runMain);
