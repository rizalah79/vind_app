import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { Client } from "pg";
import { buildApp } from "./app.js";
import { type SessionStore, type ResolvedSessionContext } from "./auth/session.js";
import { createPrismaClient, type DatabaseClient } from "@vind/database";

dotenv.config();

class TestAcceptanceSessionStore implements SessionStore {
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

  async revokeSession(rawToken: string): Promise<boolean> {
    return this.sessions.delete(rawToken);
  }
}

describe("STAGE 1 BLOCK 1B — REAL POSTGRESQL API ACCEPTANCE SUITE", { skip: !process.env.ISOLATED_PORT ? "Isolated database port ISOLATED_PORT not configured" : false }, () => {
  const channelHostConfig = {
    vindzamAllowedHosts: ["vindzam.test", "localhost"],
    vindlokaAllowedHosts: ["vindloka.test"]
  };

  const sessionStore = new TestAcceptanceSessionStore();
  let prismaClient: DatabaseClient;
  let pgOwnerClient: Client;
  let app: ReturnType<typeof buildApp>;

  let testPubId: string;
  let testProviderProfileId: string;
  let testChannelCode: string;
  let consumerPersonId: string;
  let consumerPersonSeedKey: string;
  let sahabatPersonId: string;
  let sahabatPersonSeedKey: string;
  let sahabatAssignmentSeedKey: string;
  let sahabatRoleCode: string;
  let sahabatScopeType: string;

  const consumerToken = "token_consumer_real_db_123";
  const sahabatToken = "token_sahabat_real_db_456";

  let testConsentReceiptId = "77777777-7777-4000-a000-777777777777";
  let otherConsentReceiptId = "88888888-8888-4000-a000-888888888888";
  let otherConsumerPersonId = "99999999-9999-4000-a000-999999999999";
  let otherConsumerToken = "token_other_consumer_real_db_789";

  before(async () => {
    if (!process.env.ISOLATED_PORT) {
      return;
    }

    const runtimeUrl = process.env.DATABASE_URL;
    const migrationUrl = process.env.DATABASE_MIGRATION_URL;

    prismaClient = createPrismaClient(runtimeUrl);

    pgOwnerClient = new Client({ connectionString: migrationUrl || runtimeUrl });
    await pgOwnerClient.connect();

    // Query published publication from DEC-021 seed
    const seedPubData = await pgOwnerClient.query(`
      SELECT 
        cp.id as pub_id,
        cp.provider_profile_id,
        cp.channel_code,
        p.id as consumer_person_id,
        p.seed_key as consumer_person_seed_key
      FROM listing.channel_publications cp
      CROSS JOIN party.persons p
      WHERE cp.publication_status = 'PUBLISHED'
        AND cp.channel_code = 'VINDZAM'
      LIMIT 1;
    `);

    assert.ok(seedPubData.rows.length > 0, "Seed published channel publication must exist");
    const pub = seedPubData.rows[0];
    testPubId = pub.pub_id;
    testProviderProfileId = pub.provider_profile_id;
    testChannelCode = pub.channel_code;
    consumerPersonId = pub.consumer_person_id;
    consumerPersonSeedKey = pub.consumer_person_seed_key;

    // Create active consent receipt for primary consumer
    await pgOwnerClient.query(`
      INSERT INTO privacy.consent_receipts (
        id, receipt_key, person_id, purpose_code, policy_version, consent_action, grant_effective_from
      ) VALUES (
        $1::uuid, 's1:test:consent:real_db_api_primary', $2::uuid, 'INQUIRY', 'v1.0', 'GRANTED', NOW() - interval '1 day'
      ) ON CONFLICT (receipt_key) DO UPDATE SET consent_action = 'GRANTED';
    `, [testConsentReceiptId, consumerPersonId]);

    // Create other consumer person & consent receipt
    const otherPersonRes = await pgOwnerClient.query(`
      INSERT INTO party.persons (id, seed_key, data_origin_code, is_synthetic, contactable, display_name)
      VALUES ($1::uuid, 'person:test:other_consumer', 'REFERENCE', false, true, 'Other Consumer')
      ON CONFLICT (seed_key) DO UPDATE SET display_name = 'Other Consumer'
      RETURNING id, seed_key;
    `, [otherConsumerPersonId]);
    otherConsumerPersonId = otherPersonRes.rows[0].id;

    await pgOwnerClient.query(`
      INSERT INTO privacy.consent_receipts (
        id, receipt_key, person_id, purpose_code, policy_version, consent_action, grant_effective_from
      ) VALUES (
        $1::uuid, 's1:test:consent:real_db_api_other', $2::uuid, 'INQUIRY', 'v1.0', 'GRANTED', NOW() - interval '1 day'
      ) ON CONFLICT (receipt_key) DO UPDATE SET consent_action = 'GRANTED';
    `, [otherConsentReceiptId, otherConsumerPersonId]);

    // Query active Sahabat scoped assignment for provider profile
    const sahabatAssRes = await pgOwnerClient.query(`
      SELECT sa.seed_key, sa.subject_person_id, sa.role_code, sa.scope_type, p.seed_key as person_seed_key
      FROM access.scoped_assignments sa
      JOIN party.persons p ON p.id = sa.subject_person_id
      WHERE sa.provider_id = $1 AND sa.status = 'ACTIVE'
      LIMIT 1;
    `, [testProviderProfileId]);

    assert.ok(sahabatAssRes.rows.length > 0, "Sahabat active assignment must exist in seed data");
    const sahAss = sahabatAssRes.rows[0];
    sahabatPersonId = sahAss.subject_person_id;
    sahabatPersonSeedKey = sahAss.person_seed_key;
    sahabatAssignmentSeedKey = sahAss.seed_key;
    sahabatRoleCode = sahAss.role_code;
    sahabatScopeType = sahAss.scope_type;

    // Add session tokens
    sessionStore.addSession(consumerToken, {
      accountKey: "acc_real_consumer",
      personKey: consumerPersonSeedKey,
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

    sessionStore.addSession(otherConsumerToken, {
      accountKey: "acc_real_other_consumer",
      personKey: "person:test:other_consumer",
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

    sessionStore.addSession(sahabatToken, {
      accountKey: "acc_real_sahabat",
      personKey: sahabatPersonSeedKey,
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      membershipKey: "mem_real_sahabat",
      localAssignmentKey: sahabatAssignmentSeedKey,
      platformAssignmentKey: null,
      serviceGrantKey: null,
      organizationKey: null,
      workspaceKey: null,
      providerKey: testProviderProfileId,
      regionKey: null,
      absoluteExpiresAt: new Date(Date.now() + 3600 * 1000)
    });

    app = buildApp({
      sessionStore,
      channelHostConfig,
      domainDbClient: prismaClient
    });
  });

  after(async () => {
    if (pgOwnerClient) {
      await pgOwnerClient.end();
    }
  });

  let createdInquiryId: string;

  it("1a. Consumer submit missing consent_receipt_id fails (400 VALIDATION_FAILED)", async () => {
    if (!process.env.ISOLATED_PORT) return;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: { cookie: `vind_session=${consumerToken}` },
      payload: { target_id: testPubId }
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().code, "VALIDATION_FAILED");
  });

  it("1b. Consumer submit wrong-owner consent_receipt_id fails (400 VALIDATION_FAILED)", async () => {
    if (!process.env.ISOLATED_PORT) return;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: { cookie: `vind_session=${consumerToken}` },
      payload: {
        target_id: testPubId,
        consent_receipt_id: otherConsentReceiptId
      }
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().code, "VALIDATION_FAILED");
  });

  it("1c. Consumer submit channel body spoofing fails (400 VALIDATION_FAILED)", async () => {
    if (!process.env.ISOLATED_PORT) return;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: {
        cookie: `vind_session=${consumerToken}`,
        host: "vindzam.test"
      },
      payload: {
        target_id: testPubId,
        channel_code: "VINDLOKA",
        consent_receipt_id: testConsentReceiptId
      }
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().code, "VALIDATION_FAILED");
  });

  it("1. Consumer POST /api/v1/inquiries creates inquiry with Real DB", async () => {
    if (!process.env.ISOLATED_PORT) {
      return;
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: {
        cookie: `vind_session=${consumerToken}`,
        "idempotency-key": `idemp_real_api_${Date.now()}`
      },
      payload: {
        target_id: testPubId,
        consent_receipt_id: testConsentReceiptId,
        requested_start_at: "2026-09-01T10:00:00Z",
        requested_end_at: "2026-09-02T10:00:00Z",
        location_text: "Sanur, Bali",
        quantity: 2,
        consumer_note: "Real DB API Test Inquiry",
        requirement_payload: { setup: "AFTERNOON" }
      }
    });

    if (res.statusCode !== 201) {
      console.error("Test 1 error payload:", res.payload);
    }
    assert.strictEqual(res.statusCode, 201, `Failed submit: ${res.payload}`);
    const json = res.json();
    assert.ok(json.data.id);
    assert.strictEqual(json.data.status, "NEW");
    assert.strictEqual(json.data.source_channel, testChannelCode);

    createdInquiryId = json.data.id;
  });

  it("1d. Idempotency same key same payload returns 201 with identical response", async () => {
    if (!process.env.ISOLATED_PORT) return;
    const key = `idemp_same_payload_${Date.now()}`;

    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: { cookie: `vind_session=${consumerToken}`, "idempotency-key": key },
      payload: { target_id: testPubId, consent_receipt_id: testConsentReceiptId, quantity: 5 }
    });
    assert.strictEqual(res1.statusCode, 201);
    const json1 = res1.json();

    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: { cookie: `vind_session=${consumerToken}`, "idempotency-key": key },
      payload: { target_id: testPubId, consent_receipt_id: testConsentReceiptId, quantity: 5 }
    });
    assert.strictEqual(res2.statusCode, 201);
    const json2 = res2.json();

    assert.strictEqual(json1.data.id, json2.data.id);
  });

  it("1e. Idempotency same key changed payload returns 409 STATE_CONFLICT", async () => {
    if (!process.env.ISOLATED_PORT) return;
    const key = `idemp_changed_payload_${Date.now()}`;

    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: { cookie: `vind_session=${consumerToken}`, "idempotency-key": key },
      payload: { target_id: testPubId, consent_receipt_id: testConsentReceiptId, quantity: 3 }
    });
    assert.strictEqual(res1.statusCode, 201);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/inquiries",
      headers: { cookie: `vind_session=${consumerToken}`, "idempotency-key": key },
      payload: { target_id: testPubId, consent_receipt_id: testConsentReceiptId, quantity: 99 }
    });
    assert.strictEqual(res2.statusCode, 409);
    assert.strictEqual(res2.json().code, "STATE_CONFLICT");
  });

  it("2. Consumer GET /api/v1/inquiries/:inquiryId reads details with Real DB", async () => {
    if (!process.env.ISOLATED_PORT) {
      return;
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/inquiries/${createdInquiryId}`,
      headers: {
        cookie: `vind_session=${consumerToken}`
      }
    });

    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.id, createdInquiryId);
    assert.strictEqual(json.data.requirement.consumer_note, "Real DB API Test Inquiry");
  });

  it("2a. Other consumer reading another consumer's inquiry returns 404/CAPABILITY_DENIED via RLS", async () => {
    if (!process.env.ISOLATED_PORT) return;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/inquiries/${createdInquiryId}`,
      headers: { cookie: `vind_session=${otherConsumerToken}` }
    });

    assert.ok(res.statusCode === 404 || res.statusCode === 403, `Expected 404/403 but got ${res.statusCode}`);
  });

  it("3. Sahabat GET /api/v1/sahabat/inquiries lists provider inquiries with Real DB", async () => {
    if (!process.env.ISOLATED_PORT) {
      return;
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sahabat/inquiries?provider_profile_id=${testProviderProfileId}`,
      headers: {
        cookie: `vind_session=${sahabatToken}`
      }
    });

    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.ok(Array.isArray(json.data.items));
    const found = json.data.items.find((i: any) => i.id === createdInquiryId);
    assert.ok(found, "Created inquiry must appear in Sahabat inquiry list");
  });

  it("4. Sahabat POST /api/v1/sahabat/inquiries/:inquiryId/activate activates inquiry with Real DB", async () => {
    if (!process.env.ISOLATED_PORT) {
      return;
    }

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${createdInquiryId}/activate`,
      headers: {
        cookie: `vind_session=${sahabatToken}`
      }
    });

    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.status, "ACTIVE");
  });

  it("5a. Sahabat assign arbitrary non-scoped person fails (400 VALIDATION_FAILED)", async () => {
    if (!process.env.ISOLATED_PORT) return;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${createdInquiryId}/assign`,
      headers: { cookie: `vind_session=${sahabatToken}` },
      payload: { assigned_person_id: otherConsumerPersonId }
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().code, "VALIDATION_FAILED");
  });

  it("5. Sahabat POST /api/v1/sahabat/inquiries/:inquiryId/assign assigns inquiry with Real DB", async () => {
    if (!process.env.ISOLATED_PORT) {
      return;
    }

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${createdInquiryId}/assign`,
      headers: {
        cookie: `vind_session=${sahabatToken}`
      },
      payload: {
        assigned_person_id: sahabatPersonId,
        reason: "Assigned via Real DB API Test"
      }
    });

    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.status, "ACTIVE");
    assert.strictEqual(json.data.assigned_person_id, sahabatPersonId);
  });

  it("6. Sahabat POST /api/v1/sahabat/inquiries/:inquiryId/close closes inquiry with Real DB", async () => {
    if (!process.env.ISOLATED_PORT) {
      return;
    }

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sahabat/inquiries/${createdInquiryId}/close`,
      headers: {
        cookie: `vind_session=${sahabatToken}`
      },
      payload: { reason: "Completed via Real DB API Test" }
    });

    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.data.status, "CLOSED");
  });

  it("7. SECURITY: FORCE RLS and NOBYPASSRLS verification", async () => {
    if (!process.env.ISOLATED_PORT) return;

    const rlsRes = await pgOwnerClient.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'engagement'
        AND relname IN ('inquiries', 'inquiry_requirements', 'inquiry_participants', 'inquiry_assignments');
    `);

    assert.strictEqual(rlsRes.rows.length, 4);
    for (const r of rlsRes.rows) {
      assert.strictEqual(r.relrowsecurity, true, `Table ${r.relname} must have ROW LEVEL SECURITY = true`);
      assert.strictEqual(r.relforcerowsecurity, true, `Table ${r.relname} must have FORCE ROW LEVEL SECURITY = true`);
    }

    const bypassRes = await pgOwnerClient.query(`
      SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('vind_db_owner', 'vind_migrator', 'vind_app_runtime');
    `);

    for (const r of bypassRes.rows) {
      assert.strictEqual(r.rolbypassrls, false, `Role ${r.rolname} must have NOBYPASSRLS`);
    }
  });

  after(async () => {
    if (!process.env.ISOLATED_PORT) return;
    if (prismaClient) {
      await prismaClient.$disconnect().catch(() => {});
    }
    if (pgOwnerClient) {
      await pgOwnerClient.end().catch(() => {});
    }
    if (app) {
      await app.close().catch(() => {});
    }
  });
});
