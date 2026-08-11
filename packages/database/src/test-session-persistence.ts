import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

dotenv.config({ path: path.join(packageRoot, ".env") });
dotenv.config({ path: path.join(repoRoot, ".env") });

const runtimeUrl = process.env.DATABASE_URL;
const bootstrapUser = process.env.POSTGRES_USER || "vind_bootstrap";
const bootstrapPassword = process.env.POSTGRES_PASSWORD;
const dbPort = process.env.POSTGRES_PORT || "5432";
const dbName = process.env.POSTGRES_DB || "vind_app_dev";

if (!runtimeUrl || !bootstrapPassword) {
  throw new Error("DATABASE_URL and POSTGRES_PASSWORD are required.");
}

const bootstrapUrl = `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${dbPort}/${dbName}`;
const importerUrl = process.env.DATABASE_IMPORT_URL || `postgresql://vind_importer:1b4798aa24c093fcd92283427c6d30db5948a882fea236746c327b2b0bd7ce70@127.0.0.1:${dbPort}/${dbName}`;

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failCount++;
    throw new Error(`Test assertion failed: ${message}`);
  }
}

function generateDigest(rawToken: string): Buffer {
  return createHash("sha256").update(rawToken).digest();
}

async function runSessionTestHarness() {
  console.log("==========================================================================");
  console.log("DB-HO-03-03 SESSION PERSISTENCE SECURITY & CONTRACT TEST HARNESS");
  console.log("==========================================================================");

  const runtimeClient = new Client({ connectionString: runtimeUrl });
  const bootstrapClient = new Client({ connectionString: bootstrapUrl });
  const importerClient = new Client({ connectionString: importerUrl });

  await runtimeClient.connect();
  await bootstrapClient.connect();
  await importerClient.connect();

  try {
    // SESS-01: Structure & Relation Verification
    console.log("\nExecuting SESS-01: Structure & Relation Verification...");
    const regRes = await runtimeClient.query(`SELECT to_regclass('identity.auth_sessions')::text AS regclass`);
    assert(Boolean(regRes.rows[0]?.regclass), "SESS-01: Relation identity.auth_sessions exists");

    // Retrieve seeded account / person / assignment fixtures
    const humanAccountRes = await bootstrapClient.query(`
      SELECT a.id AS account_id, il.id AS identity_link_id, il.person_id
      FROM identity.accounts a
      JOIN identity.identity_links il ON il.account_id = a.id
      WHERE a.account_type = 'HUMAN' AND a.status = 'ACTIVE' AND il.status = 'ACTIVE'
      LIMIT 1
    `);
    assert(humanAccountRes.rows.length > 0, "SESS-02 Fixture: Active HUMAN account & identity link found");
    const humanAccountId = humanAccountRes.rows[0].account_id;

    const serviceAccountRes = await bootstrapClient.query(`
      SELECT a.id AS account_id, spg.id AS grant_id
      FROM identity.accounts a
      JOIN access.service_principal_grants spg ON spg.subject_account_id = a.id
      WHERE a.account_type = 'SERVICE' AND a.status = 'ACTIVE' AND spg.status = 'ACTIVE'
      LIMIT 1
    `);
    assert(serviceAccountRes.rows.length > 0, "SESS-03 Fixture: Active SERVICE account & grant found");
    const serviceAccountId = serviceAccountRes.rows[0].account_id;
    const serviceGrantId = serviceAccountRes.rows[0].grant_id;

    // SESS-02: Valid HUMAN Session Creation
    console.log("\nExecuting SESS-02: Valid HUMAN Session Creation...");
    const rawTokenHuman = randomBytes(32).toString("hex");
    const digestHuman = generateDigest(rawTokenHuman);

    const createHumanRes = await runtimeClient.query(
      `SELECT identity.create_auth_session($1, $2, $3) AS session_id`,
      [humanAccountId, digestHuman, "RELATIONSHIP"]
    );
    const humanSessionId = createHumanRes.rows[0]?.session_id;
    assert(Boolean(humanSessionId), "SESS-02: HUMAN RELATIONSHIP session created successfully");

    // SESS-03: Valid SERVICE Session Creation
    console.log("\nExecuting SESS-03: Valid SERVICE Session Creation...");
    const rawTokenService = randomBytes(32).toString("hex");
    const digestService = generateDigest(rawTokenService);

    const createServiceRes = await runtimeClient.query(
      `SELECT identity.create_auth_session($1, $2, $3, null, null, $4) AS session_id`,
      [serviceAccountId, digestService, "SERVICE", serviceGrantId]
    );
    const serviceSessionId = createServiceRes.rows[0]?.session_id;
    assert(Boolean(serviceSessionId), "SESS-03: SERVICE session created successfully");

    // SESS-04: Token Digest Only (No Raw Token Persisted)
    console.log("\nExecuting SESS-04: Security Verification — Digest Only Persisted...");
    const dbRowRes = await bootstrapClient.query(
      `SELECT token_digest::text AS digest_hex FROM identity.auth_sessions WHERE id = $1`,
      [humanSessionId]
    );
    assert(dbRowRes.rows[0]?.digest_hex.includes(digestHuman.toString("hex")), "SESS-04: DB contains exact SHA-256 bytea digest");

    const secEventRes = await bootstrapClient.query(
      `SELECT details::text AS details_txt FROM security.security_events WHERE subject_key = $1`,
      [humanSessionId]
    );
    const detailsTxt = secEventRes.rows[0]?.details_txt || "";
    assert(!detailsTxt.includes(rawTokenHuman), "SESS-04: Security event logs do NOT leak raw token");

    // SESS-05: Unknown Digest Fails Closed
    console.log("\nExecuting SESS-05: Unknown Digest Fails Closed...");
    const unknownDigest = generateDigest("unknown_token_material_999");
    const resolveUnknownRes = await runtimeClient.query(
      `SELECT * FROM identity.resolve_auth_session($1)`,
      [unknownDigest]
    );
    assert(resolveUnknownRes.rows.length === 0, "SESS-05: Resolution for unknown digest returns 0 rows");

    // SESS-06: Resolve Valid Session & Advance Last Activity
    console.log("\nExecuting SESS-06: Resolve Session & Activity Persistence...");
    const resolveHumanRes = await runtimeClient.query(
      `SELECT * FROM identity.resolve_auth_session($1)`,
      [digestHuman]
    );
    assert(resolveHumanRes.rows.length === 1, "SESS-06: Valid HUMAN session resolved");
    assert(resolveHumanRes.rows[0].account_id === humanAccountId, "SESS-06: Account ID matches");

    // SESS-07: Explicit Revocation & Subsequent Resolution Denial
    console.log("\nExecuting SESS-07: Explicit Revocation...");
    const revokeRes = await runtimeClient.query(
      `SELECT identity.revoke_auth_session($1, $2) AS revoked`,
      [digestHuman, "LOGOUT_USER"]
    );
    assert(revokeRes.rows[0]?.revoked === true, "SESS-07: Revoke returns true");

    const resolveRevokedRes = await runtimeClient.query(
      `SELECT * FROM identity.resolve_auth_session($1)`,
      [digestHuman]
    );
    assert(resolveRevokedRes.rows.length === 0, "SESS-07: Resolved row empty after revocation");

    // SESS-08: Idempotent Revoke
    console.log("\nExecuting SESS-08: Idempotent Double Revocation...");
    const reRevokeRes = await runtimeClient.query(
      `SELECT identity.revoke_auth_session($1, $2) AS revoked`,
      [digestHuman, "LOGOUT_USER"]
    );
    assert(reRevokeRes.rows[0]?.revoked === true, "SESS-08: Idempotent revoke returns true without resurrecting");

    // SESS-14: Account-wide Revocation
    console.log("\nExecuting SESS-14: Account-Wide Logout...");
    const rawTokenAcc1 = randomBytes(32).toString("hex");
    const digestAcc1 = generateDigest(rawTokenAcc1);
    await runtimeClient.query(
      `SELECT identity.create_auth_session($1, $2, $3, NULL, NULL, $4)`,
      [serviceAccountId, digestAcc1, "SERVICE", serviceGrantId]
    );

    const revokeAccRes = await runtimeClient.query(
      `SELECT identity.revoke_account_sessions($1, $2, false) AS revoked_count`,
      [digestService, "SECURITY_PASSWORD_CHANGE"]
    );
    assert(revokeAccRes.rows[0]?.revoked_count >= 1, "SESS-14: Account-wide logout revoked expected sessions");

    // SESS-15: Session Rotation
    console.log("\nExecuting SESS-15: Session Rotation...");
    const rawTokenRotOld = randomBytes(32).toString("hex");
    const digestRotOld = generateDigest(rawTokenRotOld);
    const oldSessionId = (await runtimeClient.query(
      `SELECT identity.create_auth_session($1, $2, $3, NULL, NULL, $4) AS session_id`,
      [serviceAccountId, digestRotOld, "SERVICE", serviceGrantId]
    )).rows[0].session_id;

    const rawTokenRotNew = randomBytes(32).toString("hex");
    const digestRotNew = generateDigest(rawTokenRotNew);

    const rotateRes = await runtimeClient.query(
      `SELECT identity.rotate_auth_session($1, $2, $3, NULL, NULL, $4) AS new_session_id`,
      [digestRotOld, digestRotNew, "SERVICE", serviceGrantId]
    );
    const newSessionId = rotateRes.rows[0]?.new_session_id;
    assert(Boolean(newSessionId), "SESS-15: Rotation succeeded, returned new_session_id");

    const resolveOldRot = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestRotOld]);
    assert(resolveOldRot.rows.length === 0, "SESS-15: Old rotated digest is invalid");

    const resolveNewRot = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestRotNew]);
    assert(resolveNewRot.rows.length === 1, "SESS-15: New rotated digest is valid");

    // SESS-16 / SESS-17: Runtime Direct Table Access Denied (42501)
    console.log("\nExecuting SESS-16/17: Direct Runtime Privileges Denied (42501)...");
    try {
      await runtimeClient.query(`SELECT * FROM identity.auth_sessions LIMIT 1`);
      assert(false, "SESS-16: Direct SELECT on auth_sessions should fail");
    } catch (err: any) {
      assert(err.code === "42501", "SESS-16: Direct SELECT denied with SQLSTATE 42501");
    }

    try {
      await runtimeClient.query(
        `INSERT INTO identity.auth_sessions (account_id, authority_plane, token_digest, auth_assurance_level, absolute_expires_at) VALUES ($1, 'RELATIONSHIP', '12345678901234567890123456789012', 'BASIC', clock_timestamp() + interval '1 hour')`,
        [humanAccountId]
      );
      assert(false, "SESS-17: Direct INSERT on auth_sessions should fail");
    } catch (err: any) {
      assert(err.code === "42501", "SESS-17: Direct INSERT denied with SQLSTATE 42501");
    }

    // SESS-18: Importer Privileges Denied (42501)
    console.log("\nExecuting SESS-18: Importer Direct Access Denied...");
    try {
      await importerClient.query(`SELECT * FROM identity.auth_sessions LIMIT 1`);
      assert(false, "SESS-18: Importer direct SELECT should fail");
    } catch (err: any) {
      assert(err.code === "42501", "SESS-18: Importer SELECT denied with SQLSTATE 42501");
    }

    // SESS-20: Retention Cleanup
    console.log("\nExecuting SESS-20: Retention Purge Function...");
    const purgeRes = await bootstrapClient.query(`SELECT identity.purge_auth_sessions() AS purged_count`);
    assert(typeof purgeRes.rows[0]?.purged_count === "number", "SESS-20: Purge function executed successfully");

  } finally {
    await runtimeClient.end().catch(() => {});
    await bootstrapClient.end().catch(() => {});
    await importerClient.end().catch(() => {});
  }

  console.log("\n==========================================================================");
  console.log(`TEST RESULTS SUMMARY: PASSED=${passCount}, FAILED=${failCount}`);
  console.log("==========================================================================");

  if (failCount > 0) {
    process.exit(1);
  }
}

runSessionTestHarness().catch((err) => {
  console.error("Test Harness Failure:", err);
  process.exit(1);
});
