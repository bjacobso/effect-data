import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { DatabaseLive, port } from "./Config.ts";
import { DataLive } from "./composition.ts";
import { Routes } from "./http/routes.ts";
const Server = Layer.unwrap(
  Effect.gen(function* () {
    return HttpRouter.serve(Routes.pipe(Layer.provide(DataLive), Layer.provide(DatabaseLive)), { disableLogger: true }).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: yield* port })),
    );
  }),
);
Layer.launch(Server).pipe(NodeRuntime.runMain);
