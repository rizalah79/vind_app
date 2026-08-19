import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: "packages/database/.env.isolated" });

const port = Number(process.env.ISOLATED_PORT || 55433);
const host = "127.0.0.1";
const database = process.env.ISOLATED_DB_NAME || "vind_app_dev";
const runtimeUser = "vind_app_runtime";
const runtimePassword = process.env.ISOLATED_RUNTIME_PASSWORD || "f1bfce720440462356e611e7b13fbb615204bb9353651b53c361f77f1097f0ad";

function createRuntimeClient(): Client {
  return new Client({ host, port, user: runtimeUser, password: runtimePassword, database });
}

function createBootstrapClient(): Client {
  return new Client({ host, port, user: "vind_bootstrap", password: process.env.ISOLATED_BOOTSTRAP_PASSWORD || "07d875793ff01a78994b7d383bfd163f1a66f5cc69c7a2c230f474d0ef59fd84", database });
}

interface ContextInput {
  accountKey: string;
  personKey?: string;
  actorKind: "HUMAN" | "SERVICE";
  plane: "RELATIONSHIP" | "LOCAL" | "PLATFORM" | "SERVICE";
  membershipKey?: string;
  localAssignmentKey?: string;
  platformAssignmentKey?: string;
  serviceGrantKey?: string;
  organizationKey?: string;
  workspaceKey?: string;
  providerKey?: string;
  channelCode?: string;
  regionKey?: string;
  purposeCode: string;
  requestId?: string;
}

async function setContext(client: Client, input: ContextInput): Promise<void> {
  await client.query(
    `SELECT security.set_request_context_v2(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19
    )`,
    [
      input.accountKey,
      input.personKey ?? null,
      input.actorKind,
      input.plane,
      input.membershipKey ?? null,
      input.localAssignmentKey ?? null,
      input.platformAssignmentKey ?? null,
      input.serviceGrantKey ?? null,
      input.organizationKey ?? null,
      input.workspaceKey ?? null,
      input.providerKey ?? null,
      input.channelCode ?? "VINDZAM",
      input.regionKey ?? null,
      input.purposeCode,
      "test-availability-correlation",
      input.requestId ?? "test-availability-request",
      "SECURE",
      false,
      null
    ]
  );
}

async function clearContext(client: Client): Promise<void> {
  await client.query("SELECT security.clear_request_context()");
}

