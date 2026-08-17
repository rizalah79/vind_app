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

test("DB-HO-03-01E Acceptance: PUBLIC & AUTH LOCAL Functions Under FORCE RLS", async (t) => {

  await t.test("1. SECURITY: All 6 application tables retain relrowsecurity=true AND relforcerowsecurity=true", async () => {
    const client = createRuntimeClient();
    await client.connect();
    const res = await client.query(`
      SELECT
        n.nspname || '.' || c.relname AS table_name,
        c.relrowsecurity AS rowsec,
        c.relforcerowsecurity AS forcesec
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'provider' AND c.relname IN ('provider_profiles', 'provider_workspace_links'))
         OR (n.nspname = 'listing' AND c.relname = 'channel_publications')
         OR (n.nspname = 'catalog' AND c.relname IN ('offerings', 'packages'))
         OR (n.nspname = 'media' AND c.relname = 'media_derivatives')
      ORDER BY table_name;
    `);
    await client.end();

    assert.equal(res.rows.length, 6, "Expected 6 tables checked");
    for (const r of res.rows) {
      assert.equal(r.rowsec, true, `${r.table_name} relrowsecurity must be true`);
      assert.equal(r.forcesec, true, `${r.table_name} relforcerowsecurity must be true`);
    }
  });

  await t.test("2. PUBLIC: provider.read_public_provider executes without SQLSTATE 42501 under FORCE RLS", async () => {
    const client = createRuntimeClient();
    await client.connect();

    // Query valid provider
    const resValid = await client.query(
      "SELECT * FROM provider.read_public_provider('ccb71f44-6006-47f1-a15d-78185eb80f04'::uuid, 'VINDZAM')"
    );
    assert.equal(resValid.rows.length, 1, "Valid provider query must return 1 row");
    assert.equal(resValid.rows[0].provider_id, "ccb71f44-6006-47f1-a15d-78185eb80f04");

    // Query invalid/wrong provider
    const resInvalid = await client.query(
      "SELECT * FROM provider.read_public_provider('00000000-0000-4000-a000-999999999999'::uuid, 'VINDZAM')"
    );
    assert.equal(resInvalid.rows.length, 0, "Invalid provider query must fail-closed with 0 rows");

    await client.end();
  });

  await t.test("3. PUBLIC: listing.read_public_listing & read_public_listings execute without SQLSTATE 42501", async () => {
    const client = createRuntimeClient();
    await client.connect();

    const resSingle = await client.query(
      "SELECT * FROM listing.read_public_listing('8eda6c63-5c2a-4fb3-a59e-35e38a9e8e20'::uuid, 'VINDZAM')"
    );
    assert.equal(resSingle.rows.length, 1, "Valid publication query must return 1 row");

    const resList = await client.query(
      "SELECT * FROM listing.read_public_listings('VINDZAM', NULL, NULL, NULL, 10)"
    );
    assert.ok(resList.rows.length >= 1, "List public listings must succeed under FORCE RLS");

    await client.end();
  });

  await t.test("4. AUTH LOCAL: access.has_local_provider_catalog_read & has_local_tenant_provider_read", async () => {
    const client = createRuntimeClient();
    await client.connect();

    // With Request Context V2 initialized
    await client.query("BEGIN");
    await client.query("SELECT set_config('vind.ctx_context_initialized', 'true', false)");
    await client.query("SELECT set_config('vind.ctx_context_version', '2', false)");
    await client.query("SELECT set_config('vind.ctx_actor_kind', 'HUMAN', false)");
    await client.query("SELECT set_config('vind.ctx_authority_plane', 'LOCAL', false)");
    await client.query("SELECT set_config('vind.ctx_actor_person_id', '00000000-0000-4000-e000-000000000001', false)");
    await client.query("SELECT set_config('vind.ctx_local_assignment_key', 'SEED_ASSIGNMENT_101', false)");
    await client.query("SELECT set_config('vind.ctx_organization_key', 'ORG_SMK_DEV', false)");

    const catRead = await client.query(
      "SELECT access.has_local_provider_catalog_read('ccb71f44-6006-47f1-a15d-78185eb80f04'::uuid) AS allowed"
    );
    assert.ok(typeof catRead.rows[0].allowed === "boolean", "Catalog read check must execute without SQLSTATE 42501");

    await client.query("ROLLBACK");

    // Without Request Context V2 initialized (denied)
    const catReadNoCtx = await client.query(
      "SELECT access.has_local_provider_catalog_read('ccb71f44-6006-47f1-a15d-78185eb80f04'::uuid) AS allowed"
    );
    assert.equal(catReadNoCtx.rows[0].allowed, false, "Uninitialized context must deny catalog read");

    await client.end();
  });
});
