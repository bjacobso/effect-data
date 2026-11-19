import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { DatabaseLive, port } from "./Config.ts";
import { DataLive } from "./composition.ts";
import { Store } from "./storage/Store.ts";
import { Routes } from "./http/routes.ts";
const RolloutWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
    yield* Effect.forkScoped(store.runRollouts);
  }),
);
const Server = Layer.unwrap(
  Effect.gen(function* () {
    return HttpRouter.serve(Layer.merge(Routes, RolloutWorker).pipe(Layer.provide(DataLive), Layer.provide(DatabaseLive)), {
      disableLogger: true,
    }).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: yield* port })));
  }),
);
Layer.launch(Server).pipe(NodeRuntime.runMain);
