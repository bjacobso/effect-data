import { Effect, Exit } from "effect";
import { Statement } from "effect/sql";
import { StoreProbe } from "../src/storage/Store.ts";

export type Phase = { ms: number; statements: number };

export function measureExit<A, E, R>(work: Effect.Effect<A, E, R>, onPhase?: (name: string, now: number) => void) {
  return Effect.gen(function* () {
    const phases: Record<string, Phase> = {};
    const start = performance.now();
    let last = start;
    let name = "transaction startup";
    let rows = 0;
    const current = () => (phases[name] ??= { ms: 0, statements: 0 });
    const phase = (next: string) => {
      const now = performance.now();
      current().ms += now - last;
      last = now;
      name = next;
      onPhase?.(next, now);
    };
    const exit = yield* work.pipe(
      Effect.provideService(StoreProbe, { phase, rows: (n) => (rows += n) }),
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        current().statements++;
        return Effect.succeed(statement);
      }),
      Effect.exit,
    );
    phase("finish");
    return { exit, phases, start_ms: start, end_ms: last, wall_ms: last - start, rows };
  });
}

export function measure<A, E, R>(work: Effect.Effect<A, E, R>) {
  return measureExit(work).pipe(
    Effect.flatMap(({ exit, ...sample }) =>
      Exit.isSuccess(exit) ? Effect.succeed({ ...sample, value: exit.value }) : Effect.failCause(exit.cause),
    ),
  );
}

export function average(samples: Record<string, Phase>[]) {
  const phases: Record<string, Phase> = {};
  for (const sample of samples)
    for (const [name, { ms, statements }] of Object.entries(sample)) {
      const total = (phases[name] ??= { ms: 0, statements: 0 });
      total.ms += ms / samples.length;
      total.statements += statements / samples.length;
    }
  return phases;
}
