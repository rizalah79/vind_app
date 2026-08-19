import assert from "node:assert";
import { test } from "node:test";
import { Client } from "pg";

const connectionString = process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;

if (!connectionString || !runtimeUrl) {
  throw new Error("DATABASE_MIGRATION_URL and DATABASE_URL environment variables are strictly required for Block 1C DB Acceptance Test.");
}

function assertIsolatedAcceptanceDb(urlStr: string, label: string) {
  const parsed = new URL(urlStr);
  const port = parsed.port || "5432";
  const dbName = parsed.pathname.replace(/^\//, "");

  if (port === "5432" || dbName === "vind_app_dev") {
    throw new Error(`SECURITY INCIDENT PREVENTION: ${label} must target an isolated acceptance database on a non-5432 port and non-dev database. Received port=${port}, db=${dbName}`);
  }
}

assertIsolatedAcceptanceDb(connectionString, "DATABASE_MIGRATION_URL");
assertIsolatedAcceptanceDb(runtimeUrl, "DATABASE_URL");

test("BLOCK 1C DB ACCEPTANCE: MESSAGING CORE MATRIX", async (t) => {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("SET ROLE vind_db_owner;");

  await t.test("STRUCTURAL: Schema messaging tables, RLS=true, FORCE RLS=true, NOBYPASSRLS", async () => {
    const res = await client.query(`
      SELECT table_name, rowsecurity
      FROM information_schema.tables t
      JOIN pg_tables p ON p.tablename = t.table_name AND p.schemaname = t.table_schema
      WHERE t.table_schema = 'messaging'
        AND t.table_name IN ('conversations', 'conversation_participants', 'messages', 'message_attachments', 'message_receipts');
    `);
    assert.strictEqual(res.rows.length, 5, "Should have 5 canonical messaging tables");
    for (const row of res.rows) {
      assert.strictEqual(row.rowsecurity, true, `Table ${row.table_name} must have ROW LEVEL SECURITY = true`);
    }

    const forceRes = await client.query(`
      SELECT c.relname, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'messaging'
        AND c.relname IN ('conversations', 'conversation_participants', 'messages', 'message_attachments', 'message_receipts');
    `);
    assert.strictEqual(forceRes.rows.length, 5, "Should return 5 tables for FORCE RLS check");
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

  await t.test("IMMUTABLE MESSAGES: messaging.messages rejects UPDATE and DELETE", async () => {
    // Create a dummy inquiry and conversation via owner
    const dummyInq = await client.query(`
      INSERT INTO engagement.inquiries (public_reference, requester_person_id, target_provider_profile_id, source_channel, status)
      SELECT 'INQ-MSG-IMMUTABLE-TEST', p.id, pr.id, 'VINDZAM', 'NEW'
      FROM party.persons p, provider.provider_profiles pr
      LIMIT 1
      RETURNING id, requester_person_id;
    `);

    if (dummyInq.rows.length > 0) {
      const inqId = dummyInq.rows[0].id;
      const convRes = await client.query(`
        INSERT INTO messaging.conversations (inquiry_id, status) VALUES ($1, 'ACTIVE') RETURNING id;
      `, [inqId]);
      const convId = convRes.rows[0].id;

      const msgRes = await client.query(`
        INSERT INTO messaging.messages (conversation_id, sender_participant_type, sender_person_id, body, sequence_number)
        VALUES ($1, 'CONSUMER', $2, 'Immutable test message', 1)
        RETURNING id;
      `, [convId, dummyInq.rows[0].requester_person_id]);
      const msgId = msgRes.rows[0].id;

      // Attempt UPDATE
      await assert.rejects(
        async () => {
          await client.query(`UPDATE messaging.messages SET body = 'Tampered body' WHERE id = $1;`, [msgId]);
        },
        (err: any) => err.message.includes("immutable") || err.code === "22023",
        "Should reject UPDATE on messaging.messages"
      );

      // Attempt DELETE
      await assert.rejects(
        async () => {
          await client.query(`DELETE FROM messaging.messages WHERE id = $1;`, [msgId]);
        },
        (err: any) => err.message.includes("immutable") || err.code === "22023",
        "Should reject DELETE on messaging.messages"
      );

      // Cleanup
      await client.query(`SELECT set_config('messaging.allow_message_delete', 'on', false);`);
      await client.query(`SELECT set_config('engagement.allow_requirement_delete', 'on', false);`);
      await client.query(`DELETE FROM messaging.conversations WHERE id = $1;`, [convId]);
      await client.query(`DELETE FROM engagement.inquiries WHERE id = $1;`, [inqId]);
      await client.query(`SELECT set_config('messaging.allow_message_delete', 'off', false);`);
      await client.query(`SELECT set_config('engagement.allow_requirement_delete', 'off', false);`);
    }
  });

  await t.test("MESSAGING CORE FLOW: Resolve, Send, Reply, Read, Receipts, Audit & Outbox Privacy", async () => {
    // 1. Fetch seed entities
    const seedData = await client.query(`
      SELECT 
        p.id as person_id,
        p.seed_key as person_seed_key,
        cp.id as pub_id,
        cp.provider_profile_id,
        cp.channel_code
      FROM party.persons p
      CROSS JOIN listing.channel_publications cp
      WHERE cp.publication_status = 'PUBLISHED' AND cp.channel_code = 'VINDZAM'
      LIMIT 1;
    `);
    assert.ok(seedData.rows.length > 0, "Seed data must exist");
    const { person_id, person_seed_key, pub_id, provider_profile_id, channel_code } = seedData.rows[0];

    const consentRes = await client.query(`
      INSERT INTO privacy.consent_receipts (
        id, receipt_key, person_id, purpose_code, policy_version, consent_action, grant_effective_from
      ) VALUES (
        gen_random_uuid(), 's1:test:consent:block1c_db', $1::uuid, 'INQUIRY', 'v1.0', 'GRANTED', NOW() - interval '1 day'
      ) ON CONFLICT (receipt_key) DO UPDATE SET person_id = EXCLUDED.person_id, consent_action = 'GRANTED'
      RETURNING id;
    `, [person_id]);
    const consentReceiptId = consentRes.rows[0].id;

    const runtimeClient = new Client({ connectionString: runtimeUrl });
    await runtimeClient.connect();

    try {
      // Consumer submits an inquiry
      await runtimeClient.query(`
        SELECT set_config('app.actor_person_id', '${person_id}', false);
        SELECT set_config('app.actor_person_key', '${person_seed_key}', false);
        SELECT set_config('app.actor_account_key', 'acc_test_consumer_msg', false);
        SELECT set_config('app.correlation_id', 'corr_block1c_test', false);
        SELECT set_config('app.request_id', 'req_block1c_test', false);
      `);

      const submitRes = await runtimeClient.query(`
        SELECT engagement.submit_inquiry(
          p_target_id => $1::uuid,
          p_channel_code => $2,
          p_consent_receipt_id => $3::uuid,
          p_idempotency_key => $4
        ) as result;
      `, [pub_id, channel_code, consentReceiptId, `idemp_inq_msg_${Date.now()}`]);
      const inquiryId = submitRes.rows[0].result.id;

      // Consumer sends a message
      const sendConsumerRes = await runtimeClient.query(`
        SELECT messaging.send_consumer_message(
          p_inquiry_id => $1::uuid,
          p_body => 'Hello Sahabat, I need more info about the package.',
          p_idempotency_key => 'idemp_consumer_msg_1'
        ) as result;
      `, [inquiryId]);

      const msg1 = sendConsumerRes.rows[0].result;
      assert.ok(msg1.id, "Sent message must return valid ID");
      assert.strictEqual(msg1.sender_participant_type, "CONSUMER");
      assert.strictEqual(msg1.body, "Hello Sahabat, I need more info about the package.");
      assert.strictEqual(msg1.sequence_number, 1);

      // Verify Idempotency (same key + same payload -> same result)
      const sendConsumerRetryRes = await runtimeClient.query(`
        SELECT messaging.send_consumer_message(
          p_inquiry_id => $1::uuid,
          p_body => 'Hello Sahabat, I need more info about the package.',
          p_idempotency_key => 'idemp_consumer_msg_1'
        ) as result;
      `, [inquiryId]);
      assert.strictEqual(sendConsumerRetryRes.rows[0].result.id, msg1.id, "Idempotent send must return identical message ID");

      // Verify Idempotency Conflict (same key + different body -> STATE_CONFLICT)
      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.send_consumer_message(
              p_inquiry_id => $1::uuid,
              p_body => 'Different body content with same key',
              p_idempotency_key => 'idemp_consumer_msg_1'
            ) as result;
          `, [inquiryId]);
        },
        (err: any) => err.message.includes("STATE_CONFLICT") || err.code === "22023",
        "Reusing idempotency key with different payload must throw STATE_CONFLICT"
      );

      // Verify AUDIT and OUTBOX PRIVACY: No body in audit or outbox logs!
      const auditRes = await client.query(`
        SELECT metadata FROM audit.audit_events
        WHERE target_relation = 'messages' AND target_key = $1 AND event_type = 'MESSAGE_SENT';
      `, [msg1.id]);
      assert.strictEqual(auditRes.rows.length, 1, "Audit event for message send must exist");
      const auditMetaStr = JSON.stringify(auditRes.rows[0].metadata);
      assert.strictEqual(auditMetaStr.includes("Hello Sahabat"), false, "Audit event metadata MUST NOT contain message body");

      const outboxRes = await client.query(`
        SELECT payload FROM integration.outbox_events
        WHERE aggregate_type = 'conversations' AND event_type = 'messaging.message_sent' AND payload->>'message_id' = $1;
      `, [msg1.id]);
      assert.strictEqual(outboxRes.rows.length, 1, "Outbox event for message send must exist");
      const outboxPayloadStr = JSON.stringify(outboxRes.rows[0].payload);
      assert.strictEqual(outboxPayloadStr.includes("Hello Sahabat"), false, "Outbox payload MUST NOT contain message body");

      // Sahabat reads message and sends reply
      const sahabatAssRes = await client.query(`
        SELECT sa.seed_key, sa.subject_person_id, sa.role_code, sa.scope_type
        FROM access.scoped_assignments sa
        WHERE sa.provider_id = $1 AND sa.status = 'ACTIVE'
        LIMIT 1;
      `, [provider_profile_id]);
      assert.ok(sahabatAssRes.rows.length > 0, "Sahabat assignment must exist");
      const sahabatAss = sahabatAssRes.rows[0];

      await runtimeClient.query(`
        SELECT set_config('app.context_initialized', 'true', false);
        SELECT set_config('app.context_version', '2', false);
        SELECT set_config('app.actor_kind', 'HUMAN', false);
        SELECT set_config('app.authority_plane', 'LOCAL', false);
        SELECT set_config('app.local_assignment_key', '${sahabatAss.seed_key}', false);
        SELECT set_config('app.actor_person_id', '${sahabatAss.subject_person_id}', false);
        SELECT set_config('app.actor_account_key', 'acc_test_sahabat_msg', false);
        SELECT set_config('app.local_assignment_role_code', '${sahabatAss.role_code}', false);
        SELECT set_config('app.local_assignment_scope_type', '${sahabatAss.scope_type}', false);
        SELECT set_config('app.local_assignment_provider_profile_id', '${provider_profile_id}', false);
      `);

      const sahabatListRes = await runtimeClient.query(`
        SELECT messaging.list_sahabat_messages(p_inquiry_id => $1::uuid) as result;
      `, [inquiryId]);
      const list1 = sahabatListRes.rows[0].result;
      assert.strictEqual(list1.length, 1);
      assert.strictEqual(list1[0].id, msg1.id);

      const sendSahabatRes = await runtimeClient.query(`
        SELECT messaging.send_sahabat_message(
          p_inquiry_id => $1::uuid,
          p_body => 'Hello! We would be happy to help with your inquiry.',
          p_idempotency_key => 'idemp_sahabat_msg_1'
        ) as result;
      `, [inquiryId]);
      const msg2 = sendSahabatRes.rows[0].result;
      assert.strictEqual(msg2.sender_participant_type, "PROVIDER");
      assert.strictEqual(msg2.sequence_number, 2);

      // Sahabat marks read
      const markReadRes = await runtimeClient.query(`
        SELECT messaging.mark_read(p_inquiry_id => $1::uuid, p_last_read_message_id => $2::uuid, p_is_sahabat => true) as result;
      `, [inquiryId, msg1.id]);
      assert.strictEqual(markReadRes.rows[0].result.last_read_message_id, msg1.id);

      // Consumer reads list and marks read
      await runtimeClient.query(`
        SELECT set_config('app.actor_person_id', '${person_id}', false);
        SELECT set_config('app.actor_person_key', '${person_seed_key}', false);
        SELECT set_config('app.actor_account_key', 'acc_test_consumer_msg', false);
      `);

      const consumerListRes = await runtimeClient.query(`
        SELECT messaging.list_consumer_messages(p_inquiry_id => $1::uuid) as result;
      `, [inquiryId]);
      assert.strictEqual(consumerListRes.rows[0].result.length, 2);

      const consumerMarkReadRes = await runtimeClient.query(`
        SELECT messaging.mark_read(p_inquiry_id => $1::uuid, p_last_read_message_id => $2::uuid, p_is_sahabat => false) as result;
      `, [inquiryId, msg2.id]);
      assert.strictEqual(consumerMarkReadRes.rows[0].result.last_read_message_id, msg2.id);

    } finally {
      await runtimeClient.end();
    }
  });

  await t.test("ATTACHMENT & SECURITY NEGATIVE MATRIX: Unauthorized access, invalid attachments, and terminal state", async () => {
    const seedData = await client.query(`
      SELECT p.id as person_id, p.seed_key, cp.id as pub_id, cp.provider_profile_id, cp.channel_code
      FROM party.persons p
      CROSS JOIN listing.channel_publications cp
      WHERE cp.publication_status = 'PUBLISHED' AND cp.channel_code = 'VINDZAM'
      LIMIT 1;
    `);
    const { person_id, person_seed_key, pub_id, provider_profile_id, channel_code } = seedData.rows[0];

    const consentRes = await client.query(`
      INSERT INTO privacy.consent_receipts (
        id, receipt_key, person_id, purpose_code, policy_version, consent_action, grant_effective_from
      ) VALUES (
        gen_random_uuid(), 's1:test:consent:block1c_neg', $1::uuid, 'INQUIRY', 'v1.0', 'GRANTED', NOW() - interval '1 day'
      ) ON CONFLICT (receipt_key) DO UPDATE SET person_id = EXCLUDED.person_id, consent_action = 'GRANTED'
      RETURNING id;
    `, [person_id]);
    const consentReceiptId = consentRes.rows[0].id;

    // Seed a valid media asset for provider
    const assetRes = await client.query(`
      INSERT INTO media.media_assets (
        owner_provider_profile_id, media_type, file_name, file_size_bytes, mime_type, checksum_sha256, storage_path, status
      ) VALUES (
        $1::uuid, 'DOCUMENT', 'brochure.pdf', 1024, 'application/pdf', 'dummy_hash', '/storage/docs/brochure.pdf', 'ACTIVE'
      ) RETURNING id;
    `, [provider_profile_id]);
    const validMediaAssetId = assetRes.rows[0].id;

    const runtimeClient = new Client({ connectionString: runtimeUrl });
    await runtimeClient.connect();

    try {
      // 1. Submit Inquiry as Consumer 1
      await runtimeClient.query(`
        SELECT set_config('app.actor_person_id', '${person_id}', false);
        SELECT set_config('app.actor_person_key', '${person_seed_key}', false);
        SELECT set_config('app.actor_account_key', 'acc_test_c1', false);
      `);

      const submitRes = await runtimeClient.query(`
        SELECT engagement.submit_inquiry(
          p_target_id => $1::uuid, p_channel_code => $2, p_consent_receipt_id => $3::uuid
        ) as result;
      `, [pub_id, channel_code, consentReceiptId]);
      const inquiryId = submitRes.rows[0].result.id;

      // 2. Consumer sends message with VALID attachment link
      const attachMsgRes = await runtimeClient.query(`
        SELECT messaging.send_consumer_message(
          p_inquiry_id => $1::uuid,
          p_body => 'Sending attachment document',
          p_attachment_media_asset_ids => ARRAY[$2::uuid]
        ) as result;
      `, [inquiryId, validMediaAssetId]);
      assert.strictEqual(attachMsgRes.rows[0].result.message_type, "ATTACHMENT");
      assert.strictEqual(attachMsgRes.rows[0].result.attachments.length, 1);
      assert.strictEqual(attachMsgRes.rows[0].result.attachments[0].media_asset_id, validMediaAssetId);

      // 3. Try sending message with INVALID non-existent media asset -> VALIDATION_FAILED
      const bogusAssetId = "99999999-9999-9999-9999-999999999999";
      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.send_consumer_message(
              p_inquiry_id => $1::uuid,
              p_body => 'Bogus attachment attempt',
              p_attachment_media_asset_ids => ARRAY[$2::uuid]
            ) as result;
          `, [inquiryId, bogusAssetId]);
        },
        (err: any) => err.message.includes("VALIDATION_FAILED") || err.code === "22023",
        "Should reject invalid media asset ID"
      );

      // 4. UNAUTHENTICATED / OTHER CONSUMER ACCESS DENIED
      const otherPersonRes = await client.query(`
        SELECT id, seed_key FROM party.persons WHERE id <> $1::uuid LIMIT 1;
      `, [person_id]);
      assert.ok(otherPersonRes.rows.length > 0, "Other person entity must exist");
      const otherPerson = otherPersonRes.rows[0];

      await runtimeClient.query(`
        SELECT set_config('app.actor_person_id', '${otherPerson.id}', false);
        SELECT set_config('app.actor_person_key', '${otherPerson.seed_key}', false);
        SELECT set_config('app.actor_account_key', 'acc_test_unrelated_consumer', false);
      `);

      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.list_consumer_messages($1::uuid) as result;
          `, [inquiryId]);
        },
        (err: any) => err.message.includes("CAPABILITY_DENIED") || err.code === "42501",
        "Unrelated consumer must be denied read access"
      );

      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.send_consumer_message(p_inquiry_id => $1::uuid, p_body => 'Unauthorized send attempt') as result;
          `, [inquiryId]);
        },
        (err: any) => err.message.includes("CAPABILITY_DENIED") || err.code === "42501",
        "Unrelated consumer must be denied send access"
      );

      // 5. TERMINAL INQUIRY BEHAVIOR
      // Cancel inquiry as Consumer 1
      await runtimeClient.query(`
        SELECT set_config('app.actor_person_id', '${person_id}', false);
        SELECT set_config('app.actor_person_key', '${person_seed_key}', false);
      `);

      await runtimeClient.query(`
        SELECT engagement.cancel_inquiry(p_inquiry_id => $1::uuid, p_reason => 'Cancelled test') as result;
      `, [inquiryId]);

      // Attempt to send message to CANCELLED inquiry -> STATE_CONFLICT
      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.send_consumer_message(p_inquiry_id => $1::uuid, p_body => 'Post-cancellation message') as result;
          `, [inquiryId]);
        },
        (err: any) => err.message.includes("STATE_CONFLICT") || err.code === "22023",
        "Sending message to CANCELLED inquiry must throw STATE_CONFLICT"
      );

    } finally {
      await runtimeClient.end();
    }
  });

  await client.end();
});
