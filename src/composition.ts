import { Config, Effect, Layer } from "effect";
import { attributeKind, shapeKind, automationKind, setOp } from "./core/kinds.ts";
import { collect, KindRegistry } from "./core/registry.ts";
import { engine, Engine } from "./core/engine.ts";
import { Packs, type Pack } from "./Packs.ts";
import { Store } from "./storage/Store.ts";
import { Clock } from "./storage/Clock.ts";
import { onboardingPack } from "./packs/onboarding/index.ts";
import { certificationPack } from "./packs/certification/index.ts";
export function compose(packs: readonly Pack[]) {
  const ops = collect([], Object.assign({ set: setOp }, ...packs.map((p) => p.ops))).ops;
  const registry = collect([attributeKind, shapeKind, automationKind(ops), ...packs.flatMap((p) => p.kinds)], ops);
  const value = { ...engine(registry.kinds), ops };
  return { ...value, layer: Layer.mergeAll(Layer.succeed(Engine, value), Layer.succeed(KindRegistry, registry), Packs.layer(packs)) };
}
export const dataLayer = (packs: readonly Pack[]) =>
  Store.layer.pipe(Layer.provideMerge(compose(packs).layer), Layer.provideMerge(Clock.layer));
const available: readonly Pack[] = [onboardingPack, certificationPack];
export function selectPacks(selection: string): readonly Pack[] {
  const names = selection
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error("Duplicate pack name in PACKS");
  return names.map((name) => {
    const pack = available.find((p) => p.name === name);
    if (!pack) throw new Error(`Unknown pack: ${name}`);
    return pack;
  });
}
export const DataLive = Layer.unwrap(
  Effect.gen(function* () {
    const selection = yield* Config.String("PACKS").pipe(Config.withDefault("onboarding,certification"));
    return dataLayer(yield* Effect.try(() => selectPacks(selection)));
  }),
);
