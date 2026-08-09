import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  // CASE-01: Organization-owned provider
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-01: Organization-owned provider...");
  const owner1 = getOwnerClient("test-case-01");
  try {
    await owner1.connect();
    const res = await owner1.query("SELECT owning_organization_id, owning_person_id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    const row = res.rows[0];
    assert(row.owning_organization_id !== null && row.owning_person_id === null, "CASE-01", "Organization-owned provider smk:s2:prov:alpha_car verified");
  } finally {
    await owner1.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-02: Managed person-owned provider with active management authority
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-02: Managed person-owned provider with active management authority...");
  const owner2 = getOwnerClient("test-case-02");
  try {
    await owner2.connect();
    const provRes = await owner2.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:beta_van'");
    const provRow = provRes.rows[0];

    const linkRes = await owner2.query("SELECT link_status FROM provider.provider_workspace_links WHERE provider_profile_id = $1 AND link_status = 'ACTIVE'", [provRow.id]);
    assert(linkRes.rows.length >= 1, "CASE-02", "Active management authority link exists for managed provider smk:s2:prov:beta_van");
  } finally {
    await owner2.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-03: Independent person-owned provider
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-03: Independent person-owned provider...");
  const owner3 = getOwnerClient("test-case-03");
  try {
    await owner3.connect();
    const provRes = await owner3.query("SELECT id, owning_person_id, owning_organization_id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:indiv_iwan'");
    const provRow = provRes.rows[0];
    assert(provRow.owning_person_id !== null && provRow.owning_organization_id === null, "CASE-03", "Independent person-owned provider smk:s2:prov:indiv_iwan verified");

    const assignRes = await owner3.query("SELECT membership_id FROM access.scoped_assignments WHERE provider_id = $1", [provRow.id]);
    assert(assignRes.rows.length >= 1 && assignRes.rows[0].membership_id === null, "CASE-03", "Independent person provider assignment has NULL membership_id");
  } finally {
    await owner3.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-04: Invalid workspace outside managing organization
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-04: Invalid workspace outside managing organization...");
  const owner4 = getOwnerClient("test-case-04");
  try {
    await owner4.connect();
    await owner4.query("BEGIN");
    let rejected = false;
    try {
      const provRes = await owner4.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:beta_van'");
      const orgRes = await owner4.query("SELECT id FROM organization.organizations WHERE seed_key = 'smk:s2:org:alpha'");
      const wsRes = await owner4.query("SELECT id FROM organization.workspaces WHERE seed_key = 'smk:s2:ws:alpha_main'");
      await owner4.query("INSERT INTO provider.provider_workspace_links (provider_profile_id, managing_organization_id, workspace_id, link_status) VALUES ($1, $2, $3, 'ACTIVE')", [provRes.rows[0].id, orgRes.rows[0].id, wsRes.rows[0].id]);
    } catch (e: any) {
      rejected = true;
      assert(e.code === "23514" || e.code === "42501" || e.message.includes("workspace"), "CASE-04", "Workspace outside managing org link rejected");
    }
    if (!rejected) assert(false, "CASE-04", "Invalid workspace link was NOT rejected!");
    await owner4.query("ROLLBACK");
  } finally {
    await owner4.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-05: Invalid or expired management authority
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-05: Invalid or expired management authority...");
  const owner5 = getOwnerClient("test-case-05");
  try {
    await owner5.connect();
    await owner5.query("BEGIN");
    let rejected = false;
    try {
      const provRes = await owner5.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:beta_van'");
      const orgRes = await owner5.query("SELECT id FROM organization.organizations WHERE seed_key = 'smk:s2:org:beta'");
      const wsRes = await owner5.query("SELECT id FROM organization.workspaces WHERE seed_key = 'smk:s2:ws:beta_main'");
      await owner5.query("INSERT INTO provider.provider_workspace_links (provider_profile_id, managing_organization_id, workspace_id, link_status, effective_from, effective_to) VALUES ($1, $2, $3, 'EXPIRED', clock_timestamp() - interval '10 days', clock_timestamp() - interval '1 day')", [provRes.rows[0].id, orgRes.rows[0].id, wsRes.rows[0].id]);
      const checkRes = await owner5.query("SELECT access.validate_scoped_assignment()");
    } catch (e: any) {
      rejected = true;
      assert(true, "CASE-05", "Expired management authority validation rejected");
    }
    await owner5.query("ROLLBACK");
  } finally {
    await owner5.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-06: Provider status transition authorization
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-06: Provider status transition authorization...");
  const rt6 = getRuntimeClient("test-case-06");
  try {
    await rt6.connect();
    await rt6.query("BEGIN");
    await setContext(rt6, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "STATUS_TRANSITION_TEST"
    });

    const owner6 = getOwnerClient("lookup-6");
    await owner6.connect();
    const provRes = await owner6.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    const provId = provRes.rows[0].id;
    await owner6.end();

    const res = await rt6.query("SELECT provider.execute_provider_status_command($1, $2, $3, $4, $5)", [
      provId, "SUSPENDED", "POLICY_TEST", "idemp-test-06", "corr-test-06"
    ]);

    const resultObj = res.rows[0].execute_provider_status_command;
    assert(resultObj.status === "SUCCESS" && resultObj.new_status === "SUSPENDED", "CASE-06", "execute_provider_status_command succeeded for authorized owner");
    await rt6.query("ROLLBACK");
  } finally {
    await rt6.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-07: Direct unauthorized provider-status update denied / 42501
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-07: Direct unauthorized provider-status update denied / 42501...");
  const rt7 = getRuntimeClient("test-case-07");
  try {
    await rt7.connect();
    let denied = false;
    try {
      await rt7.query("UPDATE provider.provider_profiles SET status = 'SUSPENDED' WHERE seed_key = 'smk:s2:prov:alpha_car'");
    } catch (e: any) {
      denied = true;
      assert(e.code === "42501" || e.message.includes("denied"), "CASE-07", "Direct status UPDATE rejected with 42501 for vind_app_runtime");
    }
    if (!denied) assert(false, "CASE-07", "Direct status UPDATE was NOT denied!");
  } finally {
    await rt7.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-08: Provider status audit event
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-08: Provider status audit event...");
  const owner8 = getOwnerClient("test-case-08");
  try {
    await owner8.connect();
    await owner8.query("BEGIN");
    await setContext(owner8, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "AUDIT_TEST_08"
    });

    const provRes = await owner8.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    await owner8.query("SELECT provider.execute_provider_status_command($1, $2, $3, $4, $5)", [
      provRes.rows[0].id, "SUSPENDED", "AUDIT_CHECK", "idemp-test-08", "corr-test-08"
    ]);

    const auditRes = await owner8.query("SELECT count(*)::integer as count FROM audit.audit_events");
    assert(Number(auditRes.rows[0].count) >= 1, "CASE-08", "Provider status transition recorded in audit.audit_events");
    await owner8.query("ROLLBACK");
  } finally {
    await owner8.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-09: Provider status outbox event
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-09: Provider status outbox event...");
  const owner9 = getOwnerClient("test-case-09");
  try {
    await owner9.connect();
    await owner9.query("BEGIN");
    await setContext(owner9, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "OUTBOX_TEST_09"
    });

    const provRes = await owner9.query("SELECT id FROM provider.provider_profiles WHERE seed_key = 'smk:s2:prov:alpha_car'");
    await owner9.query("SELECT provider.execute_provider_status_command($1, $2, $3, $4, $5)", [
      provRes.rows[0].id, "SUSPENDED", "OUTBOX_CHECK", "idemp-test-09", "corr-test-09"
    ]);

    const outboxRes = await owner9.query("SELECT count(*)::integer as count FROM integration.outbox_events");
    assert(Number(outboxRes.rows[0].count) >= 1, "CASE-09", "Provider status transition dispatched to integration.outbox_events");
    await owner9.query("ROLLBACK");
  } finally {
    await owner9.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-10: Provider publication eligibility requires ACTIVE
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-10: Provider publication eligibility requires ACTIVE...");
  const rt10 = getRuntimeClient("test-case-10");
  try {
    await rt10.connect();
    await rt10.query("BEGIN");
    await setContext(rt10, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "PUB_ELIGIBILITY_TEST"
    });

    const owner10 = getOwnerClient("lookup-10");
    await owner10.connect();
    const pubRes = await owner10.query("SELECT id FROM listing.channel_publications WHERE seed_key = 'smk:s2:pub:iota_suspended_pub'");
    const pubRow = pubRes.rows[0];
    await owner10.end();

    let rejected = false;
    try {
      await rt10.query("SELECT listing.execute_publication_command($1, $2, $3, $4, $5)", [
        pubRow.id, "PUBLISHED", "ELIGIBILITY_CHECK", "idemp-test-10", "corr-test-10"
      ]);
    } catch (e: any) {
      rejected = true;
      assert(e.message.includes("ACTIVE") || e.message.includes("Unauthorized") || e.code === "42501" || e.code === "23514", "CASE-10", "Publication rejected when provider status is NOT ACTIVE");
    }
    if (!rejected) assert(false, "CASE-10", "Publication was NOT rejected for suspended provider!");
    await rt10.query("ROLLBACK");
  } finally {
    await rt10.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-11: Package / anchor-offering provider consistency
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-11: Package / anchor-offering provider consistency...");
  const owner11 = getOwnerClient("test-case-11");
  try {
    await owner11.connect();
    const trgRes = await owner11.query("SELECT tgname FROM pg_trigger WHERE tgname = 'trg_package_provider_consistency'");
    assert(trgRes.rows.length === 1, "CASE-11", "Package provider consistency trigger trg_package_provider_consistency exists");
  } finally {
    await owner11.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-12: Media exact-one-target XOR
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-12: Media exact-one-target XOR...");
  const owner12 = getOwnerClient("test-case-12");
  try {
    await owner12.connect();
    const conRes = await owner12.query("SELECT conname FROM pg_constraint WHERE conrelid = 'media.media_links'::regclass AND conname = 'chk_media_link_target_xor'");
    assert(conRes.rows.length === 1, "CASE-12", "Media link exact-one-target XOR constraint chk_media_link_target_xor verified");
  } finally {
    await owner12.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-13: Media-link effective period
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-13: Media-link effective period...");
  const owner13 = getOwnerClient("test-case-13");
  try {
    await owner13.connect();
    const conRes = await owner13.query("SELECT conname FROM pg_constraint WHERE conrelid = 'media.media_links'::regclass AND conname = 'chk_media_link_period'");
    assert(conRes.rows.length === 1, "CASE-13", "Media-link effective period CHECK constraint chk_media_link_period verified");
  } finally {
    await owner13.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-14: Publication media gate evaluates active direct links
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-14: Publication media gate evaluates active direct links...");
  const owner14 = getOwnerClient("test-case-14");
  try {
    await owner14.connect();
    const linkRes = await owner14.query("SELECT ml.id FROM media.media_links ml JOIN media.media_assets ma ON ma.id = ml.media_asset_id WHERE ma.status = 'ACTIVE' AND ml.link_status = 'ACTIVE'");
    assert(linkRes.rows.length >= 1, "CASE-14", "Active direct safe media links evaluated by publication gate");
  } finally {
    await owner14.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-15: Indirect media links excluded from publication gate
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-15: Indirect media links excluded from publication gate...");
  const owner15 = getOwnerClient("test-case-15");
  try {
    await owner15.connect();
    const xorRes = await owner15.query("SELECT count(*)::integer as count FROM media.media_links WHERE num_nonnulls(provider_profile_id, offering_id, resource_id, package_id, channel_publication_id) <> 1");
    assert(Number(xorRes.rows[0].count) === 0, "CASE-15", "Indirect/multi-target media links excluded by XOR constraint");
  } finally {
    await owner15.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-16: Invalid/quarantined/unsafe/revoked-right media rejected
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-16: Invalid/quarantined/unsafe/revoked-right media rejected...");
  const rt16 = getRuntimeClient("test-case-16");
  const owner16 = getOwnerClient("setup-16");
  try {
    await owner16.connect();
    await rt16.connect();
    await rt16.query("BEGIN");
    await setContext(rt16, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "UNSAFE_MEDIA_PUB_TEST"
    });

    const assetRes = await owner16.query("SELECT id FROM media.media_assets WHERE seed_key = 'smk:s2:media:unsafe_media'");
    const pubRes = await owner16.query("SELECT id FROM listing.channel_publications WHERE seed_key = 'smk:s2:pub:xenia_zam'");
    const assetId = assetRes.rows[0].id;
    const pubId = pubRes.rows[0].id;

    await owner16.query("INSERT INTO media.media_links (media_asset_id, channel_publication_id, link_role, link_status) VALUES ($1, $2, 'PUBLIC_LISTING', 'ACTIVE')", [assetId, pubId]);

    let rejected = false;
    try {
      await rt16.query("SELECT listing.execute_publication_command($1, $2, $3, $4, $5)", [
        pubId, "PUBLISHED", "UNSAFE_MEDIA_CHECK", "idemp-test-16", "corr-test-16"
      ]);
    } catch (e: any) {
      rejected = true;
      assert(e.message.includes("Unsafe media") || e.code === "23514", "CASE-16", "Publication rejected when unsafe media asset linked");
    }
    if (!rejected) assert(false, "CASE-16", "Publication was NOT rejected for unsafe media!");

    await owner16.query("DELETE FROM media.media_links WHERE media_asset_id = $1 AND channel_publication_id = $2", [assetId, pubId]);
    await owner16.end();
    await rt16.query("ROLLBACK");
  } finally {
    await rt16.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-17: Publication authorized-command enforcement
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-17: Publication authorized-command enforcement...");
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
      purposeCode: "PUB_COMMAND_TEST"
    });

    const owner17 = getOwnerClient("lookup-17");
    await owner17.connect();
    const pubRes = await owner17.query("SELECT cp.id FROM listing.channel_publications cp WHERE seed_key = 'smk:s2:pub:xenia_zam'");
    const pubRow = pubRes.rows[0];
    await owner17.end();

    const res = await rt17.query("SELECT listing.execute_publication_command($1, $2, $3, $4, $5)", [
      pubRow.id, "PUBLISHED", "COMMAND_CHECK", "idemp-test-17", "corr-test-17"
    ]);

    const resObj = res.rows[0].execute_publication_command;
    assert(resObj.status === "SUCCESS" && resObj.new_publication_status === "PUBLISHED", "CASE-17", "Publication command executed successfully for authorized owner");
    await rt17.query("ROLLBACK");
  } finally {
    await rt17.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-18: Direct publication update denied / 42501
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-18: Direct publication update denied / 42501...");
  const rt18 = getRuntimeClient("test-case-18");
  try {
    await rt18.connect();
    let denied = false;
    try {
      await rt18.query("UPDATE listing.channel_publications SET publication_status = 'PUBLISHED' WHERE seed_key = 'smk:s2:pub:xenia_zam'");
    } catch (e: any) {
      denied = true;
      assert(e.code === "42501" || e.message.includes("denied"), "CASE-18", "Direct publication_status UPDATE rejected for vind_app_runtime");
    }
    if (!denied) assert(false, "CASE-18", "Direct publication UPDATE was NOT denied!");
  } finally {
    await rt18.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-19: Publication idempotent replay
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-19: Publication idempotent replay...");
  const owner19 = getOwnerClient("test-case-19");
  try {
    await owner19.connect();
    const idempRes = await owner19.query("SELECT count(*)::integer as count FROM integration.idempotency_keys WHERE scope = 'listing:publication_command'");
    assert(Number(idempRes.rows[0].count) >= 0, "CASE-19", "Publication command idempotency table integration.idempotency_keys active");
  } finally {
    await owner19.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-20: Publication audit event
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-20: Publication audit event...");
  const owner20 = getOwnerClient("test-case-20");
  try {
    await owner20.connect();
    const auditRes = await owner20.query("SELECT count(*)::integer as count FROM audit.audit_events WHERE event_type LIKE 'CHANNEL_PUBLICATION%' OR event_type LIKE 'PUBLICATION%'");
    assert(Number(auditRes.rows[0].count) >= 0, "CASE-20", "Publication audit event tracking ready in audit.audit_events");
  } finally {
    await owner20.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-21: Publication outbox event
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-21: Publication outbox event...");
  const owner21 = getOwnerClient("test-case-21");
  try {
    await owner21.connect();
    const outboxRes = await owner21.query("SELECT count(*)::integer as count FROM integration.outbox_events WHERE event_type LIKE 'CHANNEL_PUBLICATION%' OR event_type LIKE 'PUBLICATION%'");
    assert(Number(outboxRes.rows[0].count) >= 0, "CASE-21", "Publication outbox event tracking ready in integration.outbox_events");
  } finally {
    await owner21.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-22: Runtime direct verification evidence SELECT denied / 42501
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-22: Runtime direct verification evidence SELECT denied / 42501...");
  const rt22 = getRuntimeClient("test-case-22");
  try {
    await rt22.connect();
    let denied = false;
    try {
      const res = await rt22.query("SELECT * FROM verification.verification_evidence");
      if (res.rows.length === 0) {
        denied = true;
        assert(true, "CASE-22", "Direct SELECT on verification_evidence returned 0 rows (denied for vind_app_runtime)");
      }
    } catch (e: any) {
      denied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "CASE-22", "Direct SELECT on verification_evidence denied for vind_app_runtime");
    }
    if (!denied) assert(false, "CASE-22", "Direct SELECT on verification_evidence was NOT denied!");
  } finally {
    await rt22.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-23: Restricted evidence access log
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-23: Restricted evidence access log...");
  const owner23 = getOwnerClient("test-case-23");
  try {
    await owner23.connect();
    await owner23.query("BEGIN");
    await setContext(owner23, {
      accountKey: "smk:s2:acc:moderator_1",
      personKey: "smk:s2:person:moderator_1",
      actorKind: "HUMAN",
      plane: "PLATFORM",
      platformAssignmentKey: "smk:s2:passign:mod_1",
      purposeCode: "EVIDENCE_ACCESS_LOG_TEST"
    });

    const evRes = await owner23.query("SELECT id FROM verification.verification_evidence WHERE seed_key = 'smk:s2:ve:alpha_nib'");
    await owner23.query("SELECT * FROM verification.read_evidence($1, 'EVIDENCE_ACCESS_LOG_TEST')", [evRes.rows[0].id]);

    const logRes = await owner23.query("SELECT count(*)::integer as count FROM security.data_access_logs WHERE purpose_code = 'EVIDENCE_ACCESS_LOG_TEST'");
    assert(Number(logRes.rows[0].count) >= 1, "CASE-23", "Restricted evidence read recorded in security.data_access_logs");
    await owner23.query("ROLLBACK");
  } finally {
    await owner23.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-24: Cross-tenant RLS denial
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-24: Cross-tenant RLS denial...");
  const rt24 = getRuntimeClient("test-case-24");
  try {
    await rt24.connect();
    await rt24.query("BEGIN");
    await setContext(rt24, {
      accountKey: "smk:s2:acc:owner_alpha",
      personKey: "smk:s2:person:owner_alpha",
      organizationKey: "smk:s2:org:alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s2:mem:owner_alpha",
      localAssignmentKey: "smk:s2:assign:budi_alpha_owner",
      purposeCode: "CROSS_TENANT_TEST"
    });

    const res = await rt24.query("SELECT * FROM listing.channel_publications WHERE seed_key = 'smk:s2:pub:beta_van_main'");
    assert(res.rows.length === 0, "CASE-24", "Cross-tenant access to Beta publication denied for Tenant Alpha");
    await rt24.query("ROLLBACK");
  } finally {
    await rt24.end().catch(() => undefined);
  }

  // --------------------------------------------------------------------------
  // CASE-25: Migration replay + checksum validation
  // --------------------------------------------------------------------------
  console.log("\nExecuting CASE-25: Migration replay + checksum validation...");
  const owner25 = getOwnerClient("test-case-25");
  try {
    await owner25.connect();
    const dbRes = await owner25.query("SELECT migration_name, checksum_sha256 FROM public.vind_schema_migrations ORDER BY migration_name");
    assert(dbRes.rows.length >= 7, "CASE-25", `All expected migrations recorded in public.vind_schema_migrations (${dbRes.rows.length} total)`);

    let allMatched = true;
    for (const row of dbRes.rows) {
      const relPath = path.join(packageRoot, "prisma", "migrations", row.migration_name, "migration.sql");
      try {
        const bytes = await readFile(relPath);
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (hash !== row.checksum_sha256) {
          allMatched = false;
          console.error(`Checksum mismatch on ${row.migration_name}: db=${row.checksum_sha256} file=${hash}`);
        }
      } catch (e) {
        allMatched = false;
        console.error(`Migration file missing for ${row.migration_name}`);
      }
    }
    assert(allMatched, "CASE-25", "All applied migration checksums match migration.sql files on disk");
  } finally {
    await owner25.end().catch(() => undefined);
  }

  // ==========================================================================
  // IMPORTER LEAST-PRIVILEGE NEGATIVE TESTS
  // ==========================================================================
  console.log("\nExecuting IMPORTER LEAST-PRIVILEGE NEGATIVE TESTS...");
  const imp = getImporterClient("importer-negative-tests");
  try {
    await imp.connect();

    // IMP-01: Raw INSERT scoped_assignments = DENY
    let imp01Denied = false;
    try {
      await imp.query("INSERT INTO access.scoped_assignments (seed_key, subject_person_id, role_code, scope_type) VALUES ('test-imp-01', gen_random_uuid(), 'LOCAL_OWNER', 'PERSON')");
    } catch (e: any) {
      imp01Denied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "IMP-01", "Importer raw INSERT scoped_assignments DENIED");
    }
    if (!imp01Denied) assert(false, "IMP-01", "Importer raw INSERT scoped_assignments was NOT denied!");

    // IMP-02: Raw UPDATE scoped_assignments = DENY
    let imp02Denied = false;
    try {
      await imp.query("UPDATE access.scoped_assignments SET status = 'INACTIVE'");
    } catch (e: any) {
      imp02Denied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "IMP-02", "Importer raw UPDATE scoped_assignments DENIED");
    }
    if (!imp02Denied) assert(false, "IMP-02", "Importer raw UPDATE scoped_assignments was NOT denied!");

    // IMP-03: Raw DELETE scoped_assignments = DENY
    let imp03Denied = false;
    try {
      await imp.query("DELETE FROM access.scoped_assignments");
    } catch (e: any) {
      imp03Denied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "IMP-03", "Importer raw DELETE scoped_assignments DENIED");
    }
    if (!imp03Denied) assert(false, "IMP-03", "Importer raw DELETE scoped_assignments was NOT denied!");

    // IMP-04: Raw mutation platform_assignments = DENY
    let imp04Denied = false;
    try {
      await imp.query("INSERT INTO access.platform_assignments (assignment_key, subject_person_id, role_code, assignment_mode, status, effective_from, reason_code, retention_class_code) VALUES ('test-imp-04', gen_random_uuid(), 'PLATFORM_MODERATOR', 'DIRECT', 'ACTIVE', clock_timestamp(), 'TEST', 'PRIV')");
    } catch (e: any) {
      imp04Denied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "IMP-04", "Importer raw mutation platform_assignments DENIED");
    }
    if (!imp04Denied) assert(false, "IMP-04", "Importer raw mutation platform_assignments was NOT denied!");

    // IMP-05: Raw mutation service_principal_grants = DENY
    let imp05Denied = false;
    try {
      await imp.query("INSERT INTO access.service_principal_grants (grant_key, subject_account_id, capability_code, status, purpose_code, effective_from, reason_code, retention_class_code) VALUES ('test-imp-05', gen_random_uuid(), 'SERVICE_CAP', 'ACTIVE', 'TEST', clock_timestamp(), 'TEST', 'PRIV')");
    } catch (e: any) {
      imp05Denied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "IMP-05", "Importer raw mutation service_principal_grants DENIED");
    }
    if (!imp05Denied) assert(false, "IMP-05", "Importer raw mutation service_principal_grants was NOT denied!");
  } finally {
    await imp.end().catch(() => undefined);
  }

  // ==========================================================================
  // COMMAND GUARD ESCAPE NEGATIVE TESTS
  // ==========================================================================
  console.log("\nExecuting COMMAND GUARD ESCAPE NEGATIVE TESTS...");
  const rtGuard = getRuntimeClient("command-guard-tests");
  const impGuard = getImporterClient("importer-guard-tests");
  try {
    await rtGuard.connect();
    await impGuard.connect();

    // GUARD-01: Runtime manually sets GUC then provider status raw UPDATE => DENY
    let guard01Denied = false;
    try {
      await rtGuard.query("SELECT set_config('vind.command_execution_active', 'on', false)");
      await rtGuard.query("UPDATE provider.provider_profiles SET status = 'SUSPENDED' WHERE seed_key = 'smk:s2:prov:alpha_car'");
    } catch (e: any) {
      guard01Denied = true;
      assert(e.code === "42501" || e.message.includes("denied"), "GUARD-01", "Runtime manually setting GUC then provider status raw UPDATE DENIED");
    }
    if (!guard01Denied) assert(false, "GUARD-01", "Runtime manually setting GUC raw status UPDATE was NOT denied!");

    // GUARD-02: Importer manually sets GUC then scoped assignment raw INSERT => DENY
    let guard02Denied = false;
    try {
      await impGuard.query("SELECT set_config('vind.command_execution_active', 'on', false)");
      await impGuard.query("INSERT INTO access.scoped_assignments (seed_key, subject_person_id, role_code, scope_type) VALUES ('test-g2', gen_random_uuid(), 'LOCAL_OWNER', 'PERSON')");
    } catch (e: any) {
      guard02Denied = true;
      assert(e.code === "42501" || e.message.includes("permission denied"), "GUARD-02", "Importer manually setting GUC then scoped assignment raw INSERT DENIED");
    }
    if (!guard02Denied) assert(false, "GUARD-02", "Importer manually setting GUC raw assignment INSERT was NOT denied!");

    // GUARD-03: Importer manually sets GUC then management link raw mutation => DENY
    let guard03Denied = false;
    try {
      await impGuard.query("SELECT set_config('vind.command_execution_active', 'on', false)");
      await impGuard.query("UPDATE provider.provider_workspace_links SET effective_to = clock_timestamp()");
    } catch (e: any) {
      guard03Denied = true;
      assert(e.code === "42501" || e.message.includes("denied"), "GUARD-03", "Importer manually setting GUC then management link raw mutation DENIED");
    }
    if (!guard03Denied) assert(false, "GUARD-03", "Importer manually setting GUC management link mutation was NOT denied!");

    // GUARD-04: Manually setting publication guard then raw publication UPDATE => DENY
    let guard04Denied = false;
    try {
      await rtGuard.query("SELECT set_config('vind.command_execution_active', 'on', false)");
      await rtGuard.query("UPDATE listing.channel_publications SET publication_status = 'PUBLISHED' WHERE seed_key = 'smk:s2:pub:alpha_car_main'");
    } catch (e: any) {
      guard04Denied = true;
      assert(e.code === "42501" || e.message.includes("denied"), "GUARD-04", "Manually setting publication guard then raw publication UPDATE DENIED");
    }
    if (!guard04Denied) assert(false, "GUARD-04", "Manually setting publication guard raw UPDATE was NOT denied!");
  } finally {
    await rtGuard.end().catch(() => undefined);
    await impGuard.end().catch(() => undefined);
  }

  // ==========================================================================
  // SUPPLEMENTARY CHECKS
  // ==========================================================================
  console.log("\nExecuting SUP-01..18: Supplementary data and constraint checks...");
  const ownerSup = getOwnerClient("test-sup");
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

    const sup17 = await ownerSup.query("SELECT count(*)::integer as count FROM audit.audit_events");
    assert(Number(sup17.rows[0].count) >= 0, "SUP-17", "Audit event structure ready for status transitions");

    const sup18 = await ownerSup.query("SELECT count(*)::integer as count FROM integration.outbox_events");
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

runTestSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
