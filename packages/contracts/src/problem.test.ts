import assert from "node:assert/strict";
import test from "node:test";
import {
  createProblemDetails,
  problemJsonContentType
} from "./problem.js";

test("creates stable problem+json details", () => {
  const problem = createProblemDetails({
    code: "service_unavailable",
    requestId: "req_12345678",
    instance: "/api/v1/health/ready",
    detail: "One or more dependencies are not ready.",
    extensions: {
      dependencies: [{ name: "database", status: "down" }]
    }
  });

  assert.equal(problemJsonContentType, "application/problem+json");
  assert.equal(problem.type, "https://api.vind.app/problems/service_unavailable");
  assert.equal(problem.title, "Service Unavailable");
  assert.equal(problem.status, 503);
  assert.equal(problem.code, "service_unavailable");
  assert.equal(problem.requestId, "req_12345678");
  assert.deepEqual(problem.dependencies, [{ name: "database", status: "down" }]);
});
