import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPrismaClient } from "@vind/database";
import { buildApp } from "./app.js";
import { buildProductionApp } from "./server.js";
import { buildSessionCookieHeader, type ResolvedSessionContext, type SessionStore } from "./auth/session.js";
import { PostgresSessionStore, type DatabaseClient } from "./auth/postgres-session-store.js";
import { type ChannelHostConfig } from "./auth/channel.js";
import {
  validateProviderStatusTransitionAuthority,
  validateProviderManagementAuthority,
  validatePublicationTransitionAuthority,
  validateVerificationEvidenceReadAuthority
} from "./auth/authority.js";
import { runWithRequestContextV2 } from "./auth/request-context-v2.js";

const testChannelHostConfig: ChannelHostConfig = {
  vindzamAllowedHosts: ["vindzam.test"],
  vindlokaAllowedHosts: ["vindloka.test"]
};

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

describe("B2 — Authentication + Request Context V2 (Remediated)", () => {
  it("returns 401 AUTHENTICATION_REQUIRED for unauthenticated /api/v1/me", async () => {
    const sessionStore = new TestInMemorySessionStore();
    const app = buildApp({
      sessionStore,
      channelHostConfig: testChannelHostConfig,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Host: "vindzam.test"
      }
    });

    assert.equal(response.statusCode, 401);
    const body = response.json();
    assert.equal(body.code, "AUTHENTICATION_REQUIRED");
    assert.equal(body.type, "urn:vind:error:AUTHENTICATION_REQUIRED");
  });

  it("rejects Bearer token header for session authentication (cookie-only transport)", async () => {
    const sessionStore = new TestInMemorySessionStore();
    const token = "test_raw_token_123";
    sessionStore.addSession(token, {
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      accountKey: "s1:test:account:alpha",
      personKey: "s1:test:person:alpha",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      authAssuranceLevel: "IAL2_AAL2",
      stepUpVerified: true,
      absoluteExpiresAt: new Date(Date.now() + 3600000)
    });

    const app = buildApp({
      sessionStore,
      channelHostConfig: testChannelHostConfig,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Authorization: `Bearer ${token}`,
        Host: "vindzam.test"
      }
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "AUTHENTICATION_REQUIRED");
  });

  it("returns 200 OK with canonical *_key identity for valid session cookie (HUMAN)", async () => {
    const sessionStore = new TestInMemorySessionStore();
    const token = "test_raw_human_token";
    sessionStore.addSession(token, {
      sessionId: "550e8400-e29b-41d4-a716-446655440001",
      accountKey: "s1:test:account:alpha",
      personKey: "s1:test:person:alpha",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      authAssuranceLevel: "IAL2_AAL2",
      stepUpVerified: true,
      membershipKey: "mem_789",
      organizationKey: "org_001",
      workspaceKey: "ws_002",
      providerKey: "prv_003",
      absoluteExpiresAt: new Date(Date.now() + 3600000)
    });

    const app = buildApp({
      sessionStore,
      channelHostConfig: testChannelHostConfig,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(token),
        Host: "vindzam.test"
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.data);
    assert.equal(body.data.actor_kind, "HUMAN");
    assert.equal(body.data.authority_plane, "LOCAL");
    assert.equal(body.data.account_key, "s1:test:account:alpha");
    assert.equal(body.data.person_key, "s1:test:person:alpha");
    assert.equal(body.data.membership_key, "mem_789");
    assert.equal(body.data.organization_key, "org_001");
    assert.equal(body.data.workspace_key, "ws_002");
    assert.equal(body.data.provider_key, "prv_003");
    assert.equal(body.data.channel.code, "VINDZAM");

    // Ensure deprecated *_id and internal fields are omitted
    assert.equal(body.data.account_id, undefined);
    assert.equal(body.data.person_id, undefined);
    assert.equal(body.data.organization_id, undefined);
    assert.equal(body.data.workspace_id, undefined);
    assert.equal(body.data.provider_id, undefined);
    assert.equal(body.data.sessionId, undefined);
    assert.equal(body.data.session_id, undefined);
  });

  it("supports SERVICE actor model with optional person_key omitted", async () => {
    const sessionStore = new TestInMemorySessionStore();
    const token = "test_raw_service_token";
    sessionStore.addSession(token, {
      sessionId: "550e8400-e29b-41d4-a716-446655440002",
      accountKey: "s1:test:account:service_bot",
      personKey: null,
      actorKind: "SERVICE",
      authorityPlane: "SERVICE",
      authAssuranceLevel: "STRONG",
      stepUpVerified: false,
      serviceGrantKey: "grant_123",
      absoluteExpiresAt: new Date(Date.now() + 3600000)
    });

    const app = buildApp({
      sessionStore,
      channelHostConfig: testChannelHostConfig,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(token),
        Host: "vindloka.test"
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.actor_kind, "SERVICE");
    assert.equal(body.data.authority_plane, "SERVICE");
    assert.equal(body.data.account_key, "s1:test:account:service_bot");
    assert.equal(body.data.service_grant_key, "grant_123");
    assert.equal(body.data.person_key, undefined);
    assert.equal(body.data.channel.code, "VINDLOKA");
  });

  it("enforces idempotent logout for cookie-present requests", async () => {
    const sessionStore = new TestInMemorySessionStore();
    const app = buildApp({
      sessionStore,
      channelHostConfig: testChannelHostConfig,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    // 1. Missing cookie logout => 401
    const unauthenticatedLogout = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout"
    });
    assert.equal(unauthenticatedLogout.statusCode, 401);

    // 2. Add valid session and logout => 200 + clear cookie
    const token = "valid_logout_token";
    sessionStore.addSession(token, {
      sessionId: "550e8400-e29b-41d4-a716-446655440003",
      accountKey: "acc_logout",
      personKey: "per_logout",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      authAssuranceLevel: "IAL2",
      stepUpVerified: false,
      absoluteExpiresAt: new Date(Date.now() + 3600000)
    });

    const logoutResponse1 = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: {
        Cookie: buildSessionCookieHeader(token)
      }
    });

    assert.equal(logoutResponse1.statusCode, 200);
    assert.equal(logoutResponse1.json().data.success, true);
    assert.ok(logoutResponse1.headers["set-cookie"]);

    // 3. Repeated logout with same cookie (token now unknown/revoked) => 200 + clear cookie (idempotent!)
    const logoutResponse2 = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: {
        Cookie: buildSessionCookieHeader(token)
      }
    });

    assert.equal(logoutResponse2.statusCode, 200);
    assert.equal(logoutResponse2.json().data.success, true);
    assert.ok(logoutResponse2.headers["set-cookie"]);
  });

  it("enforces exact host allowlist matching and rejects unauthorized/lookalike hostnames", async () => {
    const sessionStore = new TestInMemorySessionStore();
    const token = "test_channel_token";
    sessionStore.addSession(token, {
      sessionId: "550e8400-e29b-41d4-a716-446655440004",
      accountKey: "acc_chan",
      personKey: "per_chan",
      actorKind: "HUMAN",
      authorityPlane: "RELATIONSHIP",
      authAssuranceLevel: "IAL1",
      stepUpVerified: false,
      absoluteExpiresAt: new Date(Date.now() + 3600000)
    });

    const app = buildApp({
      sessionStore,
      channelHostConfig: testChannelHostConfig,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    // 1. Exact VINDZAM host => 200 VINDZAM
    const resVindzam = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(token),
        Host: "vindzam.test"
      }
    });
    assert.equal(resVindzam.statusCode, 200);
    assert.equal(resVindzam.json().data.channel.code, "VINDZAM");

    // 2. Exact VINDLOKA host => 200 VINDLOKA
    const resVindloka = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(token),
        Host: "vindloka.test"
      }
    });
    assert.equal(resVindloka.statusCode, 200);
    assert.equal(resVindloka.json().data.channel.code, "VINDLOKA");

    // 3. Substring lookalike hostname (notvindzam.test) => 400 VALIDATION_FAILED
    const resLookalike = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(token),
        Host: "notvindzam.test"
      }
    });
    assert.equal(resLookalike.statusCode, 400);
    assert.equal(resLookalike.json().code, "VALIDATION_FAILED");

    // 4. Unknown host => 400 VALIDATION_FAILED
    const resUnknown = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(token),
        Host: "unknown.test"
      }
    });
    assert.equal(resUnknown.statusCode, 400);
    assert.equal(resUnknown.json().code, "VALIDATION_FAILED");

    // 5. Conflicting presentation hint => 400 VALIDATION_FAILED
    const resForged = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(token),
        Host: "vindzam.test",
        "x-vind-channel": "VINDLOKA"
      }
    });
    assert.equal(resForged.statusCode, 400);
    assert.equal(resForged.json().code, "VALIDATION_FAILED");
  });

  describe("PostgresSessionStore Unit Tests", () => {
    it("hashes raw token with SHA-256 and calls identity.resolve_auth_session with bytea Buffer", async () => {
      let capturedQuery = "";
      let capturedParams: any[] = [];

      const mockDb: DatabaseClient = {
        async query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> {
          capturedQuery = text;
          capturedParams = params || [];
          return {
            rows: [
              {
                session_id: "550e8400-e29b-41d4-a716-446655440005",
                actor_account_key: "acc_pg_test",
                actor_person_key: "per_pg_test",
                actor_kind: "HUMAN",
                authority_plane: "LOCAL",
                membership_key: "mem_pg",
                local_assignment_key: "assign_pg",
                platform_assignment_key: null,
                service_grant_key: null,
                organization_key: "org_pg",
                workspace_key: "ws_pg",
                provider_key: "prv_pg",
                channel_code: "VINDZAM",
                region_key: "reg_pg",
                auth_assurance_level: "IAL2_AAL2",
                step_up_verified: true,
                absolute_expires_at: new Date(Date.now() + 3600000)
              } as any
            ]
          };
        }
      };

      const store = new PostgresSessionStore(mockDb);
      const rawToken = "my_secret_raw_token_xyz";
      const resolved = await store.resolveSession(rawToken);

      assert.ok(resolved);
      assert.equal(resolved.accountKey, "acc_pg_test");
      assert.equal(resolved.personKey, "per_pg_test");
      assert.equal(resolved.stepUpVerified, true);
      assert.ok(capturedQuery.includes("identity.resolve_auth_session($1)"));
      assert.ok(Buffer.isBuffer(capturedParams[0]));
      assert.equal(capturedParams[0].length, 32);

      const expectedDigest = createHash("sha256").update(rawToken).digest();
      assert.deepEqual(capturedParams[0], expectedDigest);
    });

    it("returns null when resolve_auth_session returns zero rows", async () => {
      const mockDb: DatabaseClient = {
        async query<T = any>(): Promise<{ rows: T[] }> {
          return { rows: [] };
        }
      };

      const store = new PostgresSessionStore(mockDb);
      const resolved = await store.resolveSession("invalid_token");
      assert.equal(resolved, null);
    });

    it("calls identity.revoke_auth_session with bytea Buffer and reason text", async () => {
      let capturedParams: any[] = [];
      const mockDb: DatabaseClient = {
        async query<T = any>(_text: string, params?: any[]): Promise<{ rows: T[] }> {
          capturedParams = params || [];
          return { rows: [{ revoke_auth_session: true } as any] };
        }
      };

      const store = new PostgresSessionStore(mockDb);
      const res = await store.revokeSession("raw_revoke_token", "USER_LOGOUT");
      assert.equal(res, true);
      assert.ok(Buffer.isBuffer(capturedParams[0]));
      assert.equal(capturedParams[0].length, 32);
      assert.equal(capturedParams[1], "USER_LOGOUT");
    });
  });

  describe("Sensitive Capability Step-Up Enforcement Unit Tests", () => {
    it("allows sensitive operation when capability is permitted and stepUpVerified is true", async () => {
      const mockTx: any = {
        async $queryRawUnsafe() {
          return [{ has_local_capability: true }];
        }
      };

      await assert.doesNotReject(async () => {
        await validateProviderStatusTransitionAuthority(mockTx, "LOCAL", "prov_1", true);
      });
    });

    it("throws AUTH_ASSURANCE_REQUIRED when capability is permitted but stepUpVerified is false", async () => {
      const mockTx: any = {
        async $queryRawUnsafe() {
          return [{ has_local_capability: true }];
        }
      };

      await assert.rejects(
        async () => {
          await validateProviderStatusTransitionAuthority(mockTx, "LOCAL", "prov_1", false);
        },
        (err: any) => err.code === "AUTH_ASSURANCE_REQUIRED"
      );
    });

    it("throws CAPABILITY_DENIED when capability is denied even if stepUpVerified is true", async () => {
      const mockTx: any = {
        async $queryRawUnsafe() {
          return [{ has_local_capability: false }];
        }
      };

      await assert.rejects(
        async () => {
          await validateProviderStatusTransitionAuthority(mockTx, "LOCAL", "prov_1", true);
        },
        (err: any) => err.code === "CAPABILITY_DENIED"
      );
    });

    it("throws OBJECT_ACCESS_DENIED for LOCAL verification evidence read regardless of stepUpVerified", async () => {
      const mockTx: any = {};

      await assert.rejects(
        async () => {
          await validateVerificationEvidenceReadAuthority(mockTx, "LOCAL", "prov_1", true);
        },
        (err: any) => err.code === "OBJECT_ACCESS_DENIED"
      );

      await assert.rejects(
        async () => {
          await validateVerificationEvidenceReadAuthority(mockTx, "LOCAL", "prov_1", false);
        },
        (err: any) => err.code === "OBJECT_ACCESS_DENIED"
      );
    });
  });

  it("PHYSICAL POOL TEST: verifies no context leakage across reused physical DB connection", async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.log("Skipping DB-backed Request Context V2 pool test (DATABASE_URL not set).");
      return;
    }

    const db = createPrismaClient(dbUrl);

    try {
      // Request A setting full context
      await runWithRequestContextV2(
        db,
        {
          actorAccountKey: "s1:test:account:alpha",
          actorPersonKey: "s1:test:person:alpha",
          actorKind: "HUMAN",
          authorityPlane: "LOCAL",
          membershipKey: "mem_alpha",
          localAssignmentKey: "assign_alpha",
          organizationKey: "org_alpha",
          workspaceKey: "ws_alpha",
          providerKey: "prov_alpha",
          channelCode: "VINDZAM",
          regionKey: "reg_alpha",
          purposeCode: "purp_alpha",
          authAssuranceLevel: "IAL2_AAL2",
          stepUpVerified: true,
          breakGlassReference: "bg_alpha"
        },
        async (tx) => {
          const res = await tx.$queryRawUnsafe<Array<{ context_value: string }>>(
            `SELECT security.context_value('actor_account_key') AS context_value`
          );
          assert.equal(res[0]?.context_value, "s1:test:account:alpha");
        }
      );

      // Request B executed immediately after on the same DB connection pool with clean/different context
      await runWithRequestContextV2(
        db,
        {
          actorAccountKey: "s1:test:account:beta",
          actorPersonKey: "s1:test:person:beta",
          actorKind: "HUMAN",
          authorityPlane: "RELATIONSHIP",
          channelCode: "VINDLOKA",
          authAssuranceLevel: "IAL1",
          stepUpVerified: false
        },
        async (tx) => {
          const accRes = await tx.$queryRawUnsafe<Array<{ context_value: string | null }>>(
            `SELECT security.context_value('actor_account_key') AS context_value`
          );
          const orgRes = await tx.$queryRawUnsafe<Array<{ context_value: string | null }>>(
            `SELECT security.context_value('organization_key') AS context_value`
          );
          const bgRes = await tx.$queryRawUnsafe<Array<{ context_value: string | null }>>(
            `SELECT security.context_value('break_glass_reference') AS context_value`
          );
          const stepRes = await tx.$queryRawUnsafe<Array<{ context_value: string | null }>>(
            `SELECT security.context_value('step_up_verified') AS context_value`
          );

          assert.equal(accRes[0]?.context_value, "s1:test:account:beta");
          assert.ok(!orgRes[0]?.context_value);
          assert.ok(!bgRes[0]?.context_value);
          assert.equal(stepRes[0]?.context_value, "false");
        }
      );
    } finally {
      await db.$disconnect();
    }
  });

  describe("Production Server Composition Fail-Closed Tests", () => {
    it("fails startup when DATABASE_URL environment variable is missing", async () => {
      await assert.rejects(
        async () => {
          await buildProductionApp({
            env: {
              VINDZAM_ALLOWED_HOSTS: "vindzam.test",
              VINDLOKA_ALLOWED_HOSTS: "vindloka.test"
            }
          });
        },
        (err: any) =>
          err instanceof Error &&
          err.message.includes("DATABASE_URL environment variable is required")
      );
    });

    it("fails startup when VINDZAM_ALLOWED_HOSTS is missing or empty", async () => {
      const mockDb: DatabaseClient = { async query() { return { rows: [] }; } };
      await assert.rejects(
        async () => {
          await buildProductionApp({
            env: {
              DATABASE_URL: "postgresql://vind_user:pass@localhost:5432/vind_db",
              VINDLOKA_ALLOWED_HOSTS: "vindloka.test"
            },
            dbClient: mockDb
          });
        },
        (err: any) =>
          err instanceof Error &&
          err.message.includes("VINDZAM host configuration is required")
      );
    });

    it("fails startup when VINDLOKA_ALLOWED_HOSTS is missing or empty", async () => {
      const mockDb: DatabaseClient = { async query() { return { rows: [] }; } };
      await assert.rejects(
        async () => {
          await buildProductionApp({
            env: {
              DATABASE_URL: "postgresql://vind_user:pass@localhost:5432/vind_db",
              VINDZAM_ALLOWED_HOSTS: "vindzam.test"
            },
            dbClient: mockDb
          });
        },
        (err: any) =>
          err instanceof Error &&
          err.message.includes("VINDLOKA host configuration is required")
      );
    });

    it("successfully wires persistent session store and enables auth routes when configured properly", async () => {
      const mockDb: DatabaseClient = {
        async query(): Promise<{ rows: any[] }> {
          return { rows: [] };
        }
      };

      const app = await buildProductionApp({
        env: {
          DATABASE_URL: "postgresql://vind_user:pass@localhost:5432/vind_db",
          VINDZAM_ALLOWED_HOSTS: "vindzam.test",
          VINDLOKA_ALLOWED_HOSTS: "vindloka.test"
        },
        dbClient: mockDb,
        readinessDependencies: [{ name: "mock", check: async () => {} }]
      });

      // Unauthenticated request to /api/v1/me returns 401 AUTHENTICATION_REQUIRED (auth routes are active!)
      const meRes = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { Host: "vindzam.test" }
      });
      assert.equal(meRes.statusCode, 401);
      assert.equal(meRes.json().code, "AUTHENTICATION_REQUIRED");

      // Unauthenticated request to /api/v1/session/logout returns 401 AUTHENTICATION_REQUIRED
      const logoutRes = await app.inject({
        method: "POST",
        url: "/api/v1/session/logout"
      });
      assert.equal(logoutRes.statusCode, 401);
      assert.equal(logoutRes.json().code, "AUTHENTICATION_REQUIRED");
    });
  });
});
