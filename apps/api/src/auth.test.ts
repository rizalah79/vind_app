import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { InMemorySessionStore, buildSessionCookieHeader } from "./auth/session.js";
import {
  validateProviderStatusTransitionAuthority,
  validateProviderManagementAuthority,
  validatePublicationTransitionAuthority,
  validateVerificationEvidenceReadAuthority
} from "./auth/authority.js";
import { runWithRequestContextV2 } from "./auth/request-context-v2.js";

describe("B2 — Authentication + Request Context V2", () => {
  it("returns 401 AUTHENTICATION_REQUIRED for unauthenticated /api/v1/me", async () => {
    const app = buildApp({
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me"
    });

    assert.equal(response.statusCode, 401);
    const body = response.json();
    assert.equal(body.code, "AUTHENTICATION_REQUIRED");
    assert.equal(body.type, "urn:vind:error:AUTHENTICATION_REQUIRED");
    assert.ok(body.request_id);
  });

  it("returns 200 OK with sanitized actor context for valid session", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.createSession({
      accountKey: "acc_123",
      personKey: "per_456",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      authAssuranceLevel: "IAL2_AAL2",
      stepUpVerified: true,
      membershipKey: "mem_789",
      organizationKey: "org_001",
      workspaceKey: "ws_002",
      providerKey: "prv_003"
    });

    const app = buildApp({
      sessionStore,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(session.sessionId)
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.data);
    assert.equal(body.data.actor_kind, "HUMAN");
    assert.equal(body.data.authority_plane, "LOCAL");
    assert.equal(body.data.account.id, "acc_123");
    assert.equal(body.data.person.id, "per_456");
    assert.equal(body.data.channel.code, "VINDZAM");
    assert.equal(body.data.organization_id, "org_001");
    assert.equal(body.data.workspace_id, "ws_002");
    assert.equal(body.data.provider_id, "prv_003");
    assert.ok(body.meta.request_id);
  });

  it("revokes session and clears cookie on logout", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.createSession({
      accountKey: "acc_123",
      personKey: "per_456",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      authAssuranceLevel: "IAL2_AAL2",
      stepUpVerified: false
    });

    const app = buildApp({
      sessionStore,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: {
        Cookie: buildSessionCookieHeader(session.sessionId)
      }
    });

    assert.equal(logoutResponse.statusCode, 200);
    const logoutBody = logoutResponse.json();
    assert.equal(logoutBody.data.success, true);
    assert.ok(logoutResponse.headers["set-cookie"]);

    // Subsequent /me request with revoked session must return 401
    const meResponse = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(session.sessionId)
      }
    });

    assert.equal(meResponse.statusCode, 401);
  });

  it("prevents channel forgery and resolves invalid x-vind-channel to canonical host channel", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.createSession({
      accountKey: "acc_123",
      personKey: "per_456",
      actorKind: "HUMAN",
      authorityPlane: "RELATIONSHIP",
      authAssuranceLevel: "IAL1",
      stepUpVerified: false
    });

    const app = buildApp({
      sessionStore,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(session.sessionId),
        "x-vind-channel": "FORGED_UNAUTHORIZED_CHANNEL"
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.channel.code, "VINDZAM");
  });

  it("enforces sensitive authority plane invariants correctly", () => {
    // 1. Provider status transition
    assert.doesNotThrow(() => {
      validateProviderStatusTransitionAuthority({
        actorKind: "HUMAN",
        authorityPlane: "LOCAL",
        accountKey: "acc1",
        personKey: "per1",
        roleCode: "OWNER"
      });
    });

    assert.throws(() => {
      validateProviderStatusTransitionAuthority({
        actorKind: "HUMAN",
        authorityPlane: "LOCAL",
        accountKey: "acc1",
        personKey: "per1",
        roleCode: "MEMBER"
      });
    }, (err: any) => err.code === "CAPABILITY_DENIED");

    // 2. Provider management authority
    assert.throws(() => {
      validateProviderManagementAuthority({
        actorKind: "HUMAN",
        authorityPlane: "PLATFORM",
        accountKey: "acc1",
        personKey: "per1",
        roleCode: "OPERATIONS_ADMIN"
      });
    }, (err: any) => err.code === "CAPABILITY_DENIED");

    // 3. Publication transition authority
    assert.throws(() => {
      validatePublicationTransitionAuthority({
        actorKind: "HUMAN",
        authorityPlane: "PLATFORM",
        accountKey: "acc1",
        personKey: "per1",
        roleCode: "MODERATOR"
      });
    }, (err: any) => err.code === "CAPABILITY_DENIED");

    // 4. Verification evidence read authority - LOCAL OWNER/ADMIN strictly denied (OBJECT_ACCESS_DENIED)
    assert.throws(() => {
      validateVerificationEvidenceReadAuthority({
        actorKind: "HUMAN",
        authorityPlane: "LOCAL",
        accountKey: "acc1",
        personKey: "per1",
        roleCode: "OWNER"
      });
    }, (err: any) => err.code === "OBJECT_ACCESS_DENIED");

    assert.doesNotThrow(() => {
      validateVerificationEvidenceReadAuthority({
        actorKind: "HUMAN",
        authorityPlane: "PLATFORM",
        accountKey: "acc1",
        personKey: "per1",
        roleCode: "MODERATOR"
      });
    });
  });

  it("runWithRequestContextV2 cleans up transaction-local context", async () => {
    const executedQueries: string[] = [];

    const mockDb: any = {
      $transaction: async (fn: any) => {
        const mockTx: any = {
          $queryRawUnsafe: async (sql: string) => {
            executedQueries.push(sql);
            return [];
          }
        };
        return await fn(mockTx);
      }
    };

    const result = await runWithRequestContextV2(
      mockDb,
      {
        actorAccountKey: "acc_test",
        actorPersonKey: "per_test",
        actorKind: "HUMAN",
        authorityPlane: "LOCAL",
        requestId: "req_test_123"
      },
      async (_tx) => {
        return "WORK_DONE";
      }
    );

    assert.equal(result, "WORK_DONE");
    const q0 = executedQueries[0];
    const q1 = executedQueries[1];
    const q2 = executedQueries[2];
    assert.ok(q0 && q0.includes("security.clear_request_context()"));
    assert.ok(q1 && q1.includes("security.set_request_context_v2"));
    assert.ok(q2 && q2.includes("security.clear_request_context()"));
  });
});