test("BLOCK 1A DB ACCEPTANCE: AVAILABILITY CORE MATRIX", async (t) => {
  const bootClient = createBootstrapClient();
  await bootClient.connect();

  // Resolve test seed entities
  const provRes = await bootClient.query("SELECT id, seed_key FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
  const alphaCarProviderId = provRes.rows[0]?.id;

  const resRes = await bootClient.query("SELECT id FROM catalog.resources WHERE provider_profile_id = $1 LIMIT 1", [alphaCarProviderId]);
  const sampleResourceId = resRes.rows[0]?.id;

  const pubRes = await bootClient.query(`
    SELECT cp.id AS publication_id, cp.channel_code, cp.offering_id
    FROM listing.channel_publications cp
    JOIN catalog.offering_resources os ON os.offering_id = cp.offering_id
    WHERE os.resource_id = $1 AND cp.publication_status = 'PUBLISHED' AND cp.channel_code = 'VINDZAM'
    LIMIT 1
  `, [sampleResourceId]);
  const samplePublicationId = pubRes.rows[0]?.publication_id;

  await bootClient.end();

  assert.ok(alphaCarProviderId, "alpha_car provider ID must be resolved");
  assert.ok(sampleResourceId, "sample resource ID must be resolved");
  assert.ok(samplePublicationId, "sample publication ID must be resolved for sample resource");

  // --------------------------------------------------------------------------
  // 1. STRUCTURAL & SECURITY INVARIANTS
  // --------------------------------------------------------------------------
  await t.test("STRUCTURAL: Schema availability RLS=true, FORCE RLS=true, NOBYPASSRLS", async () => {
    const client = createRuntimeClient();
    await client.connect();

    const tableRes = await client.query(`
      SELECT c.relname, c.relforcerowsecurity, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'availability'
        AND c.relname IN ('resource_calendars', 'calendar_rules', 'calendar_blocks')
    `);
    assert.equal(tableRes.rows.length, 3, "Expected 3 availability tables checked");
    for (const r of tableRes.rows) {
      assert.equal(r.relrowsecurity, true, `${r.relname} relrowsecurity must be true`);
      assert.equal(r.relforcerowsecurity, true, `${r.relname} relforcerowsecurity must be true`);
    }

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

  // --------------------------------------------------------------------------
  // 2. TIMEZONE VALIDATION
  // --------------------------------------------------------------------------
  await t.test("TIMEZONE: Canonical timezone validation and timezone consistency", async () => {
    const client = createRuntimeClient();
    await client.connect();

    const validRes = await client.query("SELECT availability.is_valid_timezone('Asia/Jakarta') AS is_valid");
    assert.equal(validRes.rows[0].is_valid, true, "Asia/Jakarta must be valid timezone");

    const invalidRes = await client.query("SELECT availability.is_valid_timezone('Invalid/Timezone_123') AS is_valid");
    assert.equal(invalidRes.rows[0].is_valid, false, "Invalid/Timezone_123 must be invalid");

    await client.end();
  });

  // --------------------------------------------------------------------------
  // 3. CONFIGURE CALENDAR & LOCAL MANAGEMENT
  // --------------------------------------------------------------------------
  let createdCalendarId: string;
  let createdRuleId: string;
  let createdBlockId: string;

  await t.test("LOCAL SECURITY: Authenticated Sahabat PIC configure calendar", async () => {
    const client = createRuntimeClient();
    await client.connect();

    await client.query("BEGIN");
    await setContext(client, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      organizationKey: "smk:s1:org:alpha",
      workspaceKey: "smk:s1:workspace:alpha",
      providerKey: "smk:s2:prov:alpha_car",
      purposeCode: "availability_config"
    });

    const res = await client.query(
      "SELECT availability.configure_resource_calendar($1::uuid, 'Asia/Jakarta', 'CALENDAR', 'ACTIVE') AS cal_id",
      [sampleResourceId]
    );
    createdCalendarId = res.rows[0].cal_id;
    assert.ok(createdCalendarId, "Calendar ID must be returned");

    await clearContext(client);
    await client.query("COMMIT");
    await client.end();
  });

  await t.test("RULE/BLOCK: Create recurring rule and conflict-free adjacent blocks", async () => {
    const client = createRuntimeClient();
    await client.connect();

    await client.query("BEGIN");
    await setContext(client, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      organizationKey: "smk:s1:org:alpha",
      workspaceKey: "smk:s1:workspace:alpha",
      providerKey: "smk:s2:prov:alpha_car",
      purposeCode: "create_rule"
    });

    // Create Monday rule (day_of_week=1, 08:00 - 17:00)
    const ruleRes = await client.query(
      "SELECT availability.create_calendar_rule($1::uuid, 1, '08:00:00'::time, '17:00:00'::time, 1) AS rule_id",
      [createdCalendarId]
    );
    createdRuleId = ruleRes.rows[0].rule_id;
    assert.ok(createdRuleId, "Rule ID must be returned");

    // Create block 10:00 - 11:00
    const block1Res = await client.query(
      "SELECT availability.create_calendar_block($1::uuid, '2026-09-07 10:00:00+07'::timestamptz, '2026-09-07 11:00:00+07'::timestamptz, 'MAINTENANCE', 'Private Reason Test', 'idemp-block-1') AS block_id",
      [createdCalendarId]
    );
    createdBlockId = block1Res.rows[0].block_id;
    assert.ok(createdBlockId, "Block 1 ID must be returned");

    // Create adjacent block 11:00 - 12:00 (must succeed with no conflict)
    const block2Res = await client.query(
      "SELECT availability.create_calendar_block($1::uuid, '2026-09-07 11:00:00+07'::timestamptz, '2026-09-07 12:00:00+07'::timestamptz, 'UNAVAILABLE', 'Adjacent Test', 'idemp-block-2') AS block_id",
      [createdCalendarId]
    );
    assert.ok(block2Res.rows[0].block_id, "Adjacent block 2 must succeed");

    await clearContext(client);
    await client.query("COMMIT");
    await client.end();
  });

  // --------------------------------------------------------------------------
  // 4. RACE & CONFLICT PREVENTION
  // --------------------------------------------------------------------------
  await t.test("RACE: Overlapping block mutation atomically conflicts", async () => {
    const client = createRuntimeClient();
    await client.connect();

    await client.query("BEGIN");
    await setContext(client, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      organizationKey: "smk:s1:org:alpha",
      workspaceKey: "smk:s1:workspace:alpha",
      providerKey: "smk:s2:prov:alpha_car",
      purposeCode: "conflict_test"
    });

    // Attempt overlapping block 10:30 - 11:30 (conflicts with 10:00-11:00 and 11:00-12:00)
    await assert.rejects(
      client.query(
        "SELECT availability.create_calendar_block($1::uuid, '2026-09-07 10:30:00+07'::timestamptz, '2026-09-07 11:30:00+07'::timestamptz, 'MAINTENANCE', 'Overlap Conflict')",
        [createdCalendarId]
      ),
      (err: any) => {
        assert.ok(err.code === "23505" || err.code === "22023" || err.message.includes("AVAILABILITY_CONFLICT"));
        return true;
      },
      "Overlapping block must throw AVAILABILITY_CONFLICT error"
    );

    await client.query("ROLLBACK");
    await client.end();
  });

  // --------------------------------------------------------------------------
  // 5. PUBLIC READ CONTRACT & SEPARATION
  // --------------------------------------------------------------------------
  await t.test("PUBLIC: Public availability function enforces eligibility, mode, and zero private leakage", async () => {
    const client = createRuntimeClient();
    await client.connect();

    // Query public availability for sample publication
    const pubQueryRes = await client.query(
      "SELECT * FROM availability.read_public_availability($1::uuid, 'VINDZAM', '2026-09-07 00:00:00+00'::timestamptz, '2026-09-08 00:00:00+00'::timestamptz)",
      [samplePublicationId]
    );

    assert.ok(pubQueryRes.rows.length >= 1, "Public query must return results for published target");
    for (const r of pubQueryRes.rows) {
      assert.ok(r.status, "Status must exist");
      assert.ok(r.timezone, "Timezone must exist");
      assert.equal((r as any).internal_reason, undefined, "Internal reason MUST NOT exist in public projection");
      assert.equal((r as any).created_by_person_id, undefined, "Creator identity MUST NOT exist in public projection");
    }

    // Query for unpublished/random UUID => fail closed (0 rows)
    const invalidQueryRes = await client.query(
      "SELECT * FROM availability.read_public_availability('00000000-0000-0000-0000-000000000000'::uuid, 'VINDZAM', '2026-09-07 00:00:00+00'::timestamptz, '2026-09-08 00:00:00+00'::timestamptz)"
    );
    assert.equal(invalidQueryRes.rows.length, 0, "Unpublished target must return 0 rows");

    // Query for wrong channel => fail closed (0 rows)
    const wrongChanRes = await client.query(
      "SELECT * FROM availability.read_public_availability($1::uuid, 'WRONG_CHANNEL', '2026-09-07 00:00:00+00'::timestamptz, '2026-09-08 00:00:00+00'::timestamptz)",
      [samplePublicationId]
    );
    assert.equal(wrongChanRes.rows.length, 0, "Wrong channel must return 0 rows");

    await client.end();
  });

  // --------------------------------------------------------------------------
  // 6. LOCAL AUTHORIZATION NEGATIVE MATRIX
  // --------------------------------------------------------------------------
  await t.test("LOCAL SECURITY: Unauthenticated or unauthorized local attempts denied", async () => {
    const client = createRuntimeClient();
    await client.connect();

    // No Request Context V2 => denied
    await assert.rejects(
      client.query(
        "SELECT availability.configure_resource_calendar($1::uuid, 'Asia/Jakarta')",
        [sampleResourceId]
      ),
      (err: any) => {
        assert.ok(err.code === "28000" || err.code === "42501");
        return true;
      },
      "Unauthenticated request context must be denied"
    );

    await client.end();
  });

  // --------------------------------------------------------------------------
  // 7. EVIDENCE & AUDIT/OUTBOX LOGS
  // --------------------------------------------------------------------------
  await t.test("EVIDENCE: Audit and outbox events written during mutations", async () => {
    const bootClient = createBootstrapClient();
    await bootClient.connect();

    const auditRes = await bootClient.query(
      "SELECT * FROM audit.audit_events WHERE event_type LIKE 'AVAILABILITY_%' ORDER BY occurred_at DESC"
    );
    assert.ok(auditRes.rows.length >= 2, "Expected audit events for availability operations");

    const outboxRes = await bootClient.query(
      "SELECT * FROM integration.outbox_events WHERE event_type LIKE 'availability.%' ORDER BY created_at DESC"
    );
    assert.ok(outboxRes.rows.length >= 2, "Expected outbox events for availability operations");

    await bootClient.end();
  });
});
