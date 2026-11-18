import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Engine } from "../core/engine.ts";
import { Packs } from "../Packs.ts";
import { coreApi, CoreHttpLive } from "./handler.ts";
import { EdgeLive } from "./boundary.ts";
export const Routes = Layer.unwrap(
  Effect.gen(function* () {
    const engine = yield* Engine,
      packs = yield* Packs;
    const groups = packs.flatMap((p) => (p.group ? [p.group] : []));
    const core = coreApi(engine),
      api = core.add(core.groups.core, core.groups.system, ...groups);
    return Layer.mergeAll(
      HttpApiBuilder.layer(api, { openapiPath: "/v2/openapi.json" }).pipe(
        Layer.provide([CoreHttpLive, ...packs.flatMap((p) => (p.handlers ? [p.handlers] : []))]),
      ),
      EdgeLive,
    );
  }),
);
