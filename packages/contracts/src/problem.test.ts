import assert from "node:assert/strict";
import test from "node:test";
import {
  createProblemDetails,
  problemJsonContentType
} from "./problem.js";

test("creates stable problem+json details with approved fields", () => {
  const problem = createProblemDetails({
    code: "DEPENDENCY_UNAVAILABLE",
    requestId: "req_12345678",
    instance: "/api/v1/health/ready",
    detail: "A required dependency is unavailable."
  });

  assert.equal(problemJsonContentType, "application/problem+json");
  assert.equal(problem.type, "urn:vind:error:DEPENDENCY_UNAVAILABLE");
  assert.equal(problem.title, "Dependency Unavailable");
  assert.equal(problem.status, 503);
  assert.equal(problem.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(problem.request_id, "req_12345678");
  assert.equal(problem.retryable, true);
  assert.equal("requestId" in problem, false);
});

test("supports optional field-error details for validation foundations", () => {
  const problem = createProblemDetails({
    code: "VALIDATION_FAILED",
    requestId: "req_validation_123",
    instance: "/api/v1/example",
    fieldErrors: [
      {
        field: "name",
        code: "REQUIRED",
        message: "Name is required."
      }
    ]
  });

  assert.equal(problem.type, "urn:vind:error:VALIDATION_FAILED");
  assert.equal(problem.retryable, false);
  assert.deepEqual(problem.field_errors, [
    {
      field: "name",
      code: "REQUIRED",
      message: "Name is required."
    }
  ]);
});
