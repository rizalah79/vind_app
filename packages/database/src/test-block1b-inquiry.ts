import assert from "node:assert";
import { test } from "node:test";
import { Client } from "pg";

const connectionString = process.env.DATABASE_MIGRATION_URL || "postgresql://vind_db_owner:vind_db_owner_pass@localhost:5432/vind_app_dev?schema=public";
const runtimeUrl = process.env.DATABASE_URL || "postgresql://vind_app_runtime:f1bfce720440462356e611e7b13fbb615204bb9353651b53c361f77f1097f0ad@localhost:5432/vind_app_dev?schema=public";

test("BLOCK 1B DB ACCEPTANCE: INQUIRY CORE MATRIX", async (t) => {
  const client = new Client({ connectionString });
  await client.connect();

  await t.test("STRUCTURAL: Schema engagement tables, RLS=true, FORCE RLS=true, NOBYPASSRLS", async () => {
    const res = await client.query(`
      SELECT table_name, rowsecurity
      FROM information_schema.tables t
      JOIN pg_tables p ON p.tablename = t.table_name AND p.schemaname = t.table_schema
      WHERE t.table_schema = 'engagement'
        AND t.table_name IN ('inquiries', 'inquiry_requirements', 'inquiry_participants', 'inquiry_assignments');
    `);
    assert.strictEqual(res.rows.length, 4, "Should have 4 canonical engagement tables");
    for (const row of res.rows) {
      assert.strictEqual(row.rowsecurity, true, `Table ${row.table_name} must have ROW LEVEL SECURITY = true`);
    }

    const forceRes = await client.query(`
      SELECT c.relname, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'engagement'
        AND c.relname IN ('inquiries', 'inquiry_requirements', 'inquiry_participants', 'inquiry_assignments');
    `);
    for (const row of forceRes.rows) {
      assert.strictEqual(row.relforcerowsecurity, true, `Table ${row.relname} must have FORCE ROW LEVEL SECURITY = true`);
    }

    const roleRes = await client.query(`
      SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('vind_db_owner', 'vind_migrator', 'vind_app_runtime');
    `);
    for (const row of roleRes.rows) {
      assert.strictEqual(row.rolbypassrls, false, `Role ${row.rolname} must have NOBYPASSRLS`);
    }
  });

  await t.test("IMMUTABLE SNAPSHOT: inquiry_requirements rejects UPDATE and DELETE", async () => {
    // Fetch an existing or create a dummy requirement record to test immutability
    const dummyInq = await client.query(`
      INSERT INTO engagement.inquiries (public_reference, requester_person_id, target_provider_profile_id, source_channel, status)
      SELECT 'INQ-TEST-IMMUTABLE', p.id, pr.id, 'VINDZAM', 'NEW'
      FROM party.persons p, provider.provider_profiles pr
      LIMIT 1
      RETURNING id;
    `);

    if (dummyInq.rows.length > 0) {
      const inqId = dummyInq.rows[0].id;
      const reqRes = await client.query(`
        INSERT INTO engagement.inquiry_requirements (inquiry_id, consumer_note, schema_version)
        VALUES ($1, 'Original note', 'v1')
        RETURNING id;
      `, [inqId]);
      const reqId = reqRes.rows[0].id;

      // Attempt UPDATE
      await assert.rejects(
        async () => {
          await client.query(`UPDATE engagement.inquiry_requirements SET consumer_note = 'Mutated note' WHERE id = $1;`, [reqId]);
        },
        (err: any) => err.message.includes("immutable") || err.code === "22023",
        "Should reject UPDATE on inquiry_requirements"
      );

      // Attempt DELETE
      await assert.rejects(
        async () => {
          await client.query(`DELETE FROM engagement.inquiry_requirements WHERE id = $1;`, [reqId]);
        },
        (err: any) => err.message.includes("immutable") || err.code === "22023",
        "Should reject DELETE on inquiry_requirements"
      );

      // Cleanup parent inquiry with override setting
      await client.query(`SELECT set_config('engagement.allow_requirement_delete', 'on', false);`);
      await client.query(`DELETE FROM engagement.inquiries WHERE id = $1;`, [inqId]);
      await client.query(`SELECT set_config('engagement.allow_requirement_delete', 'off', false);`);
    }
  });

  await t.test("SUBMIT & READ: Full inquiry submission and consumer/sahabat read flows", async () => {
    // Find valid seed entities
    const seedData = await client.query(`
      SELECT 
        p.id as person_id,
        p.seed_key as person_seed_key,
        cp.id as pub_id,
        cp.provider_profile_id,
        cp.channel_code,
        o.id as offering_id
      FROM party.persons p
      CROSS JOIN listing.channel_publications cp
      JOIN catalog.offerings o ON o.id = cp.offering_id
      WHERE cp.publication_status = 'PUBLISHED'
        AND cp.channel_code = 'VINDZAM'
      LIMIT 1;
    `);

    assert.ok(seedData.rows.length > 0, "Seed data for published target must exist");
    const { person_id, person_seed_key, pub_id, provider_profile_id, channel_code } = seedData.rows[0];

    const runtimeClient = new Client({ connectionString: runtimeUrl });
    await runtimeClient.connect();

    try {
      // Set session variables for consumer submit
      await runtimeClient.query(`
        SELECT set_config('app.actor_person_id', '${person_id}', false);
        SELECT set_config('app.actor_person_key', '${person_seed_key}', false);
        SELECT set_config('app.actor_account_key', 'acc_test_consumer', false);
        SELECT set_config('app.correlation_id', 'corr_block1b_test', false);
        SELECT set_config('app.request_id', 'req_block1b_test', false);
      `);

      const idempotencyKey = `idemp_submit_${Date.now()}`;
      const submitRes = await runtimeClient.query(`
        SELECT engagement.submit_inquiry(
          p_target_id => $1::uuid,
          p_channel_code => $2,
          p_consent_receipt_id => NULL,
          p_idempotency_key => $3,
          p_requested_start_at => '2026-09-01T10:00:00Z'::timestamptz,
          p_requested_end_at => '2026-09-02T10:00:00Z'::timestamptz,
          p_location_text => 'Sanur, Bali',
          p_geo_region_id => NULL,
          p_quantity => 2,
          p_consumer_note => 'Special request for afternoon setup',
          p_requirement_payload => '{"flexibility": "HIGH"}'::jsonb,
          p_commercial_ref => 'COMM_REF_123'
        ) as result;
      `, [pub_id, channel_code, idempotencyKey]);

      const inqResult = submitRes.rows[0].result;
      assert.ok(inqResult.id, "Submitted inquiry must return valid ID");
      assert.strictEqual(inqResult.status, "NEW", "Initial status must be NEW");
      assert.strictEqual(inqResult.source_channel, "VINDZAM", "Source channel must be VINDZAM");

      const inquiryId = inqResult.id;

      // Idempotency re-submit with same payload
      const retryRes = await runtimeClient.query(`
        SELECT engagement.submit_inquiry(
          p_target_id => $1::uuid,
          p_channel_code => $2,
          p_consent_receipt_id => NULL,
          p_idempotency_key => $3,
          p_requested_start_at => '2026-09-01T10:00:00Z'::timestamptz,
          p_requested_end_at => '2026-09-02T10:00:00Z'::timestamptz,
          p_location_text => 'Sanur, Bali',
          p_geo_region_id => NULL,
          p_quantity => 2,
          p_consumer_note => 'Special request for afternoon setup',
          p_requirement_payload => '{"flexibility": "HIGH"}'::jsonb,
          p_commercial_ref => 'COMM_REF_123'
        ) as result;
      `, [pub_id, channel_code, idempotencyKey]);
      assert.strictEqual(retryRes.rows[0].result.id, inquiryId, "Idempotent re-submission must return same inquiry ID");

      // Consumer Read Inquiry
      const readRes = await runtimeClient.query(`
        SELECT engagement.read_consumer_inquiry($1::uuid) as result;
      `, [inquiryId]);
      assert.strictEqual(readRes.rows[0].result.id, inquiryId);
      assert.strictEqual(readRes.rows[0].result.requirement.consumer_note, "Special request for afternoon setup");

      // Verify Audit Event does NOT leak consumer note in metadata
      const auditRes = await client.query(`
        SELECT metadata FROM audit.audit_events
        WHERE target_relation = 'inquiries' AND target_key = $1 AND event_type = 'INQUIRY_SUBMITTED';
      `, [inquiryId]);
      assert.strictEqual(auditRes.rows.length, 1, "Audit event must be logged");
      const metadata = auditRes.rows[0].metadata;
      assert.strictEqual(metadata.consumer_note, undefined, "Consumer note must NOT be present in audit log metadata");

      // Sahabat Activation & Assignment
      const sahabatAssRes = await client.query(`
        SELECT sa.seed_key, sa.subject_person_id, sa.role_code, sa.scope_type, sa.provider_id
        FROM access.scoped_assignments sa
        WHERE sa.provider_id = $1 AND sa.status = 'ACTIVE'
        LIMIT 1;
      `, [provider_profile_id]);

      assert.ok(sahabatAssRes.rows.length > 0, "Active scoped assignment for provider profile must exist");
      const sahabatAss = sahabatAssRes.rows[0];

      await runtimeClient.query(`
        SELECT set_config('app.context_initialized', 'true', false);
        SELECT set_config('app.context_version', '2', false);
        SELECT set_config('app.actor_kind', 'HUMAN', false);
        SELECT set_config('app.authority_plane', 'LOCAL', false);
        SELECT set_config('app.local_assignment_key', '${sahabatAss.seed_key}', false);
        SELECT set_config('app.actor_person_id', '${sahabatAss.subject_person_id}', false);
        SELECT set_config('app.actor_account_key', 'acc_test_sahabat', false);
        SELECT set_config('app.local_assignment_role_code', '${sahabatAss.role_code}', false);
        SELECT set_config('app.local_assignment_scope_type', '${sahabatAss.scope_type}', false);
        SELECT set_config('app.local_assignment_provider_profile_id', '${provider_profile_id}', false);
      `);

      const actRes = await runtimeClient.query(`
        SELECT engagement.activate_inquiry($1::uuid) as result;
      `, [inquiryId]);
      assert.strictEqual(actRes.rows[0].result.status, "ACTIVE");

      const assignRes = await runtimeClient.query(`
        SELECT engagement.assign_inquiry(
          p_inquiry_id => $1::uuid,
          p_assigned_person_id => $2::uuid,
          p_reason => 'Primary support assigned'
        ) as result;
      `, [inquiryId, person_id]);
      assert.strictEqual(assignRes.rows[0].result.status, "ACTIVE");

      // Close Inquiry
      const closeRes = await runtimeClient.query(`
        SELECT engagement.close_inquiry(p_inquiry_id => $1::uuid, p_reason => 'Fulfilled') as result;
      `, [inquiryId]);
      assert.strictEqual(closeRes.rows[0].result.status, "CLOSED");

      // Verify Terminal state transition rejection
      await assert.rejects(
        async () => {
          await runtimeClient.query(`SELECT engagement.activate_inquiry($1::uuid);`, [inquiryId]);
        },
        (err: any) => err.message.includes("STATE_CONFLICT"),
        "Activating a CLOSED inquiry must fail with STATE_CONFLICT"
      );

    } finally {
      await runtimeClient.end();
    }
  });

  await client.end();
});
