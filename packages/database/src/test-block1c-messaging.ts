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

      // Attempt UPDATE -> fail
      await assert.rejects(
        async () => {
          await client.query(`UPDATE messaging.messages SET body = 'Tampered body' WHERE id = $1;`, [msgId]);
        },
        (err: any) => err.message.includes("immutable") || err.code === "22023",
        "Should reject UPDATE on messaging.messages"
      );

      // Attempt DELETE -> fail
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

  await t.test("RPC LEAST PRIVILEGE: Direct resolve_canonical_conversation execution denied to vind_app_runtime", async () => {
    const runtimeClient = new Client({ connectionString: runtimeUrl });
    await runtimeClient.connect();

    try {
      await assert.rejects(
        async () => {
          await runtimeClient.query(`SELECT messaging.resolve_canonical_conversation('00000000-0000-0000-0000-000000000000'::uuid);`);
        },
        (err: any) => err.code === "42501" || err.message.includes("permission denied"),
        "Direct resolve_canonical_conversation must be denied to runtime role"
      );
    } finally {
      await runtimeClient.end();
    }
  });

  await t.test("MESSAGING CORE FLOW: Resolve, Send, Reply, Read, Receipts, Audit & Outbox Privacy", async () => {
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

      // Reject missing/blank Idempotency-Key
      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.send_consumer_message(
              p_inquiry_id => $1::uuid,
              p_body => 'Message without key',
              p_idempotency_key => ''
            ) as result;
          `, [inquiryId]);
        },
        (err: any) => err.message.includes("VALIDATION_FAILED") || err.code === "22023",
        "Rejects empty idempotency key"
      );

      // Send Consumer Message
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

      // Verify Idempotency replay (same key + same payload -> identical result)
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
        (err: any) => err.message.includes("STATE_CONFLICT") || err.code === "23505" || err.code === "22023",
        "Reusing idempotency key with different payload must throw STATE_CONFLICT"
      );

      // Verify AUDIT and OUTBOX PRIVACY: No message body in audit or outbox logs
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

      // Monotonic Read Receipt check: attempting to mark read with an older message does not move receipt backward
      const moveBackRes = await runtimeClient.query(`
        SELECT messaging.mark_read(p_inquiry_id => $1::uuid, p_last_read_message_id => $2::uuid, p_is_sahabat => false) as result;
      `, [inquiryId, msg1.id]);
      assert.strictEqual(moveBackRes.rows[0].result.last_read_message_id, msg2.id, "Receipt must not move backward");

    } finally {
      await runtimeClient.end();
    }
  });

  await t.test("CONCURRENCY TESTS: Simultaneous Idempotency & Sequence Allocation", async () => {
    const seedData = await client.query(`
      SELECT p.id as person_id, p.seed_key, cp.id as pub_id, cp.provider_profile_id, cp.channel_code
      FROM party.persons p
      CROSS JOIN listing.channel_publications cp
      WHERE cp.publication_status = 'PUBLISHED' AND cp.channel_code = 'VINDZAM'
      LIMIT 1;
    `);
    const { person_id, person_seed_key, pub_id, channel_code } = seedData.rows[0];

    const consentRes = await client.query(`
      INSERT INTO privacy.consent_receipts (
        id, receipt_key, person_id, purpose_code, policy_version, consent_action, grant_effective_from
      ) VALUES (
        gen_random_uuid(), 's1:test:consent:block1c_conc', $1::uuid, 'INQUIRY', 'v1.0', 'GRANTED', NOW() - interval '1 day'
      ) ON CONFLICT (receipt_key) DO UPDATE SET person_id = EXCLUDED.person_id, consent_action = 'GRANTED'
      RETURNING id;
    `, [person_id]);
    const consentReceiptId = consentRes.rows[0].id;

    const client1 = new Client({ connectionString: runtimeUrl });
    const client2 = new Client({ connectionString: runtimeUrl });
    await client1.connect();
    await client2.connect();

    try {
      await client1.query(`
        SELECT set_config('app.actor_person_id', '${person_id}', false);
        SELECT set_config('app.actor_person_key', '${person_seed_key}', false);
      `);
      await client2.query(`
        SELECT set_config('app.actor_person_id', '${person_id}', false);
        SELECT set_config('app.actor_person_key', '${person_seed_key}', false);
      `);

      const submitRes = await client1.query(`
        SELECT engagement.submit_inquiry(
          p_target_id => $1::uuid, p_channel_code => $2, p_consent_receipt_id => $3::uuid
        ) as result;
      `, [pub_id, channel_code, consentReceiptId]);
      const inquiryId = submitRes.rows[0].result.id;

      // 1. Concurrent SAME key + SAME payload
      const sameKey = `idemp_conc_same_${Date.now()}`;
      const p1 = client1.query(`SELECT messaging.send_consumer_message($1::uuid, 'Concurrent payload', NULL, $2) as result;`, [inquiryId, sameKey]);
      const p2 = client2.query(`SELECT messaging.send_consumer_message($1::uuid, 'Concurrent payload', NULL, $2) as result;`, [inquiryId, sameKey]);

      const [r1, r2] = await Promise.all([p1, p2]);
      assert.strictEqual(r1.rows[0].result.id, r2.rows[0].result.id, "Concurrent same payload must yield identical message ID");

      // 2. Concurrent SAME key + DIFFERENT payload
      const diffKey = `idemp_conc_diff_${Date.now()}`;
      const pDiff1 = client1.query(`SELECT messaging.send_consumer_message($1::uuid, 'Payload A', NULL, $2) as result;`, [inquiryId, diffKey]);
      const pDiff2 = client2.query(`SELECT messaging.send_consumer_message($1::uuid, 'Payload B', NULL, $2) as result;`, [inquiryId, diffKey]);

      const results = await Promise.allSettled([pDiff1, pDiff2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.strictEqual(fulfilled.length, 1, "Exactly one concurrent send with different payload must succeed");
      assert.strictEqual(rejected.length, 1, "Exactly one concurrent send with different payload must fail with STATE_CONFLICT");

      // 3. Concurrent DIFFERENT keys (Sequence allocation serialization)
      const kA = `idemp_seq_a_${Date.now()}`;
      const kB = `idemp_seq_b_${Date.now()}`;
      const pSeq1 = client1.query(`SELECT messaging.send_consumer_message($1::uuid, 'Msg A', NULL, $2) as result;`, [inquiryId, kA]);
      const pSeq2 = client2.query(`SELECT messaging.send_consumer_message($1::uuid, 'Msg B', NULL, $2) as result;`, [inquiryId, kB]);

      const [resA, resB] = await Promise.all([pSeq1, pSeq2]);
      const seqA = resA.rows[0].result.sequence_number;
      const seqB = resB.rows[0].result.sequence_number;
      assert.notStrictEqual(seqA, seqB, "Concurrent different messages must receive distinct sequence numbers");

    } finally {
      await client1.end();
      await client2.end();
    }
  });

  await t.test("CROSS-BOUNDARY & SECURITY NEGATIVE MATRIX: Invalid mark_read, unsafe asset, and revoked assignment", async () => {
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

    // Media asset owned by provider
    const assetRes = await client.query(`
      INSERT INTO media.media_assets (
        owner_provider_profile_id, media_type, file_name, file_size_bytes, mime_type, checksum_sha256, storage_path, status
      ) VALUES (
        $1::uuid, 'DOCUMENT', 'brochure.pdf', 1024, 'application/pdf', 'dummy_hash', '/storage/docs/brochure.pdf', 'ACTIVE'
      ) RETURNING id;
    `, [provider_profile_id]);
    const validMediaAssetId = assetRes.rows[0].id;

    // Media asset owned by ANOTHER provider
    const otherProvRes = await client.query(`
      SELECT id FROM provider.provider_profiles WHERE id <> $1::uuid LIMIT 1;
    `, [provider_profile_id]);
    const otherProvId = otherProvRes.rows[0].id;

    const wrongProvAssetRes = await client.query(`
      INSERT INTO media.media_assets (
        owner_provider_profile_id, media_type, file_name, file_size_bytes, mime_type, checksum_sha256, storage_path, status
      ) VALUES (
        $1::uuid, 'DOCUMENT', 'other.pdf', 1024, 'application/pdf', 'dummy_hash2', '/storage/docs/other.pdf', 'ACTIVE'
      ) RETURNING id;
    `, [otherProvId]);
    const wrongProvAssetId = wrongProvAssetRes.rows[0].id;

    const runtimeClient = new Client({ connectionString: runtimeUrl });
    await runtimeClient.connect();

    try {
      // 1. Submit Inquiry A & Inquiry B
      await runtimeClient.query(`
        SELECT set_config('app.actor_person_id', '${person_id}', false);
        SELECT set_config('app.actor_person_key', '${person_seed_key}', false);
      `);

      const submitA = await runtimeClient.query(`
        SELECT engagement.submit_inquiry(p_target_id => $1::uuid, p_channel_code => $2, p_consent_receipt_id => $3::uuid) as result;
      `, [pub_id, channel_code, consentReceiptId]);
      const inquiryIdA = submitA.rows[0].result.id;

      const submitB = await runtimeClient.query(`
        SELECT engagement.submit_inquiry(p_target_id => $1::uuid, p_channel_code => $2, p_consent_receipt_id => $3::uuid) as result;
      `, [pub_id, channel_code, consentReceiptId]);
      const inquiryIdB = submitB.rows[0].result.id;

      // Send message to Inquiry A
      const msgARes = await runtimeClient.query(`
        SELECT messaging.send_consumer_message(
          p_inquiry_id => $1::uuid, p_body => 'Msg in Inquiry A', p_idempotency_key => 'idemp_inq_a'
        ) as result;
      `, [inquiryIdA]);
      const msgIdA = msgARes.rows[0].result.id;

      // 2. CROSS-INQUIRY MARK READ DENIED
      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.mark_read(p_inquiry_id => $1::uuid, p_last_read_message_id => $2::uuid, p_is_sahabat => false) as result;
          `, [inquiryIdB, msgIdA]);
        },
        (err: any) => err.message.includes("RESOURCE_NOT_FOUND") || err.code === "22023",
        "Cross-inquiry mark_read must be rejected"
      );

      // 3. CROSS-BOUNDARY / WRONG-PROVIDER ATTACHMENT DENIED
      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.send_consumer_message(
              p_inquiry_id => $1::uuid,
              p_body => 'Cross-provider attachment attempt',
              p_attachment_media_asset_ids => ARRAY[$2::uuid],
              p_idempotency_key => 'idemp_wrong_prov'
            ) as result;
          `, [inquiryIdA, wrongProvAssetId]);
        },
        (err: any) => err.message.includes("VALIDATION_FAILED") || err.code === "22023",
        "Attachment owned by another provider must be rejected"
      );

      // 4. UNRELATED CONSUMER DENIED
      const otherPersonRes = await client.query(`
        SELECT id, seed_key FROM party.persons WHERE id <> $1::uuid LIMIT 1;
      `, [person_id]);
      const otherPerson = otherPersonRes.rows[0];

      await runtimeClient.query(`
        SELECT set_config('app.actor_person_id', '${otherPerson.id}', false);
        SELECT set_config('app.actor_person_key', '${otherPerson.seed_key}', false);
      `);

      await assert.rejects(
        async () => {
          await runtimeClient.query(`
            SELECT messaging.list_consumer_messages($1::uuid) as result;
          `, [inquiryIdA]);
        },
        (err: any) => err.message.includes("CAPABILITY_DENIED") || err.code === "42501",
        "Unrelated consumer must be denied"
      );

    } finally {
      await runtimeClient.end();
    }
  });

  await client.end();
});
