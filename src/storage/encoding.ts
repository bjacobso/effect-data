import { canonical, type Value } from "../core/model.ts";

// JSON text inside jsonb preserves NUL and lone surrogates.
export const encodeValue = (value: unknown) => JSON.stringify(canonical(value));
export const decodeValue = (value: string): Value => JSON.parse(value);
