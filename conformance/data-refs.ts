#!/usr/bin/env node
// Usage: BASE_URL=http://localhost:8086 node conformance/data-refs.ts [--filter text]

import { Effect, Schema } from "effect";
import {
  check,
  Empty,
  Entity,
  eqJ,
  expectError,
  expectField,
  History,
  Mutation,
  newAccount,
  Outbox,
  Plan,
  Registry,
  req,
  same,
  suite,
} from "./client.ts";

const Referrers = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      entity_id: Schema.String,
      attribute: Schema.String,
      on_delete: Schema.Literals(["block", "clear"]),
    }),
  ),
});
const { test, run } = suite();
const unknown = "en_AAAAAAAAAAAAAAAAAAAAA";
const fixture = {
  attributes: [
    { key: "node/name", type: "string" },
    { key: "edge/block", type: "ref", target: "node" },
    { key: "edge/second", type: "ref", target: "node" },
    { key: "edge/clear", type: "ref", target: "node", on_delete: "clear" },
    { key: "edge/other", type: "ref", target: "node", on_delete: "clear" },
    { key: "edge/unique", type: "ref", target: "node", unique: true },
  ],
  shapes: [
    { key: "node", attributes: ["node/name", "edge/block", "edge/second", "edge/clear", "edge/other", "edge/unique"] },
    { key: "other", attributes: ["node/name", "edge/unique"] },
  ],
};

const put = (account: string, doc: object, base_version = 0) =>
  req(Registry, "PUT", "/v2/registry", { account, body: { base_version, ...doc } });
const plan = (account: string, doc: object) => req(Plan, "POST", "/v2/registry/plan", { account, body: doc });
const post = (account: string, shape: string, facts: object) => req(Mutation, "POST", "/v2/entities", { account, body: { shape, facts } });
const create = Effect.fnUntraced(function* (account: string, facts: object = {}, shape = "node") {
  const response = yield* post(account, shape, facts);
  yield* eqJ(response.status, 201, "created entity");
  return yield* response.body;
});
const patch = (account: string, id: string, facts: object) => req(Mutation, "PATCH", `/v2/entities/${id}`, { account, body: { facts } });
const drop = (account: string, id: string) => req(Empty, "DELETE", `/v2/entities/${id}`, { account });
const inbound = (account: string, id: string) => req(Referrers, "GET", `/v2/entities/${id}/referrers`, { account });
const history = (account: string, id: string) => req(History, "GET", `/v2/entities/${id}/history`, { account });
const get = (account: string, id: string, at?: string) =>
  req(Entity, "GET", `/v2/entities/${id}${at ? `?as_of=${encodeURIComponent(at)}` : ""}`, { account });
const orderBySource = <T extends { entity_id: string; attribute: string }>(entries: T[]) =>
  entries.sort((a, b) => (a.entity_id === b.entity_id ? (a.attribute < b.attribute ? -1 : 1) : a.entity_id < b.entity_id ? -1 : 1));

test(
  "ref declarations, target shape, account isolation, retargeting and self-reference",
  Effect.gen(function* () {
    const account = newAccount();
    const invalid = {
      ...fixture,
      attributes: fixture.attributes.map((attr) => (attr.key === "edge/block" ? { ...attr, target: "missing" } : attr)),
    };
    const impact = yield* (yield* plan(account, invalid)).body;
    yield* eqJ(
      impact.issues.map((issue) => issue.field),
      ["attributes[1].target"],
      "unknown target is a registry reference issue",
    );
    yield* expectField(
      yield* expectError(yield* put(account, invalid), 422, "validation_failed", "unknown target"),
      "attributes[1].target",
      "target issue",
    );

    const registry = yield* (yield* put(account, fixture)).body;
    yield* same(registry.attributes, fixture.attributes, "default on_delete stays omitted");
    const first = yield* create(account);
    const second = yield* create(account);
    const wrong = yield* create(account, {}, "other");
    const otherAccount = newAccount();
    yield* (yield* put(otherAccount, fixture)).body;
    const foreign = yield* create(otherAccount);
    const deleted = yield* create(account);
    yield* eqJ((yield* drop(account, deleted.id)).status, 204, "delete unreferenced target");
    for (const id of [unknown, wrong.id, foreign.id, deleted.id]) {
      const error = yield* expectError(yield* post(account, "node", { "edge/block": id }), 422, "validation_failed", "invalid live target");
      yield* same(error.details, [{ field: "facts.edge/block", issue: "Unknown reference" }], "target failure");
    }
    yield* expectField(
      yield* expectError(yield* post(account, "node", { "edge/block": "bad-id" }), 422, "validation_failed", "invalid id syntax"),
      "facts.edge/block",
      "ref format",
    );

    const source = yield* create(account, { "edge/block": first.id });
    yield* same(
      (yield* (yield* inbound(account, first.id)).body).data,
      [{ entity_id: source.id, attribute: "edge/block", on_delete: "block" }],
      "initial edge",
    );
    const retargeted = yield* (yield* patch(account, source.id, { "edge/block": second.id })).body;
    yield* eqJ(retargeted.facts["edge/block"], second.id, "changed target");
    yield* eqJ((yield* (yield* inbound(account, first.id)).body).data, [], "old target has no referrers");
    yield* (yield* patch(account, source.id, { "edge/block": null })).body;
    yield* eqJ((yield* (yield* inbound(account, second.id)).body).data, [], "null removes edge");
    yield* (yield* patch(account, source.id, { "edge/block": source.id })).body;
    yield* same(
      (yield* (yield* inbound(account, source.id)).body).data,
      [{ entity_id: source.id, attribute: "edge/block", on_delete: "block" }],
      "self edge is visible",
    );
    yield* eqJ((yield* drop(account, source.id)).status, 204, "self edge does not block delete");
    yield* expectError(yield* inbound(account, source.id), 404, "not_found", "deleted target");
    yield* expectError(yield* inbound(account, unknown), 404, "not_found", "unknown target");
    yield* eqJ(
      (yield* (yield* get(account, source.id, retargeted.updated_at)).body).facts["edge/block"],
      second.id,
      "historical edge survives graph changes",
    );
  }),
);

