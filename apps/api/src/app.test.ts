import assert from "node:assert/strict";
import test from "node:test";
import { problemJsonContentType } from "@vind/contracts";
import { buildApp } from "./app.js";
import { isValidRequestId } from "./request-id.js";

test("GET /api/v1/health/live generates and propagates a request ID", async (t) => {
  const app = buildApp({ readinessDependencies: [] });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/live"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "live" });
  assert.equal(isValidRequestId(String(response.headers["x-request-id"])), true);
});

test("GET /api/v1/health/live propagates a valid inbound request ID", async (t) => {
  const app = buildApp({ readinessDependencies: [] });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/live",
    headers: {
      "x-request-id": "req_12345678"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-request-id"], "req_12345678");
});

test("invalid request IDs return problem+json with a generated request ID", async (t) => {
  const app = buildApp({ readinessDependencies: [] });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/live",
    headers: {
      "x-request-id": "bad id"
    }
  });
  const body = response.json();

  assert.equal(response.statusCode, 400);
  assert.equal(String(response.headers["content-type"]).includes(problemJsonContentType), true);
  assert.equal(body.code, "invalid_request_id");
  assert.notEqual(body.requestId, "bad id");
  assert.equal(response.headers["x-request-id"], body.requestId);
});

test("GET /api/v1/health/ready returns ready when dependencies pass", async (t) => {
  const app = buildApp({
    readinessDependencies: [
      {
        name: "database",
        async check() {
          await Promise.resolve();
        }
      }
    ]
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/ready"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ready",
    dependencies: [{ name: "database", status: "ready" }]
  });
});

test("GET /api/v1/health/ready fails safely without leaking dependency exceptions", async (t) => {
  const leaked = "postgres://user:super_secret@localhost:5432/vind_app_dev";
  const app = buildApp({
    readinessDependencies: [
      {
        name: "database",
        async check() {
          throw new Error(`connection failed for ${leaked}`);
        }
      }
    ]
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/ready"
  });
  const bodyText = response.body;
  const body = response.json();

  assert.equal(response.statusCode, 503);
  assert.equal(String(response.headers["content-type"]).includes(problemJsonContentType), true);
  assert.equal(body.code, "service_unavailable");
  assert.equal(body.detail, "One or more dependencies are not ready.");
  assert.deepEqual(body.dependencies, [{ name: "database", status: "down" }]);
  assert.doesNotMatch(bodyText, /postgres:\/\/|super_secret|connection failed/);
});

test("GET /api/v1/openapi.json serves the OpenAPI 3.1 document", async (t) => {
  const app = buildApp({ readinessDependencies: [] });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openapi.json"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().openapi, "3.1.0");
});

test("unknown routes return the common problem model", async (t) => {
  const app = buildApp({ readinessDependencies: [] });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/missing",
    headers: {
      "x-request-id": "req_missing_123"
    }
  });
  const body = response.json();

  assert.equal(response.statusCode, 404);
  assert.equal(String(response.headers["content-type"]).includes(problemJsonContentType), true);
  assert.equal(body.code, "not_found");
  assert.equal(body.requestId, "req_missing_123");
  assert.equal(response.headers["x-request-id"], "req_missing_123");
});
