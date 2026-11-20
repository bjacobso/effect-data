import { Effect, Schema } from "effect";
import { Entity, Plan, Query, Registry, Mutation, check, eqJ, expectError, expectField, newAccount, req, same, suite } from "./client.ts";

const { test, run } = suite();
const name = "item/name",
  score = "item/score",
  link = "item/link",
  retired = "item/retired";
const registry = {
  attributes: [
    { key: name, type: "string" },
    { key: score, type: "integer" },
    { key: link, type: "ref", target: "item" },
    { key: retired, type: "string", retired: true },
  ],
  shapes: [{ key: "item", attributes: [name, score, link] }],
};
type QueryDoc = typeof Query.Type;
const page = Schema.Struct({ data: Schema.Array(Entity), next_after: Schema.NullOr(Schema.String) });
const put = (account: string, base_version: number, doc: object = registry) =>
  req(Registry, "PUT", "/v2/registry", { account, body: { base_version, ...doc } });
const create = (account: string, facts: object) =>
  req(Mutation, "POST", "/v2/entities", { account, body: { shape: "item", facts } }).pipe(Effect.flatMap((r) => r.body));
const inline = (account: string, query: object, options: object = {}) =>
  req(page, "POST", "/v2/query", { account, body: { query, ...options } });
const stored = (account: string, id: string, options: object = {}) =>
  req(page, "POST", `/v2/queries/${id}/run`, { account, body: options });
const all: QueryDoc = { id: "all-items", shape: "item", order_by: [] };

test(
  "stored and inline queries use three-valued rules and return the entity GET document",
  Effect.gen(function* () {
    const a = newAccount();
    const query = { ...all, where: { fact: name, operator: "in", value: ["É"], ignore_case: true } };
    const installed = yield* (yield* put(a, 0, { ...registry, queries: [query] })).body;
    yield* same(installed.queries, [query], "query kind is persisted");
    const matching = yield* create(a, { [name]: "é" });
    const unknown = yield* create(a, { [score]: 8 });
    yield* create(a, { [name]: "wrong" });
    const expected = yield* (yield* req(Entity, "GET", `/v2/entities/${matching.id}`, { account: a })).body;
    const first = yield* (yield* stored(a, query.id)).body;
    yield* same(first, { data: [expected], next_after: null }, "stored result matches GET");
    yield* same(yield* (yield* inline(a, query)).body, first, "inline result matches stored");
    const u = yield* (yield* inline(a, query, { match: "unknown" })).body;
    yield* eqJ(
      u.data.map(({ id }) => id),
      [unknown.id],
      "absent in yields U",
    );
    const notIn = { ...query, where: { ...query.where, operator: "notIn" } };
    yield* eqJ(
      (yield* (yield* inline(a, notIn, { match: "unknown" })).body).data.map(({ id }) => id),
      [unknown.id],
      "absent notIn yields U",
    );
    yield* expectError(yield* stored(a, "missing"), 404, "not_found", "unknown stored query");
  }),
);

test(
  "keyset pages order nulls last in both directions and bind the cursor to its request",
  Effect.gen(function* () {
    const a = newAccount(),
      other = newAccount();
    yield* (yield* put(a, 0)).body;
    yield* (yield* put(other, 0)).body;
    const eight = yield* create(a, { [score]: 8 }),
      two = yield* create(a, { [score]: 2 }),
      absent = yield* create(a, { [name]: "no score" }),
      secondTwo = yield* create(a, { [score]: 2 });
    const tied = [two.id, secondTwo.id].sort();
    let ascCursor = "";
    for (const direction of ["asc", "desc"]) {
      const query = { ...all, order_by: [{ attribute: score, direction }] };
      const ids: string[] = [];
      let after: string | null = null;
      for (let i = 0; i < 5; i++) {
        const result: typeof page.Type = yield* (yield* inline(a, query, { limit: i === 1 ? 2 : 1, ...(after ? { after } : {}) })).body;
        ids.push(...result.data.map(({ id }) => id));
        after = result.next_after;
        if (i === 0 && direction === "asc") ascCursor = after!;
        if (after === null) break;
      }
      yield* eqJ(after, null, "walk terminated");
      yield* eqJ(
        ids,
        direction === "asc" ? [...tied, eight.id, absent.id] : [eight.id, ...tied, absent.id],
        `${direction} order and tie break`,
      );
    }
    const asc = { ...all, order_by: [{ attribute: score, direction: "asc" }] };
    for (const [acct, query, options] of [
      [a, { ...asc, id: "changed" }, { after: ascCursor }],
      [a, asc, { after: ascCursor, match: "unknown" }],
      [other, asc, { after: ascCursor }],
      [a, asc, { after: "invalid cursor" }],
    ] as const)
      yield* expectError(yield* inline(acct, query, options), 400, "bad_request", "misapplied cursor");
    yield* (yield* put(a, 1, { ...registry, queries: [asc] })).body;
    yield* expectError(yield* inline(a, asc, { after: ascCursor }), 400, "bad_request", "registry version changed");
    const newCursor = (yield* (yield* inline(a, asc, { limit: 1 })).body).next_after;
    yield* expectError(yield* stored(a, asc.id, { after: newCursor }), 400, "bad_request", "inline cursor on stored route");
  }),
);

