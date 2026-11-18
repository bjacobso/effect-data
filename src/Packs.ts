import { Context, Layer, type Schema } from "effect";
import type { HttpApiGroup } from "effect/http-api";
import type { Kind, Op } from "./core/model.ts";
import type { Store } from "./storage/Store.ts";
export type Pack = {
  name: string;
  kinds: readonly Kind<Schema.Top>[];
  ops: Record<string, Op<Schema.Top>>;
  group?: HttpApiGroup.Constraint;
  handlers?: Layer.Layer<HttpApiGroup.Service<"data", string>, never, Store>;
};
// Dynamic group identifiers are widened only when collecting a pack's HTTP contribution.
export const definePack = <G extends HttpApiGroup.Constraint>(
  pack: Omit<Pack, "group" | "handlers"> & {
    group?: G;
    handlers?: Layer.Layer<HttpApiGroup.Service<"data", G["identifier"]>, never, Store>;
  },
): Pack => pack as unknown as Pack;
export class Packs extends Context.Service<Packs, readonly Pack[]>()("data/Packs") {
  static layer = (packs: readonly Pack[]) => Layer.succeed(Packs, packs);
}
