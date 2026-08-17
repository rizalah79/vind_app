import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pkg from "pg";
const { Client, Pool } = pkg;

function getIsolatedEnv(): Record<string, string> {
  let p = path.resolve(process.cwd(), "packages/database/.env.isolated");
  if (!fs.existsSync(p)) {
    p = path.resolve(process.cwd(), ".env.isolated");
  }
  if (!fs.existsSync(p)) return {};
  const content = fs.readFileSync(p, "utf-8");
  const res: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      res[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
    }
  }
  return res;
}

const isoEnv = getIsolatedEnv();
const PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : (isoEnv.ISOLATED_DB_PORT ? parseInt(isoEnv.ISOLATED_DB_PORT, 10) : 55432);
const HOST = process.env.DB_HOST || "127.0.0.1";
const DB_NAME = process.env.DB_NAME || "vind_app_dev";

const MIGRATOR_PASS = isoEnv.ISOLATED_MIGRATOR_PASSWORD || process.env.VIND_MIGRATOR_PASSWORD || "";
const RUNTIME_PASS = isoEnv.ISOLATED_RUNTIME_PASSWORD || process.env.VIND_RUNTIME_PASSWORD || "";

async function clearRequestContextV2(client: any) {
  try {
    await client.query("SELECT security.clear_request_context()");
  } catch (e) {}
  await client.query("ROLLBACK").catch(() => {});
}

