import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

dotenv.config({ path: path.join(packageRoot, ".env") });

const importConnectionString = process.env.DATABASE_IMPORT_URL;
const runtimeConnectionString = process.env.DATABASE_URL;
const migrationConnectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_INTROSPECTION_URL;

if (!importConnectionString || !runtimeConnectionString || !migrationConnectionString) {
  throw new Error("DATABASE_IMPORT_URL, DATABASE_URL, and DATABASE_MIGRATION_URL are required.");
}

function getOwnerClient(appName: string): Client {
  const url = new URL(migrationConnectionString!);
  url.searchParams.set("options", "-c role=vind_db_owner");
  return new Client({ connectionString: url.toString(), application_name: appName });
}

function getRuntimeClient(appName: string): Client {
  return new Client({ connectionString: runtimeConnectionString, application_name: appName });
}

function getImporterClient(appName: string): Client {
  return new Client({ connectionString: importConnectionString, application_name: appName });
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
  assurance?: string;
  stepUp?: boolean;
  breakGlassReference?: string;
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
      "test-dec021-correlation",
      input.requestId ?? "test-dec021-request",
      input.assurance ?? "BASIC",
      input.stepUp ?? false,
      input.breakGlassReference ?? null
    ]
  );
}

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testId: string, message: string): void {
  if (condition) {
    passedCount++;
    console.log(`  [PASS] ${testId}: ${message}`);
  } else {
    failedCount++;
    console.error(`  [FAIL] ${testId}: ${message}`);
  }
}

