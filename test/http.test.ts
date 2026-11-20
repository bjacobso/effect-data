import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, request } from "node:http";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { HttpRouter, HttpServer } from "effect/http";
import { Routes } from "../src/http/routes.ts";
import { dataLayer, selectPacks } from "../src/composition.ts";
import { migrate } from "../src/Migrations.ts";
import { fixture } from "./fixtures.ts";
const database = PgClient.layer({
  url: Redacted.make(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/onb_data_test"),
  maxConnections: 5,
});
const runtime = ManagedRuntime.make(
  HttpRouter.serve(Routes, { disableLogger: true }).pipe(
    Layer.provide(dataLayer(selectPacks("onboarding,certification"))),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
  ),
);
let base: string;
const headers = { "content-type": "application/json", "x-account-id": `acct_http_${Date.now()}` };
beforeAll(async () => {
  await runtime.runPromise(migrate);
  base = HttpServer.formatAddress((await runtime.runPromise(HttpServer.HttpServer)).address);
}, 30000);
afterAll(() => runtime.dispose());

test("HttpApi publishes the pack group and strict registry/action schemas", async () => {
  const res = await fetch(`${base}/v2/openapi.json`),
    api = await res.json();
  expect(res.status).toBe(200);
  expect(api.paths["/v2/entities/{id}/evaluate"].post.tags).toEqual(["onboarding"]);
  const registry = api.paths["/v2/registry"].put.requestBody.content["application/json"].schema;
  expect(registry.properties).toHaveProperty("policies");
  expect(registry.required).toContain("base_version");
  expect(
    registry.properties.automations.items.properties.do.items.anyOf.map(
      (s: { properties: { op: { enum: string[] } } }) => s.properties.op.enum[0],
    ),
  ).toEqual(["set", "send_form", "notify", "schedule_renewal"]);
});

test("HttpApi maps schema, domain, and fallback errors to the existing envelope", async () => {
  const invalid = await fetch(`${base}/v2/entities`, { method: "POST", headers, body: JSON.stringify({ shape: "missing", facts: {} }) });
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed", details: [{ field: "shape" }] } });
  const malformed = await fetch(`${base}/v2/registry`, { method: "PUT", headers, body: "{nope" });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { code: "bad_request" } });
  const empty = await fetch(`${base}/v2/registry`, { method: "PUT", headers, body: "" });
  expect(empty.status).toBe(400);
  expect(await empty.json()).toMatchObject({ error: { code: "bad_request" } });
  const missing = await fetch(`${base}/no-such-route`, { headers });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  const noAccount = await fetch(`${base}/v2/registry`);
  expect(noAccount.status).toBe(400);
  const registry = await fetch(`${base}/v2/registry`, { method: "PUT", headers, body: JSON.stringify({ base_version: 0, ...fixture() }) });
  expect(registry.status).toBe(200);
  const jsonSchema = await fetch(`${base}/v2/registry/json-schema/employee`, { headers });
  expect(jsonSchema.status).toBe(200);
  expect(await jsonSchema.json()).toMatchObject({ additionalProperties: false, required: ["person/email"] });
});

test("request cap rejects Content-Length and chunked bodies over one MiB", async () => {
  const body = JSON.stringify({ facts: "x".repeat(1048576) });
  const knownSize = await fetch(`${base}/v2/entities`, { method: "POST", headers, body });
  expect(knownSize.status).toBe(413);
  expect(await knownSize.json()).toMatchObject({ error: { code: "bad_request" } });
  const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`${base}/v2/entities`, { method: "POST", headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(body.slice(0, 600000));
    req.write(body.slice(600000));
    req.end();
  });
  expect(chunked.status).toBe(413);
  expect(JSON.parse(chunked.body)).toMatchObject({ error: { code: "bad_request" } });
});

test("generic HTTP composition exposes only enabled collections, operations, and groups", async () => {
  for (const selected of ["", "onboarding", "certification"]) {
    const local = ManagedRuntime.make(
      HttpRouter.serve(Routes, { disableLogger: true }).pipe(
        Layer.provide(dataLayer(selectPacks(selected))),
        Layer.provideMerge(database),
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
      ),
    );
    try {
      const address = HttpServer.formatAddress((await local.runPromise(HttpServer.HttpServer)).address),
        account = { ...headers, "x-account-id": `acct_modes_${selected || "none"}_${Date.now()}` };
      const stored = await fetch(`${address}/v2/registry`, { method: "PUT", headers: account, body: JSON.stringify({ base_version: 0 }) });
      expect(stored.status).toBe(200);
      const registry = await stored.json();
      expect(Object.keys(registry).sort()).toEqual(
        [
          "version",
          "attributes",
          "shapes",
          "automations",
          "queries",
          ...(selected === "onboarding" ? ["policies"] : []),
          ...(selected === "certification" ? ["certification_requirements"] : []),
        ].sort(),
      );
      const disabled = selected === "certification" ? "policies" : "certification_requirements";
      const rejected = await fetch(`${address}/v2/registry/plan`, {
        method: "POST",
        headers: account,
        body: JSON.stringify({ [disabled]: [] }),
      });
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ error: { details: [{ field: disabled }] } });
      const document = await (await fetch(`${address}/v2/openapi.json`)).json();
      expect(Boolean(document.paths["/v2/entities/{id}/evaluate"])).toBe(selected === "onboarding");
      expect(Boolean(document.paths["/v2/entities/{id}/certifications"])).toBe(selected === "certification");
      const disabledRoute = selected === "onboarding" ? "certifications" : "evaluate";
      expect(
        (await fetch(`${address}/v2/entities/en_AAAAAAAAAAAAAAAAAAAAA/${disabledRoute}`, { method: "POST", headers: account })).status,
      ).toBe(404);
    } finally {
      await local.dispose();
    }
  }
}, 30000);

test("certification request validation stays inside the pack, including a missing body", async () => {
  const url = `${base}/v2/entities/en_AAAAAAAAAAAAAAAAAAAAA/certifications`;
  for (const body of [undefined, "", "{}", "null", JSON.stringify({ on: "2026-02-30" }), JSON.stringify({ on: 20261118 })]) {
    const r = await fetch(url, { method: "POST", headers, ...(body === undefined ? {} : { body }) });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: { code: "validation_failed", details: [{ field: "on" }] } });
  }
  const malformed = await fetch(url, { method: "POST", headers, body: "{" });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { code: "bad_request" } });
});
