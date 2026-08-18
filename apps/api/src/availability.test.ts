import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import type { SessionStore, ResolvedSessionContext } from "./auth/session.js";
import type { DatabaseClient } from "@vind/database";

class TestInMemorySessionStore implements SessionStore {
  private sessions = new Map<string, ResolvedSessionContext>();

  addSession(rawToken: string, session: ResolvedSessionContext): void {
    this.sessions.set(rawToken, session);
  }

  async resolveSession(rawToken: string): Promise<ResolvedSessionContext | null> {
    const session = this.sessions.get(rawToken);
    if (!session) return null;
    if (session.absoluteExpiresAt.getTime() <= Date.now()) return null;
    return session;
  }

  async revokeSession(rawToken: string, _reasonCode?: string): Promise<boolean> {
    const existed = this.sessions.has(rawToken);
    this.sessions.delete(rawToken);
    return existed;
  }
}

describe("Stage 1 Block 1A — Availability Core API Suite", () => {
  const channelHostConfig = {
    vindzamAllowedHosts: ["vindzam.test", "localhost"],
    vindlokaAllowedHosts: ["vindloka.test"]
  };

  const sampleResourceId = "11111111-1111-4000-a000-111111111111";
  const sampleCalendarId = "22222222-2222-4000-a000-222222222222";
  const sampleRuleId = "33333333-3333-4000-a000-333333333333";
  const sampleBlockId = "44444444-4444-4000-a000-444444444444";

  const validSessionToken = "valid_session_token_123";
  const sessionStore = new TestInMemorySessionStore();

  sessionStore.addSession(validSessionToken, {
    accountKey: "acc_owner_alpha",
    personKey: "person_owner_alpha",
    actorKind: "HUMAN",
    authorityPlane: "LOCAL",
    membershipKey: "mem_alpha",
    localAssignmentKey: "assignment_alpha",
    platformAssignmentKey: null,
    serviceGrantKey: null,
    organizationKey: "org_alpha",
    workspaceKey: "ws_alpha",
    providerKey: "prov_alpha",
    regionKey: null,
    absoluteExpiresAt: new Date(Date.now() + 3600 * 1000)
  });

  const mockDbClient = {
    $executeRawUnsafe: async () => {},
    $executeRaw: async () => {},
    $queryRaw: async (query: any, ...values: any[]) => {
      const sqlString = typeof query === "string" ? query : String((query as any).strings || query);

      if (sqlString.includes("read_public_availability")) {
        const resId = values[0] || sampleResourceId;
        if (resId === "00000000-0000-4000-a000-000000000000") {
          return [];
        }
        return [
          {
            resource_id: resId,
            is_available: true,
            status: "AVAILABLE",
            mode: "CALENDAR",
            resource_timezone: "Asia/Jakarta",
            slots: [
              {
                starts_at: "2026-08-19T09:00:00.000Z",
                ends_at: "2026-08-19T10:00:00.000Z",
                is_available: true
              }
            ]
          }
        ];
      }

      if (sqlString.includes("configure_resource_calendar")) {
        return [
          {
            id: sampleCalendarId,
            resource_id: values[0] || sampleResourceId,
            timezone: values[1] || "Asia/Jakarta",
            default_status: values[2] || "AVAILABLE",
            slot_duration_minutes: values[3] !== undefined ? values[3] : 60,
            min_advance_notice_hours: values[4] || 0,
            max_advance_notice_days: values[5] || 365,
            buffer_minutes: values[6] || 0,
            created_at: new Date("2026-08-18T12:00:00Z"),
            updated_at: new Date("2026-08-18T12:00:00Z")
          }
        ];
      }

      if (sqlString.includes("create_calendar_rule")) {
        return [
          {
            id: sampleRuleId,
            calendar_id: values[0] || sampleCalendarId,
            rule_pattern: values[1] || "AVAILABLE",
            day_of_week: values[2] || 1,
            start_time: values[3] || "09:00",
            end_time: values[4] || "17:00",
            effective_from: values[5] || null,
            effective_to: values[6] || null,
            created_at: new Date("2026-08-18T12:00:00Z")
          }
        ];
      }

      if (sqlString.includes("create_calendar_block")) {
        return [
          {
            id: sampleBlockId,
            calendar_id: values[0] || sampleCalendarId,
            block_status: values[3] || "UNAVAILABLE",
            starts_at: values[1] || "2026-08-19T10:00:00Z",
            ends_at: values[2] || "2026-08-19T12:00:00Z",
            title: values[4] || null,
            private_notes: values[5] || null,
            created_at: new Date("2026-08-18T12:00:00Z")
          }
        ];
      }

      if (sqlString.includes("release_calendar_block")) {
        return [
          {
            id: values[0] || sampleBlockId,
            released: true
          }
        ];
      }

      return [];
    },
    $transaction: async (cb: any) => cb(mockDbClient)
  } as unknown as DatabaseClient;

  const app = buildApp({
    channelHostConfig,
    sessionStore,
    domainDbClient: mockDbClient
  });

  describe("GET /api/v1/public/resources/:resourceId/availability", () => {
    it("fails with 400 when start_time or end_time query parameters are missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/public/resources/${sampleResourceId}/availability`
      });

      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.equal(body.code, "VALIDATION_FAILED");
    });

    it("fails with 400 when start_time >= end_time", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/public/resources/${sampleResourceId}/availability?start_time=2026-08-19T12:00:00Z&end_time=2026-08-19T10:00:00Z`
      });

      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.equal(body.code, "VALIDATION_FAILED");
    });

    it("fails with 404 when resource availability not found", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/public/resources/00000000-0000-4000-a000-000000000000/availability?start_time=2026-08-19T00:00:00Z&end_time=2026-08-20T00:00:00Z`
      });

      assert.equal(res.statusCode, 404);
      const body = res.json();
      assert.equal(body.code, "RESOURCE_NOT_FOUND");
    });

    it("returns 200 with resource timezone and slots for published resource", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/public/resources/${sampleResourceId}/availability?start_time=2026-08-19T00:00:00Z&end_time=2026-08-20T00:00:00Z`
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.resource_id, sampleResourceId);
      assert.equal(body.data.is_available, true);
      assert.equal(body.data.resource_timezone, "Asia/Jakarta");
      assert.ok(Array.isArray(body.data.slots));
      assert.equal(body.data.slots.length, 1);
      assert.equal(body.data.slots[0].is_available, true);

      // Verify zero leakage of private block notes or titles
      assert.equal("title" in body.data.slots[0], false);
      assert.equal("private_notes" in body.data.slots[0], false);
      assert.equal("customer_id" in body.data.slots[0], false);
    });
  });

  describe("PUT /api/v1/sahabat/resources/:resourceId/calendar", () => {
    it("fails with 401 when unauthenticated", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/sahabat/resources/${sampleResourceId}/calendar`,
        payload: { timezone: "Asia/Jakarta" }
      });

      assert.equal(res.statusCode, 401);
    });

    it("configures resource calendar successfully for authenticated actor", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/sahabat/resources/${sampleResourceId}/calendar`,
        headers: {
          cookie: `vind_session=${validSessionToken}`
        },
        payload: {
          timezone: "Asia/Jakarta",
          default_status: "AVAILABLE",
          slot_duration_minutes: 30
        }
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.resource_id, sampleResourceId);
      assert.equal(body.data.timezone, "Asia/Jakarta");
      assert.equal(body.data.slot_duration_minutes, 30);
    });
  });

  describe("POST /api/v1/sahabat/calendars/:calendarId/rules", () => {
    it("creates recurring calendar rule successfully", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/sahabat/calendars/${sampleCalendarId}/rules`,
        headers: {
          cookie: `vind_session=${validSessionToken}`
        },
        payload: {
          rule_pattern: "AVAILABLE",
          day_of_week: 1,
          start_time: "09:00",
          end_time: "17:00"
        }
      });

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.equal(body.data.calendar_id, sampleCalendarId);
      assert.equal(body.data.rule_pattern, "AVAILABLE");
      assert.equal(body.data.day_of_week, 1);
    });
  });

  describe("POST /api/v1/sahabat/calendars/:calendarId/blocks", () => {
    it("creates calendar block override successfully", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/sahabat/calendars/${sampleCalendarId}/blocks`,
        headers: {
          cookie: `vind_session=${validSessionToken}`
        },
        payload: {
          starts_at: "2026-08-19T10:00:00Z",
          ends_at: "2026-08-19T12:00:00Z",
          block_status: "UNAVAILABLE",
          title: "Internal Maintenance",
          private_notes: "Private note for team"
        }
      });

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.equal(body.data.calendar_id, sampleCalendarId);
      assert.equal(body.data.block_status, "UNAVAILABLE");
    });
  });

  describe("DELETE /api/v1/sahabat/blocks/:blockId", () => {
    it("releases calendar block successfully", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/sahabat/blocks/${sampleBlockId}`,
        headers: {
          cookie: `vind_session=${validSessionToken}`
        }
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.id, sampleBlockId);
      assert.equal(body.data.released, true);
    });
  });
});