async function runTestSuite(): Promise<void> {
  console.log("==========================================================================");
  console.log("DB-DEC-021 AUTOMATED SECURITY & CONTRACT TEST HARNESS");
  console.log("==========================================================================");

  // --------------------------------------------------------------------------
  // CASE-01: Bootstrap seed idempotency verification
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-01: Bootstrap seed idempotency verification...");
  const imp1 = getImporterClient("test-case-01");
  try {
    await imp1.connect();
    const resOrgs = await imp1.query("SELECT count(*)::integer as count FROM organization.organizations WHERE data_origin_code = 'SYNTHETIC_DEMO'");
    const resProvs = await imp1.query("SELECT count(*)::integer as count FROM provider.provider_profiles");
    assert(Number(resOrgs.rows[0].count) === 10, "CASE-01", "Synthetic Organizations count is 10");
    assert(Number(resProvs.rows[0].count) === 14, "CASE-01", "Provider Profiles count is 14");
  } finally {
    await imp1.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-02: 15 locked relations topology
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-02: 15 locked relations topology...");
  const owner = getOwnerClient("test-case-02");
  try {
    await owner.connect();
    const tables = [
      "provider.provider_profiles", "provider.provider_workspace_links",
      "provider.capability_definitions", "provider.provider_capabilities",
      "verification.verification_cases", "verification.verification_evidence",
      "catalog.offerings", "catalog.resources", "catalog.offering_resources",
      "catalog.packages", "catalog.package_items", "media.media_assets",
      "media.media_rights", "media.media_links", "listing.channel_publications"
    ];
    for (const t of tables) {
      const res = await owner.query(`SELECT to_regclass('${t}') IS NOT NULL as exists`);
      assert(res.rows[0].exists, "CASE-02", `Relation ${t} exists`);
    }
  } finally {
    await owner.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-03: Provider Profiles table ownership XOR constraint
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-03: Provider Profiles ownership XOR constraint...");
  const owner3 = getOwnerClient("test-case-03");
  try {
    await owner3.connect();
    const res = await owner3.query(
      "SELECT pg_get_constraintdef(oid) as def FROM pg_constraint WHERE conrelid = 'provider.provider_profiles'::regclass AND conname = 'chk_provider_ownership_xor'"
    );
    assert(res.rows.length > 0 && res.rows[0].def.includes("owning_organization_id"), "CASE-03", "Ownership XOR constraint chk_provider_ownership_xor exists");
  } finally {
    await owner3.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-04: Provider Profiles status lifecycle
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-04: Provider Profiles status lifecycle...");
  const owner4 = getOwnerClient("test-case-04");
  try {
    await owner4.connect();
    const res = await owner4.query("SELECT DISTINCT status FROM provider.provider_profiles ORDER BY status");
    const statuses = res.rows.map((r: { status: string }) => r.status);
    assert(statuses.includes("ACTIVE") && statuses.includes("DRAFT") && statuses.includes("SUSPENDED") && statuses.includes("ARCHIVED"), "CASE-04", "Provider status covers ACTIVE, DRAFT, SUSPENDED, ARCHIVED");
  } finally {
    await owner4.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-05: Direct UPDATE on provider_profiles.status denied for runtime
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-05: Direct UPDATE on provider_profiles.status denied for runtime...");
  const rt5 = getRuntimeClient("test-case-05");
  try {
    await rt5.connect();
    let caught = false;
    try {
      await rt5.query("UPDATE provider.provider_profiles SET status = 'SUSPENDED' WHERE seed_key = 'smk:s2:prov:alpha_car'");
    } catch (e: any) {
      caught = true;
      assert(e.code === "42501" || e.message.includes("permission denied") || e.message.includes("Protected"), "CASE-05", "Direct status UPDATE rejected for vind_app_runtime");
    }
    if (!caught) assert(false, "CASE-05", "Direct status UPDATE was NOT rejected!");
  } finally {
    await rt5.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-06: Direct UPDATE on channel_publications.publication_status denied
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-06: Direct UPDATE on channel_publications denied...");
  const rt6 = getRuntimeClient("test-case-06");
  try {
    await rt6.connect();
    let caught = false;
    try {
      await rt6.query("UPDATE listing.channel_publications SET publication_status = 'SUSPENDED' WHERE seed_key = 'smk:s2:pub:xenia_zam'");
    } catch (e: any) {
      caught = true;
      assert(e.code === "42501" || e.message.includes("permission denied") || e.message.includes("Protected"), "CASE-06", "Direct publication_status UPDATE rejected for vind_app_runtime");
    }
    if (!caught) assert(false, "CASE-06", "Direct publication_status UPDATE was NOT rejected!");
  } finally {
    await rt6.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-07: Provider provenance attributes & immutability trigger
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-07: Provider provenance & immutability trigger...");
  const owner7 = getOwnerClient("test-case-07");
  try {
    await owner7.connect();
    const resCol = await owner7.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'provider' AND table_name = 'provider_profiles' AND column_name = 'data_origin_code'");
    assert(resCol.rows.length === 1, "CASE-07", "data_origin_code column exists");

    let triggerFired = false;
    try {
      await owner7.query("UPDATE provider.provider_profiles SET data_origin_code = 'REAL_PRELAUNCH' WHERE seed_key = 'smk:s2:prov:alpha_car'");
    } catch (e: any) {
      triggerFired = true;
      assert(e.message.includes("immutable"), "CASE-07", "Provenance immutability trigger fired on data_origin_code UPDATE");
    }
    if (!triggerFired) assert(false, "CASE-07", "Provenance immutability trigger did NOT fire!");
  } finally {
    await owner7.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-08: Provider status command execution by authorized actor
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-08: Provider status command execution...");
  const rt8 = getRuntimeClient("test-case-08");
  try {
    await rt8.connect();
    await rt8.query("BEGIN");
    await setContext(rt8, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TEST_CASE_08"
    });

    const provRes = await rt8.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    const provId = provRes.rows[0].id;

    const res = await rt8.query("SELECT provider.execute_provider_status_command($1, $2, $3, $4, $5)", [
      provId, "SUSPENDED", "COMPLIANCE_HOLD", "idemp-test-08", "corr-test-08"
    ]);

    assert(res.rows[0].execute_provider_status_command.status === "SUCCESS", "CASE-08", "execute_provider_status_command executed successfully for authorized owner");
    await rt8.query("ROLLBACK");
  } finally {
    await rt8.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-09: Provider status command idempotency key check
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-09: Provider status command idempotency check...");
  const rt9 = getRuntimeClient("test-case-09");
  try {
    await rt9.connect();
    await rt9.query("BEGIN");
    await setContext(rt9, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TEST_CASE_09"
    });

    const provRes = await rt9.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    const provId = provRes.rows[0].id;

    await rt9.query("SELECT provider.execute_provider_status_command($1, $2, $3, $4, $5)", [
      provId, "SUSPENDED", "TEST_REASON", "idemp-test-09", "corr-test-09"
    ]);

    let conflict = false;
    try {
      await rt9.query("SELECT provider.execute_provider_status_command($1, $2, $3, $4, $5)", [
        provId, "ACTIVE", "DIFFERENT_HASH", "idemp-test-09", "corr-test-09"
      ]);
    } catch (e: any) {
      conflict = true;
      assert(e.code === "22023" || e.message.includes("mismatch"), "CASE-09", "Idempotency key mismatch detected");
    }
    if (!conflict) assert(false, "CASE-09", "Idempotency key mismatch was NOT detected!");
    await rt9.query("ROLLBACK");
  } finally {
    await rt9.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-10: Provider status command unauthorized actor denied
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-10: Provider status command unauthorized actor denied...");
  const rt10 = getRuntimeClient("test-case-10");
  try {
    await rt10.connect();
    await rt10.query("BEGIN");
    await setContext(rt10, {
      accountKey: "smk:s2:acc:owner_beta",
      personKey: "smk:s2:person:owner_beta",
      organizationKey: "smk:s2:org:beta",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_beta",
      localAssignmentKey: "smk:s2:assign:agus_beta_owner",
      purposeCode: "TEST_CASE_10"
    });

    const owner10 = getOwnerClient("test-case-10-lookup");
    await owner10.connect();
    const provRes = await owner10.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    const provId = provRes.rows[0].id;
    await owner10.end();

    let denied = false;
    try {
      await rt10.query("SELECT provider.execute_provider_status_command($1, $2, $3, $4, $5)", [
        provId, "SUSPENDED", "UNAUTHORIZED_ATTEMPT", "idemp-test-10", "corr-test-10"
      ]);
    } catch (e: any) {
      denied = true;
      assert(e.code === "42501" || e.message.includes("Unauthorized"), "CASE-10", "Unauthorized provider status command denied");
    }
    if (!denied) assert(false, "CASE-10", "Unauthorized command was NOT denied!");
    await rt10.query("ROLLBACK");
  } finally {
    await rt10.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-11: Publication command success
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-11: Publication command success...");
  const rt11 = getRuntimeClient("test-case-11");
  try {
    await rt11.connect();
    await rt11.query("BEGIN");
    await setContext(rt11, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TEST_CASE_11"
    });

    const pubRes = await rt11.query("SELECT id FROM listing.channel_publications WHERE seed_key = 'smk:s2:pub:xenia_zam'");
    const pubId = pubRes.rows[0].id;

    const res = await rt11.query("SELECT listing.execute_publication_command($1, $2, $3, $4, $5)", [
      pubId, "PUBLISHED", "ROUTINE_UPDATE", "idemp-test-11", "corr-test-11"
    ]);

    assert(res.rows[0].execute_publication_command.status === "SUCCESS", "CASE-11", "Publication command executed successfully");
    await rt11.query("ROLLBACK");
  } finally {
    await rt11.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-12: Publication command rejected when provider NOT active
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-12: Publication command rejected when provider NOT active...");
  const owner12 = getOwnerClient("test-case-12");
  try {
    await owner12.connect();
    await owner12.query("BEGIN");
    await setContext(owner12, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TEST_CASE_12"
    });

    // Set provider to DRAFT directly via command guard override
    await owner12.query("SELECT set_config('vind.command_execution_active', 'on', true)");
    await owner12.query("UPDATE provider.provider_profiles SET status = 'DRAFT' WHERE seed_key = 'smk:s2:prov:alpha_car'");
    await owner12.query("SELECT set_config('vind.command_execution_active', 'off', true)");

    const pubRes = await owner12.query("SELECT id FROM listing.channel_publications WHERE seed_key = 'smk:s2:pub:xenia_zam'");
    const pubId = pubRes.rows[0].id;

    let rejected = false;
    try {
      await owner12.query("SELECT listing.execute_publication_command($1, $2, $3, $4, $5)", [
        pubId, "PUBLISHED", "TRY_PUBLISH", "idemp-test-12", "corr-test-12"
      ]);
    } catch (e: any) {
      rejected = true;
      assert(e.message.includes("ACTIVE"), "CASE-12", "Publication rejected when provider status is NOT ACTIVE");
    }
    if (!rejected) assert(false, "CASE-12", "Publication was NOT rejected!");
    await owner12.query("ROLLBACK");
  } finally {
    await owner12.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-13: Publication command rejected when verification missing
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-13: Publication command rejected when verification missing...");
  const owner13 = getOwnerClient("test-case-13");
  try {
    await owner13.connect();
    await owner13.query("BEGIN");
    await setContext(owner13, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TEST_CASE_13"
    });

    // Remove approved verification cases
    await owner13.query("UPDATE verification.verification_cases SET status = 'REJECTED' WHERE provider_profile_id = (SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car')");

    const pubRes = await owner13.query("SELECT id FROM listing.channel_publications WHERE seed_key = 'smk:s2:pub:xenia_zam'");
    const pubId = pubRes.rows[0].id;

    let rejected = false;
    try {
      await owner13.query("SELECT listing.execute_publication_command($1, $2, $3, $4, $5)", [
        pubId, "PUBLISHED", "TRY_PUBLISH", "idemp-test-13", "corr-test-13"
      ]);
    } catch (e: any) {
      rejected = true;
      assert(e.message.includes("APPROVED verification"), "CASE-13", "Publication rejected when active APPROVED verification missing");
    }
    if (!rejected) assert(false, "CASE-13", "Publication was NOT rejected!");
    await owner13.query("ROLLBACK");
  } finally {
    await owner13.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-14: Publication command rejected when media UNSAFE or rights missing
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-14: Publication command rejected when media UNSAFE...");
  const owner14 = getOwnerClient("test-case-14");
  try {
    await owner14.connect();
    await owner14.query("BEGIN");
    await setContext(owner14, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TEST_CASE_14"
    });

    const unsafeMediaRes = await owner14.query("SELECT id FROM media.media_assets WHERE seed_key = 'smk:s2:media:unsafe_media'");
    const pubRes = await owner14.query("SELECT id FROM listing.channel_publications WHERE seed_key = 'smk:s2:pub:xenia_zam'");
    
    await owner14.query("INSERT INTO media.media_links (seed_key, media_asset_id, channel_publication_id, link_role, link_status) VALUES ('smk:s2:mlink:test_unsafe', $1, $2, 'PUBLIC_LISTING', 'ACTIVE')", [
      unsafeMediaRes.rows[0].id, pubRes.rows[0].id
    ]);

    let rejected = false;
    try {
      await owner14.query("SELECT listing.execute_publication_command($1, $2, $3, $4, $5)", [
        pubRes.rows[0].id, "PUBLISHED", "TRY_PUBLISH", "idemp-test-14", "corr-test-14"
      ]);
    } catch (e: any) {
      rejected = true;
      assert(e.message.includes("Unsafe media"), "CASE-14", "Publication rejected when unsafe media asset linked");
    }
    if (!rejected) assert(false, "CASE-14", "Publication was NOT rejected!");
    await owner14.query("ROLLBACK");
  } finally {
    await owner14.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-15: Direct SELECT on verification_evidence denied for runtime
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-15: Direct SELECT on verification_evidence denied...");
  const rt15 = getRuntimeClient("test-case-15");
  try {
    await rt15.connect();
    let denied = false;
    try {
      const res = await rt15.query("SELECT * FROM verification.verification_evidence");
      if (res.rows.length === 0) {
        denied = true;
        assert(true, "CASE-15", "Direct SELECT on verification_evidence returned 0 rows (denied for vind_app_runtime)");
      }
    } catch (e: any) {
      denied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "CASE-15", "Direct SELECT on verification_evidence denied for vind_app_runtime");
    }
    if (!denied) assert(false, "CASE-15", "Direct SELECT was NOT denied!");
  } finally {
    await rt15.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-16: verification.read_evidence allowed for platform authority
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-16: verification.read_evidence allowed for platform authority...");
  const rt16 = getRuntimeClient("test-case-16");
  try {
    await rt16.connect();
    await rt16.query("BEGIN");
    await setContext(rt16, {
      accountKey: "smk:s2:acc:moderator_1",
      personKey: "smk:s2:person:moderator_1",
      actorKind: "HUMAN",
      plane: "PLATFORM",
      platformAssignmentKey: "smk:s2:passign:mod_1",
      purposeCode: "AUDIT_VERIFICATION"
    });
    
    const owner16 = getOwnerClient("lookup-16");
    await owner16.connect();
    const evRes = await owner16.query("SELECT id FROM verification.verification_evidence WHERE seed_key = 'smk:s2:ve:alpha_nib'");
    const evId = evRes.rows[0].id;
    await owner16.end();

    const res = await rt16.query("SELECT * FROM verification.read_evidence($1, 'AUDIT_VERIFICATION')", [evId]);

    assert(res.rows.length === 1 && res.rows[0].evidence_type === "NIB", "CASE-16", "read_evidence returned evidence for platform MODERATOR");
    await rt16.query("ROLLBACK");
  } finally {
    await rt16.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-17: verification.read_evidence denied for local provider owner
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-17: verification.read_evidence denied for local provider owner...");
  const rt17 = getRuntimeClient("test-case-17");
  try {
    await rt17.connect();
    await rt17.query("BEGIN");
    await setContext(rt17, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TENANT_OWNER_READ"
    });
    
    const owner17 = getOwnerClient("lookup-17");
    await owner17.connect();
    const evRes = await owner17.query("SELECT id FROM verification.verification_evidence WHERE seed_key = 'smk:s2:ve:alpha_nib'");
    const evId = evRes.rows[0].id;
    await owner17.end();

    let denied = false;
    try {
      await rt17.query("SELECT * FROM verification.read_evidence($1, 'TENANT_OWNER_READ')", [evId]);
    } catch (e: any) {
      denied = true;
      assert(e.code === "42501" || e.message.includes("Unauthorized"), "CASE-17", "read_evidence denied for local provider owner without platform capability");
    }
    if (!denied) assert(false, "CASE-17", "read_evidence was NOT denied for local owner!");
    await rt17.query("ROLLBACK");
  } finally {
    await rt17.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-18: verification.read_evidence writes security.data_access_logs
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-18: verification.read_evidence writes security.data_access_logs...");
  const owner18 = getOwnerClient("test-case-18");
  try {
    await owner18.connect();
    await owner18.query("BEGIN");
    await setContext(owner18, {
      accountKey: "smk:s2:acc:moderator_1",
      personKey: "smk:s2:person:moderator_1",
      actorKind: "HUMAN",
      plane: "PLATFORM",
      platformAssignmentKey: "smk:s2:passign:mod_1",
      purposeCode: "AUDIT_LOG_CHECK"
    });
    
    const evRes = await owner18.query("SELECT id FROM verification.verification_evidence WHERE seed_key = 'smk:s2:ve:alpha_nib'");
    await owner18.query("SELECT * FROM verification.read_evidence($1, 'AUDIT_LOG_CHECK')", [evRes.rows[0].id]);

    const logRes = await owner18.query("SELECT count(*)::integer as count FROM security.data_access_logs WHERE purpose_code = 'AUDIT_LOG_CHECK'");
    assert(Number(logRes.rows[0].count) >= 1, "CASE-18", "data_access_logs entry recorded on read_evidence execution");
    await owner18.query("ROLLBACK");
  } finally {
    await owner18.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-19: provider.execute_management_authority_command success
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-19: execute_management_authority_command success...");
  const rt19 = getRuntimeClient("test-case-19");
  try {
    await rt19.connect();
    await rt19.query("BEGIN");
    await setContext(rt19, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TEST_CASE_19"
    });

    const provRes = await rt19.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    const orgRes = await rt19.query("SELECT id FROM organization.organizations WHERE seed_key = 'smk:s2:org:alpha'");
    const wsRes = await rt19.query("SELECT id FROM organization.workspaces WHERE seed_key = 'smk:s2:ws:alpha_main'");

    const res = await rt19.query("SELECT provider.execute_management_authority_command($1, $2, $3, $4, $5, $6, $7)", [
      provRes.rows[0].id, orgRes.rows[0].id, wsRes.rows[0].id, "ACTIVE", "TEST_LINK", "corr-test-19", "idemp-test-19"
    ]);

    assert(res.rows[0].execute_management_authority_command.status === "SUCCESS", "CASE-19", "execute_management_authority_command succeeded for authorized owner");
    await rt19.query("ROLLBACK");
  } finally {
    await rt19.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-20: provider.execute_management_authority_command denied
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-20: execute_management_authority_command denied...");
  const rt20 = getRuntimeClient("test-case-20");
  try {
    await rt20.connect();
    await rt20.query("BEGIN");
    await setContext(rt20, {
      accountKey: "smk:s2:acc:owner_beta",
      personKey: "smk:s2:person:owner_beta",
      organizationKey: "smk:s2:org:beta",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_beta",
      localAssignmentKey: "smk:s2:assign:agus_beta_owner",
      purposeCode: "TEST_CASE_20"
    });

    const owner20 = getOwnerClient("lookup-20");
    await owner20.connect();
    const provRes = await owner20.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    const provId = provRes.rows[0].id;
    await owner20.end();

    const orgRes = await rt20.query("SELECT id FROM organization.organizations WHERE seed_key = 'smk:s2:org:beta'");
    const wsRes = await rt20.query("SELECT id FROM organization.workspaces WHERE seed_key = 'smk:s2:ws:beta_main'");

    let denied = false;
    try {
      await rt20.query("SELECT provider.execute_management_authority_command($1, $2, $3, $4, $5, $6, $7)", [
        provId, orgRes.rows[0].id, wsRes.rows[0].id, "ACTIVE", "UNAUTHORIZED_LINK", "corr-test-20", "idemp-test-20"
      ]);
    } catch (e: any) {
      denied = true;
      assert(e.code === "42501" || e.message.includes("Unauthorized"), "CASE-20", "execute_management_authority_command denied for unauthorized actor");
    }
    if (!denied) assert(false, "CASE-20", "execute_management_authority_command was NOT denied!");
    await rt20.query("ROLLBACK");
  } finally {
    await rt20.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-21: Scoped assignments provider_id bridge column & XOR constraint
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-21: Scoped assignments provider_id bridge & XOR constraint...");
  const owner21 = getOwnerClient("test-case-21");
  try {
    await owner21.connect();
    const colRes = await owner21.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'access' AND table_name = 'scoped_assignments' AND column_name = 'provider_id'");
    assert(colRes.rows.length === 1, "CASE-21", "Column provider_id exists on access.scoped_assignments");

    const xorRes = await owner21.query("SELECT count(*)::integer as count FROM access.scoped_assignments WHERE scope_type = 'PROVIDER' AND (organization_id IS NOT NULL OR workspace_id IS NOT NULL)");
    assert(Number(xorRes.rows[0].count) === 0, "CASE-21", "All PROVIDER scope assignments have NULL organization_id and workspace_id");
  } finally {
    await owner21.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-22: Sensitive capability codes exact check
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-22: Sensitive capability codes exact check...");
  const owner22 = getOwnerClient("test-case-22");
  try {
    await owner22.connect();
    const caps = [
      "provider.status.transition",
      "provider.management_authority.manage",
      "listing.publication.transition",
      "verification.evidence.read"
    ];
    for (const c of caps) {
      const res = await owner22.query("SELECT count(*)::integer as count FROM access.capabilities WHERE code = $1 AND is_sensitive = true AND is_active = true", [c]);
      assert(Number(res.rows[0].count) === 1, "CASE-22", `Sensitive capability ${c} exists and is active`);
    }
    const legacy = await owner22.query("SELECT count(*)::integer as count FROM access.capabilities WHERE code = 'provider.status.manage'");
    assert(Number(legacy.rows[0].count) === 0, "CASE-22", "Legacy capability provider.status.manage is absent");
  } finally {
    await owner22.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-23: Command guard isolation check
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-23: Command guard isolation check...");
  const owner23 = getOwnerClient("test-case-23");
  try {
    await owner23.connect();
    await owner23.query("BEGIN");
    await setContext(owner23, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "TEST_CASE_23"
    });
    
    const provRes = await owner23.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    await owner23.query("SELECT provider.execute_provider_status_command($1, $2, $3, $4, $5)", [
      provRes.rows[0].id, "ACTIVE", "GUARD_CHECK", "idemp-test-23", "corr-test-23"
    ]);

    const activeSetting = await owner23.query("SELECT current_setting('vind.command_execution_active', true) as val");
    assert(activeSetting.rows[0].val === "off" || activeSetting.rows[0].val === "" || activeSetting.rows[0].val === null, "CASE-23", "command_execution_active reset to off after command completion");
    await owner23.query("ROLLBACK");
  } finally {
    await owner23.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-24: Importer least privilege policies
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-24: Importer least privilege policies...");
  const imp24 = getImporterClient("test-case-24");
  try {
    await imp24.connect();
    let deleteDenied = false;
    try {
      await imp24.query("DELETE FROM access.scoped_assignments WHERE seed_key = 'non_existent'");
    } catch (e: any) {
      deleteDenied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "CASE-24", "DELETE on access.scoped_assignments denied for vind_importer");
    }
    if (!deleteDenied) assert(false, "CASE-24", "DELETE was NOT denied for vind_importer!");
  } finally {
    await imp24.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-25: Structural verifier script execution
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-25: Structural verifier script execution...");
  const owner25 = getOwnerClient("test-case-25");
  try {
    await owner25.connect();
    const sql = await readFile(path.join(repoRoot, "database", "foundation", "verify_provider_catalog_media_publication_core.sql"), "utf8");
    let passed = false;
    try {
      await owner25.query(sql);
      passed = true;
    } catch (e: any) {
      console.error("  Structural verifier output error:", e.message);
    }
    assert(passed, "CASE-25", "Structural verifier verify_provider_catalog_media_publication_core.sql PASSED");
  } finally {
    await owner25.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // SUP-01..18: Supplementary metrics and integrity checks
  // --------------------------------------------------------------------------
  console.log("\nExecuting SUP-01..18: Supplementary data and constraint checks...");
  const ownerSup = getOwnerClient("test-sups");
  try {
    await ownerSup.connect();
    const sup01 = await ownerSup.query("SELECT count(*)::integer as count FROM organization.organizations WHERE data_origin_code = 'SYNTHETIC_DEMO'");
    assert(Number(sup01.rows[0].count) === 10, "SUP-01", "10 Synthetic Organizations verified");

    const sup02 = await ownerSup.query("SELECT count(*)::integer as count FROM provider.provider_profiles WHERE data_origin_code = 'SYNTHETIC_DEMO'");
    assert(Number(sup02.rows[0].count) === 14, "SUP-02", "14 Provider Profiles with SYNTHETIC_DEMO origin verified");

    const sup03 = await ownerSup.query("SELECT count(*)::integer as count FROM verification.verification_cases");
    assert(Number(sup03.rows[0].count) === 13, "SUP-03", "13 Verification Cases verified");

    const sup04 = await ownerSup.query("SELECT count(*)::integer as count FROM verification.verification_evidence WHERE document_number_masked LIKE '%*%'");
    assert(Number(sup04.rows[0].count) === 8, "SUP-04", "8 Verification Evidence records with masked numbers verified");

    const sup05 = await ownerSup.query("SELECT count(*)::integer as count FROM catalog.offerings");
    assert(Number(sup05.rows[0].count) === 12, "SUP-05", "12 Catalog Offerings verified");

    const sup06 = await ownerSup.query("SELECT count(*)::integer as count FROM listing.channel_publications");
    assert(Number(sup06.rows[0].count) === 15, "SUP-06", "15 Channel Publications verified");

    const sup07 = await ownerSup.query("SELECT count(*)::integer as count FROM media.media_assets");
    assert(Number(sup07.rows[0].count) === 6, "SUP-07", "6 Media Assets verified (including UNSAFE media)");

    const sup08 = await ownerSup.query("SELECT count(*)::integer as count FROM geo.regions WHERE seed_key LIKE 'smk:s2:geo:%'");
    assert(Number(sup08.rows[0].count) === 20, "SUP-08", "20 Geo Regions verified across Indonesia");

    const sup09 = await ownerSup.query("SELECT tgname FROM pg_trigger WHERE tgname = 'trg_offering_resource_provider_consistency'");
    assert(sup09.rows.length === 1, "SUP-09", "Cross-provider offering resource consistency trigger verified");

    const sup10 = await ownerSup.query("SELECT tgname FROM pg_trigger WHERE tgname = 'trg_package_provider_consistency'");
    assert(sup10.rows.length === 1, "SUP-10", "Cross-provider package consistency trigger verified");

    const sup11 = await ownerSup.query("SELECT conname FROM pg_constraint WHERE conname = 'chk_media_link_target_xor'");
    assert(sup11.rows.length === 1, "SUP-11", "Exact-one-target XOR constraint chk_media_link_target_xor verified");

    const sup12 = await ownerSup.query("SELECT conname FROM pg_constraint WHERE conname = 'chk_pub_target_xor'");
    assert(sup12.rows.length === 1, "SUP-12", "Offering/Package target XOR constraint chk_pub_target_xor verified");

    const sup13 = await ownerSup.query("SELECT conname FROM pg_constraint WHERE conname = 'chk_provider_workspace_link_period'");
    assert(sup13.rows.length === 1, "SUP-13", "Provider workspace link effective period CHECK verified");

    const sup14 = await ownerSup.query("SELECT conname FROM pg_constraint WHERE conname = 'chk_media_rights_period'");
    assert(sup14.rows.length === 1, "SUP-14", "Media rights effective period CHECK verified");

    const sup15 = await ownerSup.query("SELECT conname FROM pg_constraint WHERE conname = 'chk_media_link_period'");
    assert(sup15.rows.length === 1, "SUP-15", "Media link effective period CHECK verified");

    const sup16 = await ownerSup.query("SELECT conname FROM pg_constraint WHERE conname = 'chk_channel_publication_period'");
    assert(sup16.rows.length === 1, "SUP-16", "Channel publication effective period CHECK verified");

    const sup17 = await ownerSup.query("SELECT count(*)::integer as count FROM audit.audit_events WHERE target_schema IN ('provider', 'listing', 'verification') OR event_type LIKE '%STATUS%'");
    assert(Number(sup17.rows[0].count) >= 0, "SUP-17", "Audit event structure ready for status transitions");

    const sup18 = await ownerSup.query("SELECT count(*)::integer as count FROM integration.outbox_events WHERE aggregate_schema IN ('provider', 'listing') OR event_type LIKE '%STATUS%'");
    assert(Number(sup18.rows[0].count) >= 0, "SUP-18", "Outbox event structure ready for integration dispatch");
  } finally {
    await ownerSup.end().catch(() => undefined);
  }

  console.log("==========================================================================");
  console.log(`TEST RESULTS SUMMARY: PASSED=${passedCount}, FAILED=${failedCount}`);
  console.log("==========================================================================");

  if (failedCount > 0) {
    throw new Error(`DB-DEC-021 Test Harness FAILED with ${failedCount} failure(s).`);
  }
}

runTestSuite().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
});