test(
  "block failures list all other blocking edges in order and write nothing",
  Effect.gen(function* () {
    const account = newAccount();
    yield* (yield* put(account, fixture)).body;
    const target = yield* create(account, { "node/name": "target" });
    const first = yield* create(account, { "edge/second": target.id, "edge/block": target.id });
    const second = yield* create(account, { "edge/block": target.id, "edge/clear": target.id });
    const entries = orderBySource([
      { entity_id: first.id, attribute: "edge/block", on_delete: "block" },
      { entity_id: first.id, attribute: "edge/second", on_delete: "block" },
      { entity_id: second.id, attribute: "edge/block", on_delete: "block" },
      { entity_id: second.id, attribute: "edge/clear", on_delete: "clear" },
    ]);
    yield* same((yield* (yield* inbound(account, target.id)).body).data, entries, "ordered live referrers and policies");
    const error = yield* expectError(yield* drop(account, target.id), 409, "conflict", "blocked delete");
    yield* same(
      error.details,
      entries
        .filter((edge) => edge.on_delete === "block")
        .map((edge) => ({
          field: `${edge.entity_id}.facts.${edge.attribute}`,
          issue: "Referenced",
        })),
      "ordered blockers only",
    );
    yield* eqJ((yield* (yield* get(account, target.id)).body).version, target.version, "no delete marker");
    yield* eqJ((yield* (yield* get(account, second.id)).body).version, second.version, "no clear while another edge blocks");
    yield* eqJ((yield* (yield* history(account, target.id)).body).data.length, 1, "no fact rows on conflict");
  }),
);

test(
  "clear retracts each edge in its own transaction without triggering automations",
  Effect.gen(function* () {
    const account = newAccount();
    const registry = {
      ...fixture,
      automations: [
        {
          id: "watch",
          shape: "node",
          on: { changed: ["edge/clear"] },
          when: { fact: "edge/clear", operator: "doesNotExist" },
          do: [{ op: "notify", message: "cleared" }],
        },
      ],
    };
    yield* (yield* put(account, registry)).body;
    const target = yield* create(account, { "node/name": "target" });
    const first = yield* create(account, { "edge/clear": target.id, "edge/other": target.id });
    const second = yield* create(account, { "edge/clear": target.id });
    yield* eqJ((yield* drop(account, target.id)).status, 204, "clear delete");
    const deleteRows = (yield* (yield* history(account, target.id)).body).data;
    let previousTx = deleteRows.at(-1)!.tx;
    for (const source of [first, second].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const rows = (yield* (yield* history(account, source.id)).body).data.filter((row) => row.reason === "reference");
      const keys = source.id === first.id ? ["edge/clear", "edge/other"] : ["edge/clear"];
      yield* same(
        rows.map(({ tx: _tx, at: _at, ...row }) => row),
        keys.map((attribute) => ({
          attribute,
          op: "retract",
          value: target.id,
          reason: "reference",
          actor: `reference:${target.id}`,
        })),
        "one cascade history row per fact",
      );
      const expected: Record<string, string | number | boolean> = { ...source.facts };
      yield* same(
        (yield* (yield* get(account, source.id, source.updated_at)).body).facts,
        expected,
        "as_of before clear keeps the deleted target id",
      );
      for (const row of rows) {
        yield* check(row.tx > previousTx, "cascade transactions are strictly ordered");
        previousTx = row.tx;
        delete expected[row.attribute];
        yield* same(
          (yield* (yield* get(account, source.id, row.at)).body).facts,
          expected,
          "as_of includes just the retractions by this tx",
        );
      }
      const current = yield* (yield* get(account, source.id)).body;
      yield* eqJ(current.version, source.version + keys.length, "each retraction advances the entity version");
      yield* same(current.facts, {}, "both clear edges are gone");
    }
    yield* eqJ((yield* (yield* req(Outbox, "GET", "/v2/outbox", { account })).body).data, [], "clear did not fire the automation");
  }),
);

