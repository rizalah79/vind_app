import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: "packages/database/.env.isolated" });

const port = Number(process.env.ISOLATED_PORT || 55432);
const host = "127.0.0.1";
const database = "vind_app_dev";
const runtimeUser = "vind_app_runtime";
const runtimePassword = process.env.ISOLATED_RUNTIME_PASSWORD!;

function createRuntimeClient(): Client {
  return new Client({ host, port, user: runtimeUser, password: runtimePassword, database });
}

function createBootstrapClient(): Client {
  return new Client({ host, port, user: "vind_bootstrap", password: process.env.ISOLATED_BOOTSTRAP_PASSWORD!, database });
}

test("DB-HO-03-01E Acceptance Matrix: PUBLIC, AUTH LOCAL & SECURITY INVARIANTS", async (t) => {
  // Resolve dynamic IDs from database seed and ensure test provider link
  const bootClient = createBootstrapClient();
  await bootClient.connect();

  const alphaCarRes = await bootClient.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
  const alphaCarProviderId = alphaCarRes.rows[0]?.id;

  const indivIwanRes = await bootClient.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:indiv_iwan'");
  const indivIwanProviderId = indivIwanRes.rows[0]?.id;

  const pubRes = await bootClient.query("SELECT id FROM listing.channel_publications WHERE channel_code = 'VINDZAM' AND publication_status = 'PUBLISHED' LIMIT 1");
  const publishedListingId = pubRes.rows[0]?.id;

  const s1OrgRes = await bootClient.query("SELECT id FROM organization.organizations WHERE seed_key = 'smk:s1:org:alpha'");
  const s1OrgId = s1OrgRes.rows[0]?.id;

  const s1WsRes = await bootClient.query("SELECT id FROM organization.workspaces WHERE seed_key = 'smk:s1:workspace:alpha'");
  const s1WsId = s1WsRes.rows[0]?.id;

  if (alphaCarProviderId && s1OrgId && s1WsId) {
    await bootClient.query("BEGIN");
    await bootClient.query("SET LOCAL ROLE vind_db_owner");
    await bootClient.query("SELECT set_config('vind.command_execution_active', 'on', true)");
    await bootClient.query(`
      INSERT INTO provider.provider_workspace_links (
        provider_profile_id, managing_organization_id, workspace_id, link_status
      ) VALUES ($1, $2, $3, 'ACTIVE')
      ON CONFLICT DO NOTHING
    `, [alphaCarProviderId, s1OrgId, s1WsId]);
    await bootClient.query("COMMIT");
  }

  await bootClient.end();

  assert.ok(alphaCarProviderId, "alpha_car provider ID must be resolved from seed");
  assert.ok(indivIwanProviderId, "indiv_iwan provider ID must be resolved from seed");
  assert.ok(publishedListingId, "published listing ID must be resolved from seed");

  await t.test("SECURITY INVARIANTS: relforcerowsecurity=true and rolbypassrls=false", async () => {
    const client = createRuntimeClient();
    await client.connect();

    // Verify 6 application tables retain FORCE RLS
    const tableRes = await client.query(`
      SELECT c.relname, c.relforcerowsecurity, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('provider', 'listing', 'catalog', 'media')
        AND c.relname IN ('provider_profiles', 'provider_workspace_links', 'channel_publications', 'offerings', 'packages', 'media_derivatives')
    `);
    assert.equal(tableRes.rows.length, 6, "Expected 6 application tables checked");
    for (const r of tableRes.rows) {
      assert.equal(r.relrowsecurity, true, `${r.relname} relrowsecurity must be true`);
      assert.equal(r.relforcerowsecurity, true, `${r.relname} relforcerowsecurity must be true`);
    }

    // Verify NOBYPASSRLS on vind_db_owner and vind_migrator
    const roleRes = await client.query(`
      SELECT rolname, rolbypassrls
      FROM pg_roles
      WHERE rolname IN ('vind_db_owner', 'vind_migrator')
    `);
    assert.equal(roleRes.rows.length, 2, "Expected 2 roles checked");
    for (const r of roleRes.rows) {
      assert.equal(r.rolbypassrls, false, `${r.rolname} rolbypassrls must be false`);
    }

    await client.end();
  });

  await t.test("PUBLIC 1: Valid public provider => visible", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const res = await client.query(
      "SELECT * FROM provider.read_public_provider($1::uuid, 'VINDZAM')",
      [alphaCarProviderId]
    );
    assert.equal(res.rows.length, 1, "Valid provider must return 1 row");
    assert.equal(res.rows[0].provider_id, alphaCarProviderId);
    await client.end();
  });

  await t.test("PUBLIC 2: Invalid provider => zero rows / fail closed", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const res = await client.query(
      "SELECT * FROM provider.read_public_provider('00000000-0000-4000-a000-999999999999'::uuid, 'VINDZAM')"
    );
    assert.equal(res.rows.length, 0, "Invalid provider must return 0 rows");
    await client.end();
  });

  await t.test("PUBLIC 3: Wrong channel => zero rows", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const res = await client.query(
      "SELECT * FROM provider.read_public_provider($1::uuid, 'INVALID_CHANNEL')",
      [alphaCarProviderId]
    );
    assert.equal(res.rows.length, 0, "Wrong channel must return 0 rows");
    await client.end();
  });

  await t.test("PUBLIC 4: Unpublished/ineligible listing => zero rows", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const res = await client.query(
      "SELECT * FROM listing.read_public_listing('00000000-0000-4000-d000-999999999999'::uuid, 'VINDZAM')"
    );
    assert.equal(res.rows.length, 0, "Unpublished listing must return 0 rows");
    await client.end();
  });

  await t.test("PUBLIC 5: Expired/inactive publication => zero rows", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const res = await client.query(
      "SELECT * FROM listing.read_public_listing($1::uuid, 'WRONG_CHANNEL')",
      [publishedListingId]
    );
    assert.equal(res.rows.length, 0, "Expired/inactive publication must return 0 rows");
    await client.end();
  });

  await t.test("PUBLIC 6: Valid read_public_listing => visible", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const res = await client.query(
      "SELECT * FROM listing.read_public_listing($1::uuid, 'VINDZAM')",
      [publishedListingId]
    );
    assert.equal(res.rows.length, 1, "Valid publication must return 1 row");
    assert.equal(res.rows[0].publication_id, publishedListingId);
    await client.end();
  });

  await t.test("PUBLIC 7: Valid read_public_listings collection => succeeds", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const res = await client.query(
      "SELECT * FROM listing.read_public_listings('VINDZAM', NULL, NULL, NULL, 10)"
    );
    assert.ok(res.rows.length >= 1, "Public listings collection must return items");
    await client.end();
  });

  await t.test("AUTH LOCAL 8: ORGANIZATION authorized provider => true/visible", async () => {
    const client = createRuntimeClient();
    await client.connect();
    await client.query("BEGIN");
    await client.query(`
      SELECT security.set_request_context_v2(
        'smk:s1:account:owner_alpha',
        'smk:s1:person:owner_alpha',
        'HUMAN',
        'LOCAL',
        'smk:s1:membership:owner_alpha',
        'smk:s1:assignment:owner_alpha',
        NULL, NULL,
        'smk:s1:org:alpha',
        NULL, NULL,
        'VINDZAM', NULL, 'TEST', 'test-corr', 'test-req', 'AAL2', false, NULL
      )
    `);

    const resCat = await client.query(
      "SELECT access.has_local_provider_catalog_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(resCat.rows[0].allowed, true, "ORGANIZATION authorized catalog read must be true");

    const resTen = await client.query(
      "SELECT access.has_local_tenant_provider_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(resTen.rows[0].allowed, true, "ORGANIZATION authorized tenant read must be true");

    await client.query("ROLLBACK");
    await client.end();
  });

  await t.test("AUTH LOCAL 9: ORGANIZATION cross-org => false/denied", async () => {
    const client = createRuntimeClient();
    await client.connect();
    await client.query("BEGIN");
    await client.query(`
      SELECT security.set_request_context_v2(
        'smk:s1:account:owner_alpha',
        'smk:s1:person:owner_alpha',
        'HUMAN',
        'LOCAL',
        'smk:s1:membership:owner_alpha',
        'smk:s1:assignment:owner_alpha',
        NULL, NULL,
        'smk:s1:org:beta',
        NULL, NULL,
        'VINDZAM', NULL, 'TEST', 'test-corr', 'test-req', 'AAL2', false, NULL
      )
    `);

    const res = await client.query(
      "SELECT access.has_local_provider_catalog_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(res.rows[0].allowed, false, "Cross-org access must return false");
    await client.query("ROLLBACK");
    await client.end();
  });

  await t.test("AUTH LOCAL 10: WORKSPACE exact => true/visible", async () => {
    const client = createRuntimeClient();
    await client.connect();
    await client.query("BEGIN");
    await client.query(`
      SELECT security.set_request_context_v2(
        'smk:s1:account:operations_alpha',
        'smk:s1:person:operations_alpha',
        'HUMAN',
        'LOCAL',
        'smk:s1:membership:operations_alpha',
        'smk:s1:assignment:operations_alpha',
        NULL, NULL,
        'smk:s1:org:alpha',
        'smk:s1:workspace:alpha',
        NULL,
        'VINDZAM', NULL, 'TEST', 'test-corr', 'test-req', 'AAL2', false, NULL
      )
    `);

    const res = await client.query(
      "SELECT access.has_local_provider_catalog_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(res.rows[0].allowed, true, "Exact workspace read must return true");
    await client.query("ROLLBACK");
    await client.end();
  });

  await t.test("AUTH LOCAL 11: Same organization but wrong workspace => false/denied", async () => {
    const client = createRuntimeClient();
    await client.connect();
    await client.query("BEGIN");
    await client.query(`
      SELECT security.set_request_context_v2(
        'smk:s1:account:operations_alpha',
        'smk:s1:person:operations_alpha',
        'HUMAN',
        'LOCAL',
        'smk:s1:membership:operations_alpha',
        'smk:s1:assignment:operations_alpha',
        NULL, NULL,
        'smk:s1:org:alpha',
        'smk:s1:workspace:beta',
        NULL,
        'VINDZAM', NULL, 'TEST', 'test-corr', 'test-req', 'AAL2', false, NULL
      )
    `);

    const res = await client.query(
      "SELECT access.has_local_provider_catalog_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(res.rows[0].allowed, false, "Wrong workspace link must return false");
    await client.query("ROLLBACK");
    await client.end();
  });

  await t.test("AUTH LOCAL 12: PROVIDER exact => true/visible", async () => {
    const client = createRuntimeClient();
    await client.connect();
    await client.query("BEGIN");
    await client.query(`
      SELECT security.set_request_context_v2(
        'smk:s2:acc:owner_alpha',
        'smk:s2:person:owner_alpha',
        'HUMAN',
        'LOCAL',
        'smk:s2:mem:owner_alpha',
        'smk:s2:assign:budi_alpha_owner',
        NULL, NULL,
        'smk:s2:org:alpha',
        NULL,
        'smk:s2:prov:alpha_car',
        'VINDZAM', NULL, 'TEST', 'test-corr', 'test-req', 'AAL2', false, NULL
      )
    `);

    const res = await client.query(
      "SELECT access.has_local_provider_catalog_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(res.rows[0].allowed, true, "Exact provider key scope must return true");
    await client.query("ROLLBACK");
    await client.end();
  });

  await t.test("AUTH LOCAL 13: Cross-provider => false/denied", async () => {
    const client = createRuntimeClient();
    await client.connect();
    await client.query("BEGIN");
    await client.query(`
      SELECT security.set_request_context_v2(
        'smk:s2:acc:owner_alpha',
        'smk:s2:person:owner_alpha',
        'HUMAN',
        'LOCAL',
        'smk:s2:mem:owner_alpha',
        'smk:s2:assign:budi_alpha_owner',
        NULL, NULL,
        'smk:s2:org:alpha',
        NULL,
        'smk:s2:prov:beta_van',
        'VINDZAM', NULL, 'TEST', 'test-corr', 'test-req', 'AAL2', false, NULL
      )
    `);

    const res = await client.query(
      "SELECT access.has_local_provider_catalog_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(res.rows[0].allowed, false, "Cross-provider key scope must return false");
    await client.query("ROLLBACK");
    await client.end();
  });

  await t.test("AUTH LOCAL 14: Person-owned provider exact => true/visible", async () => {
    const client = createRuntimeClient();
    await client.connect();
    await client.query("BEGIN");
    await client.query(`
      SELECT security.set_request_context_v2(
        'smk:s2:acc:indiv_prov_1',
        'smk:s2:person:indiv_prov_1',
        'HUMAN',
        'LOCAL',
        NULL,
        'smk:s2:assign:iwan_indiv_owner',
        NULL, NULL,
        NULL, NULL,
        'smk:s2:prov:indiv_iwan',
        'VINDZAM', NULL, 'TEST', 'test-corr', 'test-req', 'AAL2', false, NULL
      )
    `);

    const res = await client.query(
      "SELECT access.has_local_provider_catalog_read($1::uuid) AS allowed",
      [indivIwanProviderId]
    );
    assert.equal(res.rows[0].allowed, true, "Person-owned provider read must return true for owning person");
    await client.query("ROLLBACK");
    await client.end();
  });

  await t.test("AUTH LOCAL 15: No Request Context V2 => false/denied", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const resCat = await client.query(
      "SELECT access.has_local_provider_catalog_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(resCat.rows[0].allowed, false, "Uninitialized context must deny catalog read");

    const resTen = await client.query(
      "SELECT access.has_local_tenant_provider_read($1::uuid) AS allowed",
      [alphaCarProviderId]
    );
    assert.equal(resTen.rows[0].allowed, false, "Uninitialized context must deny tenant provider read");
    await client.end();
  });
});
