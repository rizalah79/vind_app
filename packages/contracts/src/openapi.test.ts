import assert from "node:assert/strict";
import test from "node:test";
import { openApiDocument } from "./openapi.js";

test("exports an OpenAPI 3.1 foundation document", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.ok(openApiDocument.paths["/api/v1/public/resources/{resourceId}/availability"]);
  assert.ok(openApiDocument.paths["/api/v1/sahabat/resources/{resourceId}/calendar"]);
  assert.ok(openApiDocument.paths["/api/v1/sahabat/calendars/{calendarId}/rules"]);
  assert.ok(openApiDocument.paths["/api/v1/sahabat/calendars/{calendarId}/blocks"]);
  assert.ok(openApiDocument.paths["/api/v1/sahabat/blocks/{blockId}"]);
  assert.ok(openApiDocument.components.schemas.PublicAvailabilityEnvelope);
  assert.ok(openApiDocument.components.schemas.ResourceCalendarEnvelope);
  assert.ok(openApiDocument.components.schemas.CalendarRuleEnvelope);
  assert.ok(openApiDocument.components.schemas.CalendarBlockEnvelope);
  assert.ok(openApiDocument.components.schemas.CalendarBlockReleasedEnvelope);
  assert.ok(openApiDocument.paths["/api/v1/health/ready"]);
  assert.ok(openApiDocument.paths["/api/v1/openapi.json"]);
  assert.ok(openApiDocument.components.schemas.ProblemDetails);
  assert.ok(openApiDocument.components.schemas.LiveHealthEnvelope);
  assert.ok(openApiDocument.components.schemas.ReadyHealthEnvelope);
  assert.equal("DependencyReadiness" in openApiDocument.components.schemas, false);
});
