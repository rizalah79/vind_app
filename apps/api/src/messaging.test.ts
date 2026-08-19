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

describe("Stage 1 Block 1C — Messaging Core API Suite", () => {
  const channelHostConfig = {
    vindzamAllowedHosts: ["vindzam.test", "localhost"],
    vindlokaAllowedHosts: ["vindloka.test"]
  };

  const sampleInquiryId = "22222222-2222-4000-a000-222222222222";
  const sampleMessageId = "55555555-5555-4000-a000-555555555555";
  const sampleMediaAssetId = "66666666-6666-4000-a000-666666666666";

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
    providerKey: "44444444-4444-4000-a000-444444444444",
    regionKey: null,
    absoluteExpiresAt: new Date(Date.now() + 3600 * 1000)
  });

  function handleMockQuery(query: any): any[] {
    const sqlString = typeof query === "string" ? query : String((query as any).strings || query);

    if (sqlString.includes("messaging.list_consumer_messages") || sqlString.includes("messaging.list_sahabat_messages")) {
      return [
        {
          result: [
            {
              id: sampleMessageId,
              conversation_id: "77777777-7777-4000-a000-777777777777",
              sender_participant_type: "CONSUMER",
              body: "Hello mock message",
              message_type: "TEXT",
              status: "SENT",
              sequence_number: 1,
              created_at: "2026-08-19T10:00:00.000Z",
              attachments: []
            }
          ]
        }
      ];
    }

    if (sqlString.includes("messaging.send_consumer_message") || sqlString.includes("messaging.send_sahabat_message")) {
      return [
        {
          result: {
            id: sampleMessageId,
            conversation_id: "77777777-7777-4000-a000-777777777777",
            inquiry_id: sampleInquiryId,
            sender_participant_type: "CONSUMER",
            body: "Sent mock message",
            message_type: "TEXT",
            status: "SENT",
            sequence_number: 1,
            created_at: "2026-08-19T10:00:00.000Z",
            attachments: []
          }
        }
      ];
    }

    if (sqlString.includes("messaging.mark_read")) {
      return [
        {
          result: {
            conversation_id: "77777777-7777-4000-a000-777777777777",
            inquiry_id: sampleInquiryId,
            last_read_message_id: sampleMessageId,
            read_at: "2026-08-19T10:00:00.000Z"
          }
        }
      ];
    }

    return [{ result: null }];
  }

  const mockDbClient: any = {
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      const mockTx = {
        $executeRawUnsafe: async () => 1,
        $queryRawUnsafe: async (sql: string, ..._args: any[]) => handleMockQuery(sql)
      };
      return fn(mockTx);
    }
  };

  const app = buildApp({
    sessionStore,
    channelHostConfig,
    domainDbClient: mockDbClient
  });

  it("GET /api/v1/inquiries/:inquiryId/messages without session returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/inquiries/${sampleInquiryId}/messages`,
      headers: { host: "vindzam.test" }
    });

    assert.strictEqual(res.statusCode, 401);
  });

  it("GET /api/v1/inquiries/:inquiryId/messages with valid session returns message list", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/inquiries/${sampleInquiryId}/messages`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${validConsumerToken}`
      }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.data));
    assert.strictEqual(body.data[0].id, sampleMessageId);
  });

  it("POST /api/v1/inquiries/:inquiryId/messages with empty body returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/inquiries/${sampleInquiryId}/messages`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${validConsumerToken}`
      },
      payload: {
        body: "   "
      }
    });

    assert.strictEqual(res.statusCode, 400);
  });

  it("POST /api/v1/inquiries/:inquiryId/messages with valid body returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/inquiries/${sampleInquiryId}/messages`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${validConsumerToken}`,
        "idempotency-key": "idemp_test_123"
      },
      payload: {
        body: "Hello from consumer",
        attachment_media_asset_ids: [sampleMediaAssetId]
      }
    });

    assert.strictEqual(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.data.id, sampleMessageId);
  });

  it("POST /api/v1/inquiries/:inquiryId/messages/read returns 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/inquiries/${sampleInquiryId}/messages/read`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${validConsumerToken}`
      },
      payload: {
        last_read_message_id: sampleMessageId
      }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.data.last_read_message_id, sampleMessageId);
  });

  it("GET /api/v1/sahabat/inquiries/:inquiryId/messages returns 200 for Sahabat", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sahabat/inquiries/${sampleInquiryId}/messages`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${validSahabatToken}`
      }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.data));
  });

  it("POST /api/v1/sahabat/inquiries/:inquiryId/messages returns 201 for Sahabat", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${sampleInquiryId}/messages`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${validSahabatToken}`,
        "idempotency-key": "idemp_sahabat_123"
      },
      payload: {
        body: "Hello from Sahabat"
      }
    });

    assert.strictEqual(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.data.id, sampleMessageId);
  });

  it("POST /api/v1/sahabat/inquiries/:inquiryId/messages/read returns 200 for Sahabat", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${sampleInquiryId}/messages/read`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${validSahabatToken}`
      },
      payload: {
        last_read_message_id: sampleMessageId
      }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.data.last_read_message_id, sampleMessageId);
  });
});