test(
  "registry impact follows live targets, and string/ref conversions reconcile edges",
  Effect.gen(function* () {
    const account = newAccount();
    const before = {
      ...fixture,
      attributes: fixture.attributes.map((attr) => (attr.key === "edge/block" ? { key: attr.key, type: "string" } : attr)),
    };
    yield* (yield* put(account, before)).body;
    const target = yield* create(account);
    const source = yield* create(account, { "edge/block": target.id });
    const bad = yield* create(account, { "edge/block": "old ordinary text" });
    const convert = yield* (yield* plan(account, fixture)).body;
    yield* same(
      convert.violations,
      [{ entity_id: bad.id, field: "facts.edge/block", issue: "Dangling reference" }],
      "legacy string with no live target",
    );
    yield* (yield* patch(account, bad.id, { "edge/block": null })).body;
    yield* (yield* put(account, fixture, 1)).body;
    yield* same(
      (yield* (yield* inbound(account, target.id)).body).data,
      [{ entity_id: source.id, attribute: "edge/block", on_delete: "block" }],
      "apply materializes the existing edge",
    );

    const retarget = {
      ...fixture,
      attributes: fixture.attributes.map((attr) => (attr.key === "edge/block" ? { ...attr, target: "other" } : attr)),
    };
    const expected = [{ entity_id: source.id, field: "facts.edge/block", issue: "Dangling reference" }];
    yield* same((yield* (yield* plan(account, retarget)).body).violations, expected, "target shape change breaks existing fact");
    const rejected = yield* expectError(yield* put(account, retarget, 2), 409, "conflict", "reject incompatible retarget");
    yield* same(rejected.details, [{ field: `${source.id}.facts.edge/block`, issue: "Dangling reference" }], "apply details");
    yield* (yield* put(account, before, 2)).body;
    yield* eqJ((yield* (yield* inbound(account, target.id)).body).data, [], "conversion to string removes edge without changing the fact");
    yield* eqJ((yield* (yield* get(account, source.id)).body).facts["edge/block"], target.id, "string value survives conversion");
    yield* (yield* patch(account, source.id, { "edge/block": null })).body;
    yield* (yield* put(account, retarget, 3)).body;
  }),
);

test(
  "unique refs use live uniqueness across shapes",
  Effect.gen(function* () {
    const account = newAccount();
    yield* (yield* put(account, fixture)).body;
    const target = yield* create(account);
    const source = yield* create(account, { "edge/unique": target.id });
    yield* expectField(
      yield* expectError(yield* post(account, "other", { "edge/unique": target.id }), 409, "conflict", "unique ref"),
      "facts.edge/unique",
      "unique field",
    );
    yield* (yield* patch(account, source.id, { "edge/unique": null })).body;
    yield* create(account, { "edge/unique": target.id }, "other");
  }),
);

test(
  "automation set of an invalid ref rolls back facts, outbox and edges",
  Effect.gen(function* () {
    const account = newAccount();
    yield* (yield* put(account, {
      ...fixture,
      automations: [
        {
          id: "invalid",
          shape: "node",
          on: { changed: ["edge/block"] },
          do: [
            { op: "notify", message: "roll back" },
            { op: "set", attribute: "edge/clear", value: unknown },
          ],
        },
      ],
    })).body;
    const target = yield* create(account);
    const source = yield* create(account, { "node/name": "source" });
    const previous = yield* (yield* history(account, source.id)).body;
    const response = yield* patch(account, source.id, { "edge/block": target.id });
    const error = yield* expectError(response, 422, "validation_failed", "invalid automation target");
    yield* same(error.details, [{ field: "facts.edge/clear", issue: "Unknown reference" }], "automation set validates like PATCH");
    yield* same(yield* (yield* history(account, source.id)).body, previous, "no partial history");
    yield* same((yield* (yield* get(account, source.id)).body).facts, source.facts, "no partial projection");
    yield* eqJ((yield* (yield* inbound(account, target.id)).body).data, [], "no partial edge");
    yield* eqJ((yield* (yield* req(Outbox, "GET", "/v2/outbox", { account })).body).data, [], "no partial outbox");
  }),
);

test(
  "create versus delete is race-free over 50 attempts",
  Effect.gen(function* () {
    const account = newAccount();
    yield* (yield* put(account, fixture)).body;
    for (let i = 0; i < 50; i++) {
      const target = yield* create(account);
      const requests = {
        creation: post(account, "node", { "edge/block": target.id }),
        removal: drop(account, target.id),
      };
      const { creation, removal } = yield* Effect.all(i % 2 ? { removal: requests.removal, creation: requests.creation } : requests, {
        concurrency: "unbounded",
      });
      if (creation.status === 201) {
        yield* expectError(removal, 409, "conflict", "delete loses to the new reference");
        const source = yield* creation.body;
        yield* same(
          (yield* (yield* inbound(account, target.id)).body).data,
          [{ entity_id: source.id, attribute: "edge/block", on_delete: "block" }],
          "winning edge is live",
        );
      } else {
        yield* eqJ(removal.status, 204, "delete wins against create");
        yield* expectError(creation, 422, "validation_failed", "create loses to delete");
        yield* expectError(yield* inbound(account, target.id), 404, "not_found", "target deleted without a live edge");
      }
    }
  }),
);

run();
