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

test("resolves missing, invalid, and multiple request IDs to generated IDs", () => {
  const missing = resolveRequestIdHeader(undefined);
  assert.equal(missing.ok, true);
  assert.equal(isValidRequestId(missing.requestId), true);

  const invalid = resolveRequestIdHeader("bad id");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_format");
  assert.notEqual(invalid.requestId, "bad id");
  assert.equal(isValidRequestId(invalid.requestId), true);

  const multiple = resolveRequestIdHeader(["req_12345678", "req_87654321"]);
  assert.equal(multiple.ok, false);
  assert.equal(multiple.reason, "multiple_values");
  assert.notEqual(multiple.requestId, "req_12345678");
  assert.notEqual(multiple.requestId, "req_87654321");
  assert.equal(isValidRequestId(multiple.requestId), true);
});
