import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidRequestId,
  resolveRequestIdHeader
} from "./request-id.js";

test("validates request IDs with a safe bounded character set", () => {
  assert.equal(isValidRequestId("req_12345678"), true);
  assert.equal(isValidRequestId("abc"), false);
  assert.equal(isValidRequestId("request id with spaces"), false);
  assert.equal(isValidRequestId("req\r\nx-secret: leaked"), false);
});

test("resolves missing and invalid request IDs to generated IDs", () => {
  const missing = resolveRequestIdHeader(undefined);
  assert.equal(missing.ok, true);
  assert.equal(isValidRequestId(missing.requestId), true);

  const invalid = resolveRequestIdHeader("bad id");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_format");
  assert.notEqual(invalid.requestId, "bad id");
  assert.equal(isValidRequestId(invalid.requestId), true);
});