test(
  "registry and inline query checks share paths and reject invalid references and ordering",
  Effect.gen(function* () {
    const a = newAccount();
    yield* (yield* put(a, 0)).body;
    for (const [query, field] of [
      [{ ...all, where: { fact: "item/unknown", operator: "exists" } }, "where.fact"],
      [{ ...all, where: { fact: score, operator: "contains", value: 2 } }, "where.operator"],
      [{ ...all, order_by: [{ attribute: link, direction: "asc" }] }, "order_by[0].attribute"],
      [{ ...all, where: { fact: retired, operator: "exists" } }, "where.fact"],
      [
        {
          ...all,
          order_by: [
            { attribute: score, direction: "asc" },
            { attribute: score, direction: "desc" },
          ],
        },
        "order_by[1].attribute",
      ],
    ] as const) {
      const failed = yield* expectError(yield* inline(a, query), 422, "validation_failed", "invalid inline query");
      yield* expectField(failed, `query.${field}`, "inline field");
      const rejected = yield* expectError(
        yield* put(a, 1, { ...registry, queries: [query] }),
        422,
        "validation_failed",
        "invalid stored query",
      );
      yield* expectField(rejected, `queries[0].${field}`, "stored field");
    }
    const planned = yield* (yield* req(Plan, "POST", "/v2/registry/plan", { account: a, body: { ...registry, queries: [all] } })).body;
    yield* same(planned.changes, [{ kind: "query", key: all.id, change: "added" }], "query appears in plan");
  }),
);

test(
  "hidden facts disappear and return on restore, and query results carry rollout violations",
  Effect.gen(function* () {
    const a = newAccount();
    yield* (yield* put(a, 0)).body;
    const first = yield* create(a, { [name]: "shared" }),
      second = yield* create(a, { [name]: "shared" });
    const query = { ...all, where: { fact: name, operator: "equal", value: "shared" } };
    const hidden = { ...registry, shapes: [{ key: "item", attributes: [score, link] }] };
    yield* (yield* put(a, 1, hidden)).body;
    const without = (yield* (yield* inline(a, all)).body).data;
    yield* check(without.length === 2 && without.every(({ facts }) => !Object.hasOwn(facts, name)), "hidden values omitted");
    yield* expectError(yield* inline(a, query), 422, "validation_failed", "hidden attribute unavailable to rules");
    const unique = {
      ...registry,
      attributes: [{ ...registry.attributes[0], unique: true }, ...registry.attributes.slice(1)],
      queries: [query],
    };
    yield* (yield* put(a, 2, unique)).body;
    let done = false;
    for (let i = 0; i < 200; i++) {
      const state = yield* (yield* req(Registry, "GET", "/v2/registry", { account: a })).body;
      if (state.rollout?.status === "done") {
        done = true;
        break;
      }
      yield* Effect.sleep("25 millis");
    }
    yield* check(done, "rollout finished");
    const restored = yield* (yield* stored(a, query.id)).body;
    yield* eqJ(
      restored.data.map(({ id }) => id),
      [first.id, second.id].sort(),
      "both stored matches restored",
    );
    yield* same(restored.data[1]?.violations, [{ attribute: name, issue: "duplicate" }], "open violation included");
  }),
);
run();
