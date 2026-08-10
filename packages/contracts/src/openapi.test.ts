import assert from "node:assert/strict";
import test from "node:test";
import { openApiDocument } from "./openapi.js";

test("exports an OpenAPI 3.1 foundation document", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.ok(openApiDocument.paths["/api/v1/health/live"]);
  assert.ok(openApiDocument.paths["/api/v1/health/ready"]);
  assert.ok(openApiDocument.paths["/api/v1/openapi.json"]);
  assert.ok(openApiDocument.components.schemas.ProblemDetails);
});
