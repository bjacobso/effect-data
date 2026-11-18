import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
export const makeClock = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    reserve: (account: string, count: number) =>
      sql<{ tx: string; ms: string }>`
    INSERT INTO account_clocks(account_id,tx,at_ms)
    VALUES (${account},${count},floor(extract(epoch FROM clock_timestamp())*1000)::bigint+${count}-1)
    ON CONFLICT(account_id) DO UPDATE SET tx=account_clocks.tx+${count},
      at_ms=greatest(account_clocks.at_ms+${count},EXCLUDED.at_ms)
    RETURNING (tx-${count})::text AS tx,(at_ms-${count})::text AS ms
  `.pipe(Effect.map((rows) => ({ tx: Number(rows[0]!.tx), ms: Number(rows[0]!.ms) }))),
  };
});
export class Clock extends Context.Service<Clock, Effect.Success<typeof makeClock>>()("data/Clock") {
  static layer = Layer.effect(Clock, makeClock);
}