test("DB-HO-03-04 Acceptance Test Suite on Isolated NOBYPASSRLS Database (Port 55432)", async (t) => {
  // We use vind_migrator with SET ROLE vind_db_owner for setting up test fixtures,
  // and vind_app_runtime for testing security policies & public functions.
  const adminClient = new Client({
    host: HOST,
    port: PORT,
    user: "vind_migrator",
    password: MIGRATOR_PASS,
    database: DB_NAME,
  });

  const runtimeClient = new Client({
    host: HOST,
    port: PORT,
    user: "vind_app_runtime",
    password: RUNTIME_PASS,
    database: DB_NAME,
  });

  // Helper to set Request Context V2 for local runtime session
  async function setRequestContextV2(
    client: any,
    params: {
      actorPersonId: string;
      localAssignmentKey: string;
      organizationKey?: string;
      workspaceKey?: string;
      providerKey?: string;
    }
  ) {
    const personRes = await adminClient.query("SELECT seed_key FROM party.persons WHERE id = $1", [params.actorPersonId]);
    const personKey = personRes.rows[0]?.seed_key || params.actorPersonId;

    const saRes = await adminClient.query(`
      SELECT m.seed_key as membership_key
      FROM access.scoped_assignments sa
      LEFT JOIN access.memberships m ON m.id = sa.membership_id
      WHERE sa.seed_key = $1
    `, [params.localAssignmentKey]);
    const membershipKey = saRes.rows[0]?.membership_key || null;

    await client.query("ROLLBACK").catch(() => {});
    await client.query("BEGIN");

    await client.query("SELECT security.clear_request_context()");
    await client.query(
      `SELECT security.set_request_context_v2(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19
      )`,
      [
        null,
        personKey,
        "HUMAN",
        "LOCAL",
        membershipKey,
        params.localAssignmentKey,
        null,
        null,
        params.organizationKey ?? null,
        params.workspaceKey ?? null,
        params.providerKey ?? null,
        "VINDZAM",
        null,
        "OPS",
        "test-0304-correlation",
        "test-0304-request",
        "BASIC",
        true,
        null
      ]
    );
  }

  await adminClient.connect();
  await adminClient.query("SET ROLE vind_db_owner");
  await adminClient.query("SET timezone TO 'UTC'");
  await adminClient.query("SELECT set_config('vind.command_execution_active', 'on', false)");

  await runtimeClient.connect();
  await runtimeClient.query("SET timezone TO 'UTC'");

  // Clean up any test fixtures from previous runs
  await adminClient.query("DELETE FROM media.media_derivatives WHERE source_media_asset_id IN (SELECT id FROM media.media_assets WHERE seed_key LIKE 'test_%') OR storage_locator LIKE '%test_%'");
  await adminClient.query("DELETE FROM media.media_links WHERE seed_key LIKE 'test_%'");
  await adminClient.query("DELETE FROM media.media_rights WHERE seed_key LIKE 'test_%'");
  await adminClient.query("DELETE FROM media.media_assets WHERE seed_key LIKE 'test_%'");
  await adminClient.query("DELETE FROM listing.channel_publications WHERE seed_key LIKE 'test_%'");
  await adminClient.query("DELETE FROM listing.channels WHERE code LIKE 'TEST_CH_%' OR seed_key LIKE 'test_%'");

  // Setup base entities for testing
  const seedPrefix = `test_0304_${Date.now()}`;
  const channelCode = `TEST_CH_0304_${Math.floor(Math.random()*10000)}`;
  const channelSeedKey = `test_ch_0304_${Math.floor(Math.random()*10000)}`;
  const channelHost = `${seedPrefix}.example.com`;

  // 1. Create channel
  const chRes = await adminClient.query(`
    INSERT INTO listing.channels (seed_key, code, display_name, status)
    VALUES ($1, $2, 'Test Channel', 'ACTIVE')
    RETURNING id;
  `, [channelSeedKey, channelCode]);
  const channelId = chRes.rows[0].id;

  // 2. Fetch seeded org, workspace, person, provider profile, scoped assignment
  const saRes = await adminClient.query(`
    SELECT seed_key, subject_person_id, scope_type, organization_id, workspace_id, provider_id
    FROM access.scoped_assignments
    WHERE seed_key = 'smk:s1:assignment:owner_alpha';
  `);
  const saOrg = saRes.rows[0];

  const personId = saOrg.subject_person_id;
  const orgId1 = saOrg.organization_id;
  const localAssignmentKey = saOrg.seed_key;

  const orgRes = await adminClient.query("SELECT seed_key FROM organization.organizations WHERE id = $1", [orgId1]);
  const orgKey1 = orgRes.rows[0].seed_key;

  const wsRes = await adminClient.query("SELECT id, seed_key FROM organization.workspaces WHERE organization_id = $1 AND status = 'ACTIVE' LIMIT 1", [orgId1]);
  const wsId1 = wsRes.rows[0].id;
  const wsKey1 = wsRes.rows[0].seed_key;

  const provRes = await adminClient.query("SELECT id, seed_key FROM provider.provider_profiles WHERE status = 'ACTIVE' AND owning_organization_id IS NOT NULL LIMIT 1");
  const providerId = provRes.rows[0].id;
  const providerKey = provRes.rows[0].seed_key;

  const offeringRes = await adminClient.query("SELECT id FROM catalog.offerings WHERE provider_profile_id = $1 LIMIT 1", [providerId]);
  const offeringId = offeringRes.rows[0].id;

  // Set provider owning_organization_id to orgId1
  await adminClient.query("UPDATE provider.provider_profiles SET owning_organization_id = $1 WHERE id = $2", [orgId1, providerId]);

  // Fetch workspace for operations_alpha assignment
  const opsSaRes = await adminClient.query("SELECT workspace_id FROM access.scoped_assignments WHERE seed_key = 'smk:s1:assignment:operations_alpha'");
  const opsWsId = opsSaRes.rows[0].workspace_id;
  const opsWsRes = await adminClient.query("SELECT seed_key FROM organization.workspaces WHERE id = $1", [opsWsId]);
  const opsWsKey = opsWsRes.rows[0].seed_key;

  // Link provider to workspace wsId1 and opsWsId
  await adminClient.query(`
    INSERT INTO provider.provider_workspace_links (provider_profile_id, managing_organization_id, workspace_id, link_status)
    VALUES ($1, $2, $3, 'ACTIVE'), ($1, $2, $4, 'ACTIVE')
    ON CONFLICT DO NOTHING;
  `, [providerId, orgId1, wsId1, opsWsId]);

  // Create channel publication
  const pubRes = await adminClient.query(`
    INSERT INTO listing.channel_publications (
      seed_key, channel_id, channel_code, provider_profile_id, offering_id, publication_status
    ) VALUES ($1, $2, $3, $4, $5, 'PUBLISHED')
    RETURNING id;
  `, [`${seedPrefix}_pub`, channelId, channelCode, providerId, offeringId]);
  const pubId = pubRes.rows[0].id;

  // Helper to create test asset
  async function createTestAsset(keySuffix: string, status = "ACTIVE", storagePath = `storage/${seedPrefix}_${keySuffix}.png`) {
    const res = await adminClient.query(`
      INSERT INTO media.media_assets (
        seed_key, owner_provider_profile_id, media_type, file_name, file_size_bytes,
        mime_type, checksum_sha256, storage_path, status
      ) VALUES ($1, $2, 'IMAGE', 'test.png', 1024, 'image/png', 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0', $3, $4)
      RETURNING id, storage_path;
    `, [`${seedPrefix}_${keySuffix}`, providerId, storagePath, status]);
    return res.rows[0];
  }

  // Helper to create test media rights
  async function createTestRights(mediaId: string, keySuffix: string, status = "ACTIVE", effectiveFrom = new Date(Date.now() - 3600000), effectiveTo: Date | null = null) {
    await adminClient.query(`
      INSERT INTO media.media_rights (
        seed_key, media_asset_id, rights_type, status, effective_from, effective_to
      ) VALUES ($1, $2, 'PUBLIC_DISPLAY', $3, $4, $5);
    `, [`${seedPrefix}_mr_${keySuffix}`, mediaId, status, effectiveFrom, effectiveTo]);
  }

  // Helper to create test media link
  async function createTestLink(mediaId: string, pubId: string, keySuffix: string, status = "ACTIVE", role = "PUBLIC_LISTING", effectiveFrom = new Date(Date.now() - 3600000), effectiveTo: Date | null = null) {
    await adminClient.query(`
      INSERT INTO media.media_links (
        seed_key, media_asset_id, channel_publication_id, link_role, link_status, effective_from, effective_to
      ) VALUES ($1, $2, $3, $4, $5, $6, $7);
    `, [`${seedPrefix}_ml_${keySuffix}`, mediaId, pubId, role, status, effectiveFrom, effectiveTo]);
  }

  // Helper to create test derivative
  async function createTestDerivative(mediaId: string, params: {
    variant_code?: string;
    is_canonical?: boolean;
    storage_locator?: string;
    scan_status?: string;
    moderation_status?: string;
    delivery_status?: string;
    effective_from?: Date;
    effective_to?: Date | null;
  }) {
    const loc = params.storage_locator || `cdn/${seedPrefix}_${Math.random().toString(36).slice(2)}.webp`;
    const res = await adminClient.query(`
      INSERT INTO media.media_derivatives (
        source_media_asset_id, variant_code, is_canonical, content_type, storage_locator,
        checksum_sha256, scan_status, moderation_status, delivery_status, width_px, height_px,
        effective_from, effective_to
      ) VALUES ($1, $2, $3, 'image/webp', $4, 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0', $5, $6, $7, 800, 600, $8, $9)
      RETURNING id, storage_locator;
    `, [
      mediaId,
      params.variant_code || "THUMBNAIL_800",
      params.is_canonical ?? true,
      loc,
      params.scan_status || "CLEAN",
      params.moderation_status || "APPROVED",
      params.delivery_status || "DELIVERABLE",
      params.effective_from || new Date(Date.now() - 3600000),
      params.effective_to || null
    ]);
    return res.rows[0];
  }

  // ============================================================================
  // PUBLIC TEST MATRIX (1 - 20)
  // ============================================================================

  await t.test("PUBLIC 1: Exact eligible channel => returns 1 canonical derivative", async () => {
    const asset = await createTestAsset("p1");
    await createTestRights(asset.id, "p1");
    await createTestLink(asset.id, pubId, "p1");
    const deriv = await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );

    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0].media_id, asset.id);
    assert.equal(res.rows[0].derivative_id, deriv.id);
    assert.equal(res.rows[0].storage_locator, deriv.storage_locator);
    assert.equal(res.rows[0].content_type, "image/webp");
    assert.equal(res.rows[0].variant_code, "THUMBNAIL_800");
    assert.equal(res.rows[0].width_px, 800);
    assert.equal(res.rows[0].height_px, 600);
  });

  await t.test("PUBLIC 2: Wrong channel => zero rows", async () => {
    const asset = await createTestAsset("p2");
    await createTestRights(asset.id, "p2");
    await createTestLink(asset.id, pubId, "p2");
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, "wrong_channel_code"]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 3: Unpublished publication => zero rows", async () => {
    // create draft publication
    const draftPubRes = await adminClient.query(`
      INSERT INTO listing.channel_publications (seed_key, channel_id, channel_code, provider_profile_id, offering_id, publication_status)
      VALUES ($1, $2, $3, $4, $5, 'DRAFT') RETURNING id;
    `, [`${seedPrefix}_pub_draft`, channelId, channelCode, providerId, offeringId]);

    const asset = await createTestAsset("p3");
    await createTestRights(asset.id, "p3");
    await createTestLink(asset.id, draftPubRes.rows[0].id, "p3");
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 4: Future publication => zero rows", async () => {
    const futurePubRes = await adminClient.query(`
      INSERT INTO listing.channel_publications (seed_key, channel_id, channel_code, provider_profile_id, offering_id, publication_status, effective_from)
      VALUES ($1, $2, $3, $4, $5, 'PUBLISHED', NOW() + INTERVAL '1 day') RETURNING id;
    `, [`${seedPrefix}_pub_future`, channelId, channelCode, providerId, offeringId]);

    const asset = await createTestAsset("p4");
    await createTestRights(asset.id, "p4");
    await createTestLink(asset.id, futurePubRes.rows[0].id, "p4");
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 5: Expired publication => zero rows", async () => {
    const expiredPubRes = await adminClient.query(`
      INSERT INTO listing.channel_publications (seed_key, channel_id, channel_code, provider_profile_id, offering_id, publication_status, effective_from, effective_to)
      VALUES ($1, $2, $3, $4, $5, 'PUBLISHED', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day') RETURNING id;
    `, [`${seedPrefix}_pub_expired`, channelId, channelCode, providerId, offeringId]);

    const asset = await createTestAsset("p5");
    await createTestRights(asset.id, "p5");
    await createTestLink(asset.id, expiredPubRes.rows[0].id, "p5");
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 6: Inactive provider => zero rows", async () => {
    // create inactive provider profile
    const inactProvRes = await adminClient.query(`
      INSERT INTO provider.provider_profiles (seed_key, legal_name, display_name, provider_type, owning_organization_id, status, data_origin_code)
      VALUES ($1, 'Inactive Prov Legal', 'Inactive Provider', 'COMPANY', $2, 'ARCHIVED', 'SYNTHETIC_DEMO') RETURNING id;
    `, [`${seedPrefix}_inactprov`, orgId1]);
    const inactProvId = inactProvRes.rows[0].id;

    // Create offering for inactive provider
    const inactOfferingRes = await adminClient.query(`
      INSERT INTO catalog.offerings (seed_key, provider_profile_id, offering_code, title, status)
      VALUES ($1, $2, 'inact_offering_code', 'Inact Offering', 'ACTIVE') RETURNING id;
    `, [`${seedPrefix}_inactoffering`, inactProvId]);

    const inactPubRes = await adminClient.query(`
      INSERT INTO listing.channel_publications (seed_key, channel_id, channel_code, provider_profile_id, offering_id, publication_status)
      VALUES ($1, $2, $3, $4, $5, 'PUBLISHED') RETURNING id;
    `, [`${seedPrefix}_pub_inactprov`, channelId, channelCode, inactProvId, inactOfferingRes.rows[0].id]);

    const asset = await adminClient.query(`
      INSERT INTO media.media_assets (seed_key, owner_provider_profile_id, media_type, file_name, file_size_bytes, mime_type, checksum_sha256, storage_path, status)
      VALUES ($1, $2, 'IMAGE', 'test.png', 1024, 'image/png', 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0', 'path/inact.png', 'ACTIVE') RETURNING id;
    `, [`${seedPrefix}_p6_asset`, inactProvId]);

    await createTestRights(asset.rows[0].id, "p6");
    await createTestLink(asset.rows[0].id, inactPubRes.rows[0].id, "p6");
    await createTestDerivative(asset.rows[0].id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.rows[0].id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 7: Missing rights => zero rows", async () => {
    const asset = await createTestAsset("p7");
    // No rights created
    await createTestLink(asset.id, pubId, "p7");
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 8: Expired rights => zero rows", async () => {
    const asset = await createTestAsset("p8");
    await createTestRights(asset.id, "p8", "ACTIVE", new Date(Date.now() - 7200000), new Date(Date.now() - 3600000));
    await createTestLink(asset.id, pubId, "p8");
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 9: Revoked rights => zero rows", async () => {
    const asset = await createTestAsset("p9");
    await createTestRights(asset.id, "p9", "REVOKED");
    await createTestLink(asset.id, pubId, "p9");
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 10: Inactive media link => zero rows", async () => {
    const asset = await createTestAsset("p10");
    await createTestRights(asset.id, "p10");
    await createTestLink(asset.id, pubId, "p10", "INACTIVE");
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 11: Expired/future media link => zero rows", async () => {
    const asset = await createTestAsset("p11");
    await createTestRights(asset.id, "p11");
    await createTestLink(asset.id, pubId, "p11", "ACTIVE", "PUBLIC_LISTING", new Date(Date.now() - 7200000), new Date(Date.now() - 3600000));
    await createTestDerivative(asset.id, {});

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 12: No derivative => zero rows", async () => {
    const asset = await createTestAsset("p12");
    await createTestRights(asset.id, "p12");
    await createTestLink(asset.id, pubId, "p12");
    // No derivative created

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 13: Non-canonical derivative => zero rows", async () => {
    const asset = await createTestAsset("p13");
    await createTestRights(asset.id, "p13");
    await createTestLink(asset.id, pubId, "p13");
    await createTestDerivative(asset.id, { is_canonical: false });

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 14: Unsafe/quarantined/infected derivative => zero rows", async () => {
    for (const scanStatus of ["UNSAFE", "QUARANTINED", "INFECTED", "PENDING", "FAILED"]) {
      const asset = await createTestAsset(`p14_${scanStatus}`);
      await createTestRights(asset.id, `p14_${scanStatus}`);
      await createTestLink(asset.id, pubId, `p14_${scanStatus}`);
      await createTestDerivative(asset.id, { scan_status: scanStatus, moderation_status: "APPROVED", delivery_status: "PENDING" });

      const res = await runtimeClient.query(
        "SELECT * FROM media.read_public_media_delivery($1, $2)",
        [asset.id, channelCode]
      );
      assert.equal(res.rowCount, 0, `Scan status ${scanStatus} should be rejected`);
    }
  });

  await t.test("PUBLIC 15: Moderation BLOCKED => zero rows", async () => {
    const asset = await createTestAsset("p15");
    await createTestRights(asset.id, "p15");
    await createTestLink(asset.id, pubId, "p15");
    await createTestDerivative(asset.id, { scan_status: "CLEAN", moderation_status: "BLOCKED", delivery_status: "BLOCKED" });

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 16: Delivery BLOCKED/REVOKED => zero rows", async () => {
    for (const deliveryStatus of ["BLOCKED", "REVOKED", "PENDING"]) {
      const asset = await createTestAsset(`p16_${deliveryStatus}`);
      await createTestRights(asset.id, `p16_${deliveryStatus}`);
      await createTestLink(asset.id, pubId, `p16_${deliveryStatus}`);
      await createTestDerivative(asset.id, { delivery_status: deliveryStatus });

      const res = await runtimeClient.query(
        "SELECT * FROM media.read_public_media_delivery($1, $2)",
        [asset.id, channelCode]
      );
      assert.equal(res.rowCount, 0, `Delivery status ${deliveryStatus} should be rejected`);
    }
  });

  await t.test("PUBLIC 17: Derivative not yet effective / expired => zero rows", async () => {
    const asset1 = await createTestAsset("p17_future");
    await createTestRights(asset1.id, "p17_future");
    await createTestLink(asset1.id, pubId, "p17_future");
    await createTestDerivative(asset1.id, { effective_from: new Date(Date.now() + 3600000) });

    const res1 = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset1.id, channelCode]
    );
    assert.equal(res1.rowCount, 0);

    const asset2 = await createTestAsset("p17_expired");
    await createTestRights(asset2.id, "p17_expired");
    await createTestLink(asset2.id, pubId, "p17_expired");
    await createTestDerivative(asset2.id, { effective_from: new Date(Date.now() - 7200000), effective_to: new Date(Date.now() - 3600000) });

    const res2 = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset2.id, channelCode]
    );
    assert.equal(res2.rowCount, 0);
  });

  await t.test("PUBLIC 18: Original-only asset => zero rows", async () => {
    const asset = await createTestAsset("p18");
    await createTestRights(asset.id, "p18");
    await createTestLink(asset.id, pubId, "p18");

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );
    assert.equal(res.rowCount, 0);
  });

  await t.test("PUBLIC 19: Original storage_path is NEVER returned", async () => {
    const asset = await createTestAsset("p19", "ACTIVE", "private/original_source_file.png");
    await createTestRights(asset.id, "p19");
    await createTestLink(asset.id, pubId, "p19");
    const deriv = await createTestDerivative(asset.id, { storage_locator: "public/cdn/derived_800.webp" });

    const res = await runtimeClient.query(
      "SELECT * FROM media.read_public_media_delivery($1, $2)",
      [asset.id, channelCode]
    );

    assert.equal(res.rowCount, 1);
    assert.notEqual(res.rows[0].storage_locator, asset.storage_path);
    assert.equal(res.rows[0].storage_locator, "public/cdn/derived_800.webp");

    // Also assert media.media_assets table is RLS-protected against runtime directly querying storage_path
    const directRes = await runtimeClient.query("SELECT * FROM media.media_assets WHERE id = $1", [asset.id]);
    assert.equal(directRes.rows.length, 0, "Direct query on media_assets by runtime must return 0 rows under RLS");
  });

  await t.test("PUBLIC 20: Derivative locator equal to original source path is rejected by DB protection", async () => {
    const asset = await createTestAsset("p20", "ACTIVE", "private/same_path.png");

    await assert.rejects(
      async () => {
        await adminClient.query(`
          INSERT INTO media.media_derivatives (
            source_media_asset_id, variant_code, is_canonical, content_type, storage_locator,
            checksum_sha256, scan_status, moderation_status, delivery_status
          ) VALUES ($1, 'THUMB', true, 'image/png', 'private/same_path.png', 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0', 'CLEAN', 'APPROVED', 'DELIVERABLE');
        `, [asset.id]);
      },
      (err: any) => {
        assert.equal(err.code, "23514"); // check_violation
        assert.match(err.message, /Derivative storage locator must differ from source media storage path/);
        return true;
      }
    );
  });

  // ============================================================================
  // AUTHENTICATED LOCAL TEST MATRIX (21 - 33)
  // ============================================================================

  await t.test("AUTHENTICATED LOCAL 21: ORGANIZATION valid => derivative visible", async () => {
    const asset = await createTestAsset("loc21");
    await createTestRights(asset.id, "loc21");
    const deriv = await createTestDerivative(asset.id, {});

    await setRequestContextV2(runtimeClient, {
      actorPersonId: personId,
      localAssignmentKey,
      organizationKey: orgKey1
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0].id, deriv.id);
  });

  await t.test("AUTHENTICATED LOCAL 22: Cross-organization/cross-provider => zero", async () => {
    const asset = await createTestAsset("loc22");
    await createTestRights(asset.id, "loc22");
    const deriv = await createTestDerivative(asset.id, {});

    // Query with non-matching organization key
    await setRequestContextV2(runtimeClient, {
      actorPersonId: personId,
      localAssignmentKey,
      organizationKey: "unrelated_org_key"
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 0);
  });

  await t.test("AUTHENTICATED LOCAL 23: WORKSPACE exact linked => visible", async () => {
    const sitiRes0 = await adminClient.query("SELECT subject_person_id FROM access.scoped_assignments WHERE seed_key = 'smk:s1:assignment:operations_alpha'");
    const sitiPersonId = sitiRes0.rows[0].subject_person_id;
    const wsAssignmentKey = "smk:s1:assignment:operations_alpha";
    const asset = await createTestAsset("loc23");
    await createTestRights(asset.id, "loc23");
    const deriv = await createTestDerivative(asset.id, {});

    await setRequestContextV2(runtimeClient, {
      actorPersonId: sitiPersonId,
      localAssignmentKey: wsAssignmentKey,
      organizationKey: orgKey1,
      workspaceKey: opsWsKey
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 1);
  });

  await t.test("AUTHENTICATED LOCAL 24: Same organization but wrong workspace => zero", async () => {
    const wsAssignmentKey = "smk:s1:assignment:operations_alpha";
    const asset = await createTestAsset("loc24");
    await createTestRights(asset.id, "loc24");
    const deriv = await createTestDerivative(asset.id, {});

    // Create a second unlinked workspace in orgId1
    const wsCode = `WS_UNLINKED_${Math.floor(Math.random()*10000)}`;
    const unlinkedWsRes = await adminClient.query(`
      INSERT INTO organization.workspaces (organization_id, seed_key, code, display_name, status)
      VALUES ($1, $2, $3, 'Unlinked WS', 'ACTIVE') RETURNING seed_key;
    `, [orgId1, `${seedPrefix}_unlinked_ws`, wsCode]);

    await setRequestContextV2(runtimeClient, {
      actorPersonId: personId,
      localAssignmentKey: wsAssignmentKey,
      organizationKey: orgKey1,
      workspaceKey: unlinkedWsRes.rows[0].seed_key
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 0);
  });

  await t.test("AUTHENTICATED LOCAL 25: Unrelated workspace => zero", async () => {
    const wsAssignmentKey = "smk:s1:assignment:operations_alpha";
    const asset = await createTestAsset("loc25");
    await createTestRights(asset.id, "loc25");
    const deriv = await createTestDerivative(asset.id, {});

    await setRequestContextV2(runtimeClient, {
      actorPersonId: personId,
      localAssignmentKey: wsAssignmentKey,
      organizationKey: orgKey1,
      workspaceKey: "totally_unrelated_ws"
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 0);
  });

  await t.test("AUTHENTICATED LOCAL 26: PROVIDER exact => visible", async () => {
    const budiRes0 = await adminClient.query("SELECT subject_person_id FROM access.scoped_assignments WHERE seed_key = 'smk:s2:assign:budi_alpha_owner'");
    const budiPersonId = budiRes0.rows[0].subject_person_id;
    const provAssignmentKey = "smk:s2:assign:budi_alpha_owner";
    const provKey = "smk:s2:prov:alpha_car";
    const provRes0 = await adminClient.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    const provId = provRes0.rows[0].id;

    const assetRes = await adminClient.query(`
      INSERT INTO media.media_assets (seed_key, owner_provider_profile_id, media_type, file_name, file_size_bytes, mime_type, checksum_sha256, storage_path, status)
      VALUES ($1, $2, 'IMAGE', 'loc26.png', 1024, 'image/png', 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0', 'path/loc26.png', 'ACTIVE') RETURNING id;
    `, [`${seedPrefix}_loc26_asset`, provId]);

    await createTestRights(assetRes.rows[0].id, "loc26");
    const deriv = await createTestDerivative(assetRes.rows[0].id, {});

    await setRequestContextV2(runtimeClient, {
      actorPersonId: budiPersonId,
      localAssignmentKey: provAssignmentKey,
      organizationKey: orgKey1,
      providerKey: provKey
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 1);
  });

  await t.test("AUTHENTICATED LOCAL 27: Cross-provider => zero", async () => {
    const budiRes0 = await adminClient.query("SELECT subject_person_id FROM access.scoped_assignments WHERE seed_key = 'smk:s2:assign:budi_alpha_owner'");
    const budiPersonId = budiRes0.rows[0].subject_person_id;
    const provAssignmentKey = "smk:s2:assign:budi_alpha_owner";

    const asset = await createTestAsset("loc27");
    await createTestRights(asset.id, "loc27");
    const deriv = await createTestDerivative(asset.id, {});

    await setRequestContextV2(runtimeClient, {
      actorPersonId: budiPersonId,
      localAssignmentKey: provAssignmentKey,
      providerKey: "other_provider_key"
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 0);
  });

  await t.test("AUTHENTICATED LOCAL 28: Person-owned provider valid => visible", async () => {
    const iwanRes0 = await adminClient.query("SELECT subject_person_id FROM access.scoped_assignments WHERE seed_key = 'smk:s2:assign:iwan_indiv_owner'");
    const iwanPersonId = iwanRes0.rows[0].subject_person_id;
    const iwanAssignmentKey = "smk:s2:assign:iwan_indiv_owner";
    const iwanProvKey = "smk:s2:prov:indiv_iwan";
    const iwanRes1 = await adminClient.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:indiv_iwan'");
    const iwanProvId = iwanRes1.rows[0].id;

    const assetRes = await adminClient.query(`
      INSERT INTO media.media_assets (seed_key, owner_provider_profile_id, media_type, file_name, file_size_bytes, mime_type, checksum_sha256, storage_path, status)
      VALUES ($1, $2, 'IMAGE', 'person.png', 1024, 'image/png', 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0', 'path/person.png', 'ACTIVE') RETURNING id;
    `, [`${seedPrefix}_loc28_asset`, iwanProvId]);

    await createTestRights(assetRes.rows[0].id, "loc28");
    const deriv = await createTestDerivative(assetRes.rows[0].id, {});

    await setRequestContextV2(runtimeClient, {
      actorPersonId: iwanPersonId,
      localAssignmentKey: iwanAssignmentKey,
      providerKey: iwanProvKey
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 1);
  });

  await t.test("AUTHENTICATED LOCAL 29: Inactive provider => zero", async () => {
    const inactProvRes = await adminClient.query(`
      INSERT INTO provider.provider_profiles (legal_name, display_name, provider_type, owning_organization_id, seed_key, status, data_origin_code)
      VALUES ('Inactive Prov Legal 2', 'Inactive Prov 2', 'COMPANY', $1, $2, 'ARCHIVED', 'SYNTHETIC_DEMO') RETURNING id, seed_key;
    `, [orgId1, `${seedPrefix}_inact_prov2`]);

    const assetRes = await adminClient.query(`
      INSERT INTO media.media_assets (seed_key, owner_provider_profile_id, media_type, file_name, file_size_bytes, mime_type, checksum_sha256, storage_path, status)
      VALUES ($1, $2, 'IMAGE', 'test.png', 1024, 'image/png', 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0', 'path/inact2.png', 'ACTIVE') RETURNING id;
    `, [`${seedPrefix}_loc29_asset`, inactProvRes.rows[0].id]);

    await createTestRights(assetRes.rows[0].id, "loc29");
    const deriv = await createTestDerivative(assetRes.rows[0].id, {});

    await setRequestContextV2(runtimeClient, {
      actorPersonId: personId,
      localAssignmentKey,
      organizationKey: orgKey1
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 0);
  });

  await t.test("AUTHENTICATED LOCAL 30: Rights invalid => zero", async () => {
    const asset = await createTestAsset("loc30");
    await createTestRights(asset.id, "loc30", "EXPIRED");
    const deriv = await createTestDerivative(asset.id, {});

    await setRequestContextV2(runtimeClient, {
      actorPersonId: personId,
      localAssignmentKey,
      organizationKey: orgKey1
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 0);
  });

  await t.test("AUTHENTICATED LOCAL 31: Unsafe derivative => zero", async () => {
    const asset = await createTestAsset("loc31");
    await createTestRights(asset.id, "loc31");
    const deriv = await createTestDerivative(asset.id, { scan_status: "UNSAFE", delivery_status: "BLOCKED" });

    await setRequestContextV2(runtimeClient, {
      actorPersonId: personId,
      localAssignmentKey,
      organizationKey: orgKey1
    });

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 0);
  });

  await t.test("AUTHENTICATED LOCAL 32: No Request Context V2 => zero", async () => {
    const asset = await createTestAsset("loc32");
    await createTestRights(asset.id, "loc32");
    const deriv = await createTestDerivative(asset.id, {});

    // Clear context
    await runtimeClient.query("SELECT security.clear_request_context()");

    const res = await runtimeClient.query(
      "SELECT * FROM media.media_derivatives WHERE id = $1",
      [deriv.id]
    );

    assert.equal(res.rowCount, 0);
  });

  await t.test("AUTHENTICATED LOCAL 33: Context/pool isolation remains intact", async () => {
    const asset = await createTestAsset("loc33");
    await createTestRights(asset.id, "loc33");
    const deriv = await createTestDerivative(asset.id, {});

    const pool = new Pool({
      host: HOST,
      port: PORT,
      user: "vind_app_runtime",
      password: RUNTIME_PASS,
      database: DB_NAME,
      max: 2
    });

    try {
      const c1 = await pool.connect();
      const c2 = await pool.connect();

      // Set context on c1
      await setRequestContextV2(c1, {
        actorPersonId: personId,
        localAssignmentKey,
        organizationKey: orgKey1
      });

      // c1 should see derivative
      const res1 = await c1.query("SELECT * FROM media.media_derivatives WHERE id = $1", [deriv.id]);
      assert.equal(res1.rowCount, 1, "Connection 1 with context sees derivative");

      // c2 should NOT see derivative (pool isolation)
      const res2 = await c2.query("SELECT * FROM media.media_derivatives WHERE id = $1", [deriv.id]);
      assert.equal(res2.rowCount, 0, "Connection 2 without context must see 0 rows");

      c1.release();
      c2.release();
    } finally {
      await pool.end();
    }
  });

  // Cleanup connections
  await adminClient.end();
  await runtimeClient.end();
});
