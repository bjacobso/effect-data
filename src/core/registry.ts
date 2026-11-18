import { Context, Layer, Schema } from "effect";
import type { Kind, Op, Doc, Action } from "./model.ts";
export type RegisteredKind = Kind<Schema.Codec<Doc>>;
export type RegisteredOp = Op<Schema.Codec<Action>>;
export type Ops = Record<string, RegisteredOp>;
// The only heterogeneous collection boundary; typed declarations stay typed until here.
export function collect(kinds: readonly Kind<Schema.Top>[], ops: Record<string, Op<Schema.Top>>) {
  return { kinds: [...kinds].sort((a, b) => a.order - b.order) as unknown as RegisteredKind[], ops: ops as unknown as Ops };
}
export class KindRegistry extends Context.Service<KindRegistry, ReturnType<typeof collect>>()("data/KindRegistry") {
  static layer = (kinds: readonly Kind<Schema.Top>[], ops: Record<string, Op<Schema.Top>>) =>
    Layer.succeed(KindRegistry, collect(kinds, ops));
}
