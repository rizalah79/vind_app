import assert from "node:assert/strict";
import test from "node:test";
import { problemJsonContentType } from "@vind/contracts";
import { buildApp } from "./app.js";
import { isValidRequestId } from "./request-id.js";

test("GET /api/v1/health/live returns the common success envelope with a generated request ID", async (t) => {
  const app = buildApp({ readinessDependencies: [] });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/live"
  });
  const body = response.json();
  const responseRequestId = String(response.headers["x-request-id"]);

  assert.equal(response.statusCode, 200);
  assert.equal(isValidRequestId(responseRequestId), true);
  assert.deepEqual(body, {
    data: { status: "live" },
    meta: { request_id: responseRequestId }
  });
});

test("GET /api/v1/health/live propagates a valid inbound request ID into headers and meta", async (t) => {
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
  assert.equal(response.json().meta.request_id, "req_12345678");
});

test("malformed inbound request IDs are normalized and do not reject valid requests", async (t) => {
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
  const responseRequestId = String(response.headers["x-request-id"]);

  assert.equal(response.statusCode, 200);
  assert.equal(isValidRequestId(responseRequestId), true);
  assert.notEqual(responseRequestId, "bad id");
  assert.deepEqual(body, {
    data: { status: "live" },
    meta: { request_id: responseRequestId }
  });
});

test("multiple inbound request IDs are normalized and never echoed", async (t) => {
  const app = buildApp({ readinessDependencies: [] });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/live",
    headers: {
      "x-request-id": ["req_12345678", "req_87654321"]
    }
  });
  const responseRequestId = String(response.headers["x-request-id"]);

  assert.equal(response.statusCode, 200);
  assert.equal(isValidRequestId(responseRequestId), true);
  assert.notEqual(responseRequestId, "req_12345678");
  assert.notEqual(responseRequestId, "req_87654321");
  assert.deepEqual(response.json(), {
    data: { status: "live" },
    meta: { request_id: responseRequestId }
  });
});

test("GET /api/v1/health/ready returns a generic public success envelope", async (t) => {
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
    url: "/api/v1/health/ready",
    headers: {
      "x-request-id": "ready_12345678"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    data: { status: "ready" },
    meta: { request_id: "ready_12345678" }
  });
  assert.doesNotMatch(response.body, /database|dependency|postgres/i);
});

test("GET /api/v1/health/ready fails safely without public dependency inventory", async (t) => {
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
    url: "/api/v1/health/ready",
    headers: {
      "x-request-id": "ready_fail_123"
    }
  });
  const bodyText = response.body;
  const body = response.json();

  assert.equal(response.statusCode, 503);
  assert.equal(String(response.headers["content-type"]).includes(problemJsonContentType), true);
  assert.equal(body.type, "urn:vind:error:DEPENDENCY_UNAVAILABLE");
  assert.equal(body.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(body.request_id, "ready_fail_123");
  assert.equal(body.retryable, true);
  assert.equal(body.detail, "A required dependency is unavailable.");
  assert.equal("requestId" in body, false);
  assert.equal("dependencies" in body, false);
  assert.doesNotMatch(bodyText, /database|postgres:\/\/|super_secret|connection failed/i);
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

test("unknown routes return the common problem model with request_id and stable uppercase code", async (t) => {
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
  assert.equal(body.type, "urn:vind:error:RESOURCE_NOT_FOUND");
  assert.equal(body.code, "RESOURCE_NOT_FOUND");
  assert.equal(body.request_id, "req_missing_123");
  assert.equal(body.retryable, false);
  assert.equal("requestId" in body, false);
  assert.equal(response.headers["x-request-id"], "req_missing_123");
});
