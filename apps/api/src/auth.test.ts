import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPrismaClient } from "@vind/database";
import { buildApp } from "./app.js";
import { InMemorySessionStore, buildSessionCookieHeader } from "./auth/session.js";
import {
  validateProviderStatusTransitionAuthority,
  validateProviderManagementAuthority,
  validatePublicationTransitionAuthority,
  validateVerificationEvidenceReadAuthority
} from "./auth/authority.js";
import { runWithRequestContextV2 } from "./auth/request-context-v2.js";

describe("B2 — Authentication + Request Context V2 (Remediated)", () => {
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
  });

  it("rejects Bearer token header for session authentication (cookie-only transport)", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.createSession({
      accountKey: "s1:test:account:alpha",
      personKey: "s1:test:person:alpha",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      authAssuranceLevel: "IAL2_AAL2",
      stepUpVerified: true
    });

    const app = buildApp({
      sessionStore,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Authorization: `Bearer ${session.sessionId}`
      }
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "AUTHENTICATION_REQUIRED");
  });

  it("returns 200 OK with canonical non-fabricated identity for valid session cookie (HUMAN)", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.createSession({
      accountKey: "s1:test:account:alpha",
      personKey: "s1:test:person:alpha",
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
        Cookie: buildSessionCookieHeader(session.sessionId),
        Host: "vindzam.app"
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.data);
    assert.equal(body.data.actor_kind, "HUMAN");
    assert.equal(body.data.authority_plane, "LOCAL");
    assert.equal(body.data.account_id, "s1:test:account:alpha");
    assert.equal(body.data.person_id, "s1:test:person:alpha");
    assert.equal(body.data.channel.code, "VINDZAM");
    assert.equal(body.data.organization_id, "org_001");
    assert.equal(body.data.workspace_id, "ws_002");
    assert.equal(body.data.provider_id, "prv_003");
    // Ensure no fabricated identity fields are emitted
    assert.equal(body.data.seed_key, undefined);
    assert.equal(body.data.account_type, undefined);
    assert.equal(body.data.status, undefined);
  });

  it("supports SERVICE actor model with optional person_id omitted", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.createSession({
      accountKey: "s1:test:account:service_bot",
      personKey: null,
      actorKind: "SERVICE",
      authorityPlane: "SERVICE",
      authAssuranceLevel: "STRONG",
      stepUpVerified: false,
      serviceGrantKey: "grant_123"
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
    assert.equal(body.data.actor_kind, "SERVICE");
    assert.equal(body.data.authority_plane, "SERVICE");
    assert.equal(body.data.account_id, "s1:test:account:service_bot");
    assert.equal(body.data.person_id, undefined);
  });

  it("requires valid session cookie for /api/v1/session/logout", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp({
      sessionStore,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    const unauthenticatedLogout = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout"
    });

    assert.equal(unauthenticatedLogout.statusCode, 401);

    const session = await sessionStore.createSession({
      accountKey: "acc_logout",
      personKey: "per_logout",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      authAssuranceLevel: "IAL2",
      stepUpVerified: false
    });

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: {
        Cookie: buildSessionCookieHeader(session.sessionId)
      }
    });

    assert.equal(logoutResponse.statusCode, 200);
    assert.equal(logoutResponse.json().data.success, true);
    assert.ok(logoutResponse.headers["set-cookie"]);

    // Subsequent /me returns 401
    const meResponse = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(session.sessionId)
      }
    });
    assert.equal(meResponse.statusCode, 401);
  });

  it("enforces host-based channel authority and rejects forged client presentation hints", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.createSession({
      accountKey: "acc_chan",
      personKey: "per_chan",
      actorKind: "HUMAN",
      authorityPlane: "RELATIONSHIP",
      authAssuranceLevel: "IAL1",
      stepUpVerified: false
    });

    const app = buildApp({
      sessionStore,
      readinessDependencies: [{ name: "mock", check: async () => {} }]
    });

    // 1. Host maps to VINDZAM + header hints VINDLOKA => rejected with 400 VALIDATION_FAILED
    const responseForged = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(session.sessionId),
        Host: "vindzam.app",
        "x-vind-channel": "VINDLOKA"
      }
    });

    assert.equal(responseForged.statusCode, 400);
    assert.equal(responseForged.json().code, "VALIDATION_FAILED");

    // 2. Host maps to VINDLOKA => resolved to VINDLOKA
    const responseLoka = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        Cookie: buildSessionCookieHeader(session.sessionId),
        Host: "ops.vindloka.com"
      }
    });

    assert.equal(responseLoka.statusCode, 200);
    assert.equal(responseLoka.json().data.channel.code, "VINDLOKA");
  });

  it("PHYSICAL POOL TEST: verifies no context leakage across reused physical DB connection", async () => {
    const defaultDatabaseUrl = "postgresql://vind_app_runtime:874a86afb6a871c9a905637599d7fb41755c76657f39740b75f28077ad4d5d33@127.0.0.1:5432/vind_app_dev";
    const dbUrl = process.env.DATABASE_URL || defaultDatabaseUrl;
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

      // Request C testing transaction rollback cleanup
      try {
        await runWithRequestContextV2(
          db,
          {
            actorAccountKey: "s1:test:account:err",
            actorPersonKey: "s1:test:person:err",
            actorKind: "HUMAN",
            authorityPlane: "LOCAL",
            organizationKey: "org_err"
          },
          async (tx) => {
            await tx.$queryRawUnsafe(`SELECT 1 / 0`);
          }
        );
      } catch {
        // Expected division by zero error
      }

      // Verify connection context after error rollback is completely clean
      await db.$transaction(async (tx) => {
        const checkRes = await tx.$queryRawUnsafe<Array<{ context_value: string | null }>>(
          `SELECT security.context_value('actor_account_key') AS context_value`
        );
        assert.ok(!checkRes[0]?.context_value);
      });
    } finally {
      await db.$disconnect();
    }
  });

  it("canonical DB authorization denies verification evidence read for local authority plane", async () => {
    const defaultDatabaseUrl = "postgresql://vind_app_runtime:874a86afb6a871c9a905637599d7fb41755c76657f39740b75f28077ad4d5d33@127.0.0.1:5432/vind_app_dev";
    const dbUrl = process.env.DATABASE_URL || defaultDatabaseUrl;
    const db = createPrismaClient(dbUrl);

    try {
      await runWithRequestContextV2(
        db,
        {
          actorAccountKey: "s1:test:account:alpha",
          actorPersonKey: "s1:test:person:alpha",
          actorKind: "HUMAN",
          authorityPlane: "LOCAL",
          organizationKey: "org_alpha"
        },
        async (tx) => {
          await assert.rejects(
            async () => {
              await validateVerificationEvidenceReadAuthority(tx, "LOCAL", "prov_alpha");
            },
            (err: any) => err.code === "OBJECT_ACCESS_DENIED"
          );
        }
      );
    } finally {
      await db.$disconnect();
    }
  });
});
