import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import type { SessionStore, ResolvedSessionContext } from "./auth/session.js";

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

describe("Stage 1 Block 1B — Inquiry Core API Suite", () => {
  const channelHostConfig = {
    vindzamAllowedHosts: ["vindzam.test", "localhost"],
    vindlokaAllowedHosts: ["vindloka.test"]
  };

  const sampleTargetId = "11111111-1111-4000-a000-111111111111";
  const sampleInquiryId = "22222222-2222-4000-a000-222222222222";
  const samplePersonId = "33333333-3333-4000-a000-333333333333";
  const sampleProviderId = "44444444-4444-4000-a000-444444444444";

  const validConsumerToken = "valid_consumer_token_123";
  const validSahabatToken = "valid_sahabat_token_456";

  const sessionStore = new TestInMemorySessionStore();

  sessionStore.addSession(validConsumerToken, {
    accountKey: "acc_consumer_1",
    personKey: "person_consumer_1",
    actorKind: "HUMAN",
    authorityPlane: "RELATIONSHIP",
    membershipKey: null,
    localAssignmentKey: null,
    platformAssignmentKey: null,
    serviceGrantKey: null,
    organizationKey: null,
    workspaceKey: null,
    providerKey: null,
    regionKey: null,
    absoluteExpiresAt: new Date(Date.now() + 3600 * 1000)
  });

  sessionStore.addSession(validSahabatToken, {
    accountKey: "acc_sahabat_1",
    personKey: "person_sahabat_1",
    actorKind: "HUMAN",
    authorityPlane: "LOCAL",
    membershipKey: "mem_sahabat_1",
    localAssignmentKey: "ass_sahabat_1",
    platformAssignmentKey: null,
    serviceGrantKey: null,
    organizationKey: "org_alpha",
    workspaceKey: "ws_alpha",
    providerKey: sampleProviderId,
    regionKey: null,
    absoluteExpiresAt: new Date(Date.now() + 3600 * 1000)
  });  function handleMockQuery(query: any): any[] {
    const sqlString = typeof query === "string" ? query : String((query as any).strings || query);

    if (sqlString.includes("engagement.submit_inquiry")) {
      return [
        {
          result: {
            id: sampleInquiryId,
            public_reference: "INQ-20260818-ABC12345",
            requester_person_id: samplePersonId,
            target_provider_profile_id: sampleProviderId,
            source_channel: "VINDZAM",
            status: "NEW",
            created_at: "2026-08-18T10:00:00.000Z"
          }
        }
      ];
    }

    if (sqlString.includes("engagement.read_consumer_inquiry")) {
      return [
        {
          result: {
            id: sampleInquiryId,
            public_reference: "INQ-20260818-ABC12345",
            source_channel: "VINDZAM",
            status: "NEW",
            target_provider_profile_id: sampleProviderId,
            created_at: "2026-08-18T10:00:00.000Z",
            requirement: {
              requested_start_at: "2026-09-01T10:00:00.000Z",
              requested_end_at: "2026-09-02T10:00:00.000Z",
              requested_location_text: "Sanur, Bali",
              quantity: 2,
              consumer_note: "Special request",
              requirement_payload: { flexibility: "HIGH" }
            }
          }
        }
      ];
    }

    if (sqlString.includes("engagement.list_consumer_inquiries")) {
      return [
        {
          result: {
            items: [
              {
                id: sampleInquiryId,
                public_reference: "INQ-20260818-ABC12345",
                source_channel: "VINDZAM",
                status: "NEW"
              }
            ],
            limit: 20,
            offset: 0
          }
        }
      ];
    }

    if (sqlString.includes("engagement.cancel_inquiry")) {
      return [
        {
          result: {
            id: sampleInquiryId,
            status: "CANCELLED",
            cancelled_at: "2026-08-18T11:00:00.000Z"
          }
        }
      ];
    }

    if (sqlString.includes("engagement.read_sahabat_inquiry")) {
      return [
        {
          result: {
            id: sampleInquiryId,
            public_reference: "INQ-20260818-ABC12345",
            source_channel: "VINDZAM",
            status: "ACTIVE",
            target_provider_profile_id: sampleProviderId,
            created_at: "2026-08-18T10:00:00.000Z"
          }
        }
      ];
    }

    if (sqlString.includes("engagement.list_sahabat_inquiries")) {
      return [
        {
          result: {
            items: [
              {
                id: sampleInquiryId,
                public_reference: "INQ-20260818-ABC12345",
                source_channel: "VINDZAM",
                status: "ACTIVE"
              }
            ],
            limit: 20,
            offset: 0
          }
        }
      ];
    }

    if (sqlString.includes("engagement.activate_inquiry")) {
      return [
        {
          result: {
            id: sampleInquiryId,
            status: "ACTIVE",
            activated_at: "2026-08-18T10:30:00.000Z"
          }
        }
      ];
    }

    if (sqlString.includes("engagement.assign_inquiry")) {
      return [
        {
          result: {
            id: "55555555-5555-4000-a000-555555555555",
            inquiry_id: sampleInquiryId,
            assigned_person_id: samplePersonId,
            status: "ACTIVE",
            assigned_at: "2026-08-18T10:35:00.000Z"
          }
        }
      ];
    }

    if (sqlString.includes("engagement.close_inquiry")) {
      return [
        {
          result: {
            id: sampleInquiryId,
            status: "CLOSED",
            closed_at: "2026-08-18T12:00:00.000Z"
          }
        }
      ];
    }

    return [];
  }

  const mockDbClient = {
    $executeRawUnsafe: async () => {},
    $executeRaw: async () => {},
    $queryRaw: async (query: any, ..._values: any[]) => handleMockQuery(query),
    $queryRawUnsafe: async (query: any, ..._values: any[]) => handleMockQuery(query),
    $transaction: async (cb: any) => cb(mockDbClient)
  } as unknown as DatabaseClient;

  const app = buildApp({
    sessionStore,
    channelHostConfig,
    domainDbClient: mockDbClient
  });

  it("1. POST /api/v1/inquiries requires session authentication (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      payload: { target_id: sampleTargetId }
    });
    assert.strictEqual(res.statusCode, 401);
  });

  it("2. POST /api/v1/inquiries submits inquiry successfully (201)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: {
        cookie: `vind_session=${validConsumerToken}`,
        "idempotency-key": "idemp_test_123"
      },
      payload: {
        target_id: sampleTargetId,
        consent_receipt_id: "66666666-6666-4000-a000-666666666666",
        requested_start_at: "2026-09-01T10:00:00Z",
        requested_end_at: "2026-09-02T10:00:00Z",
        location_text: "Sanur, Bali",
        quantity: 2,
        consumer_note: "Special request"
      }
    });
    assert.strictEqual(res.statusCode, 201);
    const json = res.json();
    assert.strictEqual(json.data.id, sampleInquiryId);
    assert.strictEqual(json.data.status, "NEW");
    assert.strictEqual(json.data.source_channel, "VINDZAM");
  });

  it("2a. POST /api/v1/inquiries missing consent_receipt_id returns 400 VALIDATION_FAILED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: {
        cookie: `vind_session=${validConsumerToken}`
      },
      payload: {
        target_id: sampleTargetId,
        requested_start_at: "2026-09-01T10:00:00Z"
      }
    });
    assert.strictEqual(res.statusCode, 400);
    const json = res.json();
    assert.strictEqual(json.code, "VALIDATION_FAILED");
  });

  it("2b. POST /api/v1/inquiries channel body spoofing returns 400 VALIDATION_FAILED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: {
        cookie: `vind_session=${validConsumerToken}`,
        host: "vindzam.test"
      },
      payload: {
        target_id: sampleTargetId,
        channel_code: "VINDLOKA",
        consent_receipt_id: "66666666-6666-4000-a000-666666666666"
      }
    });
    assert.strictEqual(res.statusCode, 400);
    const json = res.json();
    assert.strictEqual(json.code, "VALIDATION_FAILED");
  });

  it("3. GET /api/v1/inquiries/:inquiryId reads consumer inquiry details (200)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/inquiries/${sampleInquiryId}`,
      headers: {
        cookie: `vind_session=${validConsumerToken}`
      }
    });
    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.id, sampleInquiryId);
    assert.strictEqual(json.data.requirement.consumer_note, "Special request");
  });

  it("4. GET /api/v1/inquiries lists consumer's inquiries (200)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/inquiries?limit=10&offset=0",
      headers: {
        cookie: `vind_session=${validConsumerToken}`
      }
    });
    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.items.length, 1);
    assert.strictEqual(json.data.items[0].id, sampleInquiryId);
  });

  it("5. POST /api/v1/inquiries/:inquiryId/cancel cancels inquiry (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/inquiries/${sampleInquiryId}/cancel`,
      headers: {
        cookie: `vind_session=${validConsumerToken}`
      },
      payload: { reason: "User cancelled" }
    });
    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.status, "CANCELLED");
  });

  it("6. GET /api/v1/sahabat/inquiries lists Sahabat inquiries (200)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sahabat/inquiries",
      headers: {
        cookie: `vind_session=${validSahabatToken}`
      }
    });
    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.items[0].id, sampleInquiryId);
  });

  it("7. GET /api/v1/sahabat/inquiries/:inquiryId reads Sahabat inquiry (200)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sahabat/inquiries/${sampleInquiryId}`,
      headers: {
        cookie: `vind_session=${validSahabatToken}`
      }
    });
    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.id, sampleInquiryId);
  });

  it("8. POST /api/v1/sahabat/inquiries/:inquiryId/activate activates inquiry (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${sampleInquiryId}/activate`,
      headers: {
        cookie: `vind_session=${validSahabatToken}`
      }
    });
    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.status, "ACTIVE");
  });

  it("9. POST /api/v1/sahabat/inquiries/:inquiryId/assign assigns inquiry (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${sampleInquiryId}/assign`,
      headers: {
        cookie: `vind_session=${validSahabatToken}`
      },
      payload: {
        assigned_person_id: samplePersonId,
        reason: "Primary support assigned"
      }
    });
    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.status, "ACTIVE");
    assert.strictEqual(json.data.assigned_person_id, samplePersonId);
  });

  it("10. POST /api/v1/sahabat/inquiries/:inquiryId/close closes inquiry (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${sampleInquiryId}/close`,
      headers: {
        cookie: `vind_session=${validSahabatToken}`
      },
      payload: { reason: "Fulfilled" }
    });
    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.status, "CLOSED");
  });
});
