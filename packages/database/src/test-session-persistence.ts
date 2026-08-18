import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import { Client } from "pg";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

dotenv.config({ path: path.join(packageRoot, ".env") });
dotenv.config({ path: path.join(repoRoot, ".env") });

const runtimeUrlRaw = process.env.DATABASE_URL;
const importerUrlRaw = process.env.DATABASE_IMPORT_URL;
const migrationUrlRaw = process.env.DATABASE_MIGRATION_URL;
const bootstrapUser = process.env.POSTGRES_USER || "postgres";
const bootstrapPassword = process.env.POSTGRES_PASSWORD || "postgres";
const dbPort = process.env.POSTGRES_PORT || "5432";
const targetPort = migrationUrlRaw ? (new URL(migrationUrlRaw).port || dbPort) : dbPort;
const mainDbName = process.env.POSTGRES_DB || "vind_app_dev";

if (!runtimeUrlRaw || !bootstrapPassword || !importerUrlRaw || !migrationUrlRaw) {
  throw new Error("DATABASE_URL, POSTGRES_PASSWORD, DATABASE_IMPORT_URL, and DATABASE_MIGRATION_URL are required in environment.");
}

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
  console.log("DB-HO-03-03 HARDENED SESSION PERSISTENCE TEST HARNESS (SESS-01..28)");
  console.log("==========================================================================");

  // 1. Create isolated clean acceptance database
  const acceptDbName = `vind_app_accept_dbho0303_${Date.now()}`;
  console.log(`\nCreating isolated temporary acceptance database: ${acceptDbName}...`);

  const adminClient = new Client({
    connectionString: `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${targetPort}/${mainDbName}`
  });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${acceptDbName}" OWNER vind_db_owner`);
  await adminClient.end();

  // Construct connection URLs for isolated database dynamically without hardcoded passwords
  const isoBootstrapUrl = `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${targetPort}/${acceptDbName}`;

  const migUrlObj = new URL(migrationUrlRaw!);
  migUrlObj.pathname = `/${acceptDbName}`;
  const isoMigratorUrl = migUrlObj.toString();

  const runUrlObj = new URL(runtimeUrlRaw!);
  runUrlObj.pathname = `/${acceptDbName}`;
  const isoRuntimeUrl = runUrlObj.toString();

  const impUrlObj = new URL(importerUrlRaw!);
  impUrlObj.pathname = `/${acceptDbName}`;
  const isoImporterUrl = impUrlObj.toString();

  // Initialize extensions, logical schemas & grants on isolated database
  const schemaBootstrapSql = `
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    DO $$
    DECLARE
        schema_name text;
        schema_names text[] := ARRAY[
            'identity', 'party', 'privacy', 'organization', 'access', 'geo',
            'provider', 'verification', 'catalog', 'listing', 'media',
            'availability', 'engagement', 'messaging', 'commercial', 'content',
            'ads', 'sponsor', 'finance', 'audit', 'security', 'integration', 'staging'
        ];
    BEGIN
        FOREACH schema_name IN ARRAY schema_names LOOP
            EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION vind_db_owner', schema_name);
            EXECUTE format('ALTER SCHEMA %I OWNER TO vind_db_owner', schema_name);
            EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', schema_name);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA %I REVOKE ALL ON TABLES FROM PUBLIC', schema_name);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM PUBLIC', schema_name);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM PUBLIC', schema_name);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA %I REVOKE ALL ON TYPES FROM PUBLIC', schema_name);
        END LOOP;
    END
    $$;

    GRANT USAGE ON SCHEMA identity, party, privacy, organization, access, geo, provider, verification, catalog, listing, media, availability, engagement, messaging, commercial, content, ads, sponsor, finance, security, integration TO vind_app_runtime;
    GRANT USAGE ON SCHEMA identity, party, privacy, organization, access, geo, provider, verification, catalog, listing, media, availability, engagement, messaging, commercial, content, ads, sponsor, finance, staging TO vind_importer;
  `;

  const foundationClient = new Client({ connectionString: isoBootstrapUrl });
  await foundationClient.connect();
  await foundationClient.query(schemaBootstrapSql);
  await foundationClient.end();

  const envOverrides = {
    ...process.env,
    POSTGRES_DB: acceptDbName,
    DATABASE_URL: isoRuntimeUrl,
    DATABASE_IMPORT_URL: isoImporterUrl,
    DATABASE_MIGRATION_URL: isoMigratorUrl,
    DATABASE_INTROSPECTION_URL: isoMigratorUrl,
  };

  try {
    // SESS-22: Zero-to-head migration on isolated clean database
    console.log("\nExecuting SESS-22: Clean Zero-to-Head Migration on Isolated Database...");
    execFileSync("npx", ["tsx", "src/migrate.ts"], { cwd: packageRoot, env: envOverrides, stdio: "pipe", shell: true });
    assert(true, "SESS-22: Zero-to-head migration completed successfully on clean database");

    // SESS-23: Second migration execution = 0 applied
    console.log("\nExecuting SESS-23: Replay Migration Execution...");
    const replayOutput = execFileSync("npx", ["tsx", "src/migrate.ts"], { cwd: packageRoot, env: envOverrides, stdio: "pipe", shell: true }).toString();
    assert(replayOutput.includes("0 applied") || replayOutput.includes("0 pending"), "SESS-23: Replay migration verified 0 applied");

    // SESS-24: Checksum validation against actual disk SHA-256 files
    console.log("\nExecuting SESS-24: Migration Ledger Checksum Verification...");
    const ledgerClient = new Client({ connectionString: isoMigratorUrl });
    await ledgerClient.connect();
    await ledgerClient.query("SET ROLE vind_db_owner");
    const ledgerRes = await ledgerClient.query("SELECT migration_name, checksum_sha256 FROM public.vind_schema_migrations ORDER BY migration_name");
    await ledgerClient.end();

    const migrationsDir = path.join(packageRoot, "prisma", "migrations");
    for (const row of ledgerRes.rows) {
      const sqlPath = path.join(migrationsDir, row.migration_name, "migration.sql");
      const fileBuf = fs.readFileSync(sqlPath);
      const diskHash = createHash("sha256").update(fileBuf).digest("hex");
      assert(diskHash === row.checksum_sha256, `SESS-24: Checksum match for ${row.migration_name}`);
    }

    // Initialize Seeds (SMK Slice 1, Slice 2, Media Metadata) on isolated acceptance database
    console.log("\nSeeding Isolated Acceptance Database...");
    const smk1Sql = fs.readFileSync(path.join(packageRoot, "prisma", "seeds", "smk-slice-1", "seed.sql"), "utf-8");
    const smk2Sql = fs.readFileSync(path.join(packageRoot, "prisma", "seeds", "smk-slice-2", "seed.sql"), "utf-8");
    const mediaSql = fs.readFileSync(path.join(packageRoot, "prisma", "seeds", "smk-slice-2", "media-fixture-metadata.sql"), "utf-8");

    const seedClient = new Client({ connectionString: isoMigratorUrl });
    await seedClient.connect();
    await seedClient.query("SET ROLE vind_db_owner");

    await seedClient.query(smk1Sql);
    await seedClient.query(smk2Sql);
    await seedClient.query(mediaSql);

    // Insert synthetic SERVICE account & grant fixture if not present
    await seedClient.query(`
      INSERT INTO identity.accounts (seed_key, account_type, status, data_origin_code, source_reference)
      VALUES ('sess:test:account:service', 'SERVICE', 'ACTIVE', 'SYNTHETIC_DEMO', 'sess:test-harness')
      ON CONFLICT (seed_key) DO NOTHING;

      INSERT INTO access.service_principal_grants (grant_key, subject_account_id, capability_code, status, purpose_code, effective_from, reason_code)
      SELECT 'sess:test:service_grant', a.id, 'listing.publication.transition', 'ACTIVE', 'SESSION_PERSISTENCE_TEST', clock_timestamp() - interval '1 hour', 'TEST_SUITE'
      FROM identity.accounts a
      WHERE a.seed_key = 'sess:test:account:service'
      ON CONFLICT (grant_key) DO NOTHING;
    `);

    await seedClient.end();
    console.log("Isolated acceptance database seeded successfully.");

    // Connect clients to isolated database
    const runtimeClient = new Client({ connectionString: isoRuntimeUrl });
    const bootstrapClient = new Client({ connectionString: isoBootstrapUrl });
    const importerClient = new Client({ connectionString: isoImporterUrl });

    await runtimeClient.connect();
    await bootstrapClient.connect();
    await importerClient.connect();

    try {
      // SESS-01: Structural verification
      console.log("\nExecuting SESS-01: Structure & Relation Verification...");
      const regRes = await runtimeClient.query(`SELECT to_regclass('identity.auth_sessions')::text AS regclass`);
      assert(Boolean(regRes.rows[0]?.regclass), "SESS-01: Relation identity.auth_sessions exists");

      // Fixtures
      const humanAccRes = await bootstrapClient.query(`
        SELECT a.id AS account_id, a.seed_key AS account_key, il.id AS identity_link_id, il.person_id, p.seed_key AS person_key
        FROM identity.accounts a
        JOIN identity.identity_links il ON il.account_id = a.id
        JOIN party.persons p ON p.id = il.person_id
        WHERE a.account_type = 'HUMAN' AND a.status = 'ACTIVE' AND il.status = 'ACTIVE' AND p.status = 'ACTIVE'
        LIMIT 1
      `);
      assert(humanAccRes.rows.length > 0, "SESS-02 Fixture: Active HUMAN account & link found");
      const humanAccountId = humanAccRes.rows[0].account_id;
      const humanAccountKey = humanAccRes.rows[0].account_key;
      const humanPersonKey = humanAccRes.rows[0].person_key;

      const serviceAccRes = await bootstrapClient.query(`
        SELECT a.id AS account_id, a.seed_key AS account_key, spg.id AS grant_id, spg.grant_key
        FROM identity.accounts a
        JOIN access.service_principal_grants spg ON spg.subject_account_id = a.id
        WHERE a.account_type = 'SERVICE' AND a.status = 'ACTIVE' AND spg.status = 'ACTIVE'
        LIMIT 1
      `);
      assert(serviceAccRes.rows.length > 0, "SESS-03 Fixture: Active SERVICE account & grant found");
      const serviceAccountId = serviceAccRes.rows[0].account_id;
      const serviceGrantId = serviceAccRes.rows[0].grant_id;
      const serviceGrantKey = serviceAccRes.rows[0].grant_key;
      const serviceAccountKey = serviceAccRes.rows[0].account_key;

      // SESS-11 Fixture: Explicit membership-backed LOCAL assignment required (membership_id IS NOT NULL)
      const localAssRes = await bootstrapClient.query(`
        SELECT sa.id AS assignment_id, sa.membership_id, sa.seed_key AS assignment_key, sa.subject_person_id, il.account_id
        FROM access.scoped_assignments sa
        JOIN identity.identity_links il ON il.person_id = sa.subject_person_id
        JOIN identity.accounts a ON a.id = il.account_id
        WHERE sa.status = 'ACTIVE' AND a.status = 'ACTIVE' AND il.status = 'ACTIVE' AND sa.membership_id IS NOT NULL
        LIMIT 1
      `);
      assert(localAssRes.rows.length > 0, "SESS-11 Fixture: Explicit membership-backed LOCAL assignment fixture found");
      const localAssId = localAssRes.rows[0].assignment_id;
      const localAssMembershipId = localAssRes.rows[0].membership_id;
      assert(Boolean(localAssMembershipId), "SESS-11 Fixture: membership_id IS NOT NULL required (NO conditional skip)");
      const localAssAccountId = localAssRes.rows[0].account_id;

      // SESS-02: Valid HUMAN session creation
      console.log("\nExecuting SESS-02: Valid HUMAN Session Creation...");
      const rawTokenHuman = randomBytes(32).toString("hex");
      const digestHuman = generateDigest(rawTokenHuman);

      const createHumanRes = await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3) AS session_id`,
        [humanAccountId, digestHuman, "RELATIONSHIP"]
      );
      const humanSessionId = createHumanRes.rows[0]?.session_id;
      assert(Boolean(humanSessionId), "SESS-02: HUMAN RELATIONSHIP session created successfully");

      // SESS-03: Valid SERVICE session creation
      console.log("\nExecuting SESS-03: Valid SERVICE Session Creation...");
      const rawTokenService = randomBytes(32).toString("hex");
      const digestService = generateDigest(rawTokenService);

      const createServiceRes = await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3, NULL, NULL, $4) AS session_id`,
        [serviceAccountId, digestService, "SERVICE", serviceGrantId]
      );
      const serviceSessionId = createServiceRes.rows[0]?.session_id;
      assert(Boolean(serviceSessionId), "SESS-03: SERVICE session created successfully");

      // SESS-04: Security verification — Digest only persisted
      console.log("\nExecuting SESS-04: Security Verification — Digest Only Persisted...");
      const dbDigestRes = await bootstrapClient.query(
        `SELECT token_digest::text AS digest_hex FROM identity.auth_sessions WHERE id = $1`,
        [humanSessionId]
      );
      assert(dbDigestRes.rows[0]?.digest_hex.includes(digestHuman.toString("hex")), "SESS-04: DB row contains exact 32-byte SHA-256 digest");

      const secEventRes = await bootstrapClient.query(
        `SELECT actor_account_key, actor_person_key, subject_key, retention_class_code FROM security.security_events WHERE subject_key = $1 AND event_type = 'AUTH_SESSION_CREATED'`,
        [humanSessionId]
      );
      assert(secEventRes.rows[0]?.actor_account_key === humanAccountKey, "SESS-04/19: Security event contains canonical actor_account_key");
      assert(secEventRes.rows[0]?.actor_person_key === humanPersonKey, "SESS-04/19: Security event contains canonical actor_person_key");
      assert(secEventRes.rows[0]?.retention_class_code === 'SEC', "SESS-04/19: AUTH_SESSION_CREATED security event retention is SEC");

      // SESS-05: Unknown digest fails closed
      console.log("\nExecuting SESS-05: Unknown Digest Fails Closed...");
      const unknownDigest = generateDigest("non_existent_token_material_999");
      const resolveUnknownRes = await runtimeClient.query(
        `SELECT * FROM identity.resolve_auth_session($1)`,
        [unknownDigest]
      );
      assert(resolveUnknownRes.rows.length === 0, "SESS-05: Resolution for unknown digest returns 0 rows");

      // SESS-06: Resolve valid session & Request Context V2 keys
      console.log("\nExecuting SESS-06: Resolve Session & Request Context V2 Key Contract...");
      const resolveRes = await runtimeClient.query(
        `SELECT * FROM identity.resolve_auth_session($1)`,
        [digestHuman]
      );
      assert(resolveRes.rows.length === 1, "SESS-06: Valid HUMAN session resolved");
      assert(resolveRes.rows[0].actor_account_key === humanAccountKey, "SESS-06/V2: Returned canonical actor_account_key");
      assert(resolveRes.rows[0].actor_person_key === humanPersonKey, "SESS-06/V2: Returned canonical actor_person_key");
      assert(resolveRes.rows[0].actor_kind === "HUMAN", "SESS-06/V2: Returned actor_kind = HUMAN");
      assert(resolveRes.rows[0].authority_plane === "RELATIONSHIP", "SESS-06/V2: Returned authority_plane = RELATIONSHIP");

      // SESS-07: Explicit Revocation
      console.log("\nExecuting SESS-07: Explicit Revocation...");
      const revokeRes = await runtimeClient.query(
        `SELECT identity.revoke_auth_session($1, $2) AS revoked`,
        [digestHuman, "USER_LOGOUT"]
      );
      assert(revokeRes.rows[0]?.revoked === true, "SESS-07: Revoke returned true");

      const resolveRevokedRes = await runtimeClient.query(
        `SELECT * FROM identity.resolve_auth_session($1)`,
        [digestHuman]
      );
      assert(resolveRevokedRes.rows.length === 0, "SESS-07: Resolved row empty after revocation");

      // SESS-08: Idempotent Double Revocation
      console.log("\nExecuting SESS-08: Idempotent Double Revocation...");
      const reRevokeRes = await runtimeClient.query(
        `SELECT identity.revoke_auth_session($1, $2) AS revoked`,
        [digestHuman, "USER_LOGOUT"]
      );
      assert(reRevokeRes.rows[0]?.revoked === true, "SESS-08: Second revoke returned true without error");

      const revokeCountRes = await bootstrapClient.query(
        `SELECT count(*)::integer AS cnt FROM security.security_events WHERE subject_key = $1 AND event_type = 'AUTH_SESSION_REVOKED'`,
        [humanSessionId]
      );
      assert(revokeCountRes.rows[0]?.cnt === 1, "SESS-08/19: Duplicate revoke emitted exactly 1 security event (no duplicate event)");

      // SESS-09: Account Status Invalidation (LOCKED & DISABLED)
      console.log("\nExecuting SESS-09: Account Status Invalidation (LOCKED & DISABLED)...");
      const rawTokenAccLock = randomBytes(32).toString("hex");
      const digestAccLock = generateDigest(rawTokenAccLock);
      await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3)`,
        [humanAccountId, digestAccLock, "RELATIONSHIP"]
      );

      // Test LOCKED
      await bootstrapClient.query(`UPDATE identity.accounts SET status = 'LOCKED' WHERE id = $1`, [humanAccountId]);
      const resolveLockedRes = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestAccLock]);
      assert(resolveLockedRes.rows.length === 0, "SESS-09: LOCKED account session fails resolution");
      await bootstrapClient.query(`UPDATE identity.accounts SET status = 'ACTIVE' WHERE id = $1`, [humanAccountId]);

      // Test DISABLED
      await bootstrapClient.query(`UPDATE identity.accounts SET status = 'DISABLED' WHERE id = $1`, [humanAccountId]);
      const resolveDisabledRes = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestAccLock]);
      assert(resolveDisabledRes.rows.length === 0, "SESS-09: DISABLED account session fails resolution");
      await bootstrapClient.query(`UPDATE identity.accounts SET status = 'ACTIVE' WHERE id = $1`, [humanAccountId]);

      // SESS-10: Identity Link Status Invalidation
      console.log("\nExecuting SESS-10: Identity Link Status Invalidation...");
      const rawTokenLink = randomBytes(32).toString("hex");
      const digestLink = generateDigest(rawTokenLink);
      await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3)`,
        [humanAccountId, digestLink, "RELATIONSHIP"]
      );

      await bootstrapClient.query(`UPDATE identity.identity_links SET status = 'REVOKED' WHERE account_id = $1`, [humanAccountId]);
      const resolveLinkRes = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLink]);
      assert(resolveLinkRes.rows.length === 0, "SESS-10: Revoked identity link fails resolution");
      await bootstrapClient.query(`UPDATE identity.identity_links SET status = 'ACTIVE' WHERE account_id = $1`, [humanAccountId]);

      // SESS-11: LOCAL Assignment & Membership Invalidation (Full Matrix for Creation & Resolution)
      console.log("\nExecuting SESS-11: LOCAL Assignment & Membership Invalidation...");
      const rawTokenLocal = randomBytes(32).toString("hex");
      const digestLocal = generateDigest(rawTokenLocal);
      await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'LOCAL', $3)`,
        [localAssAccountId, digestLocal, localAssId]
      );

      const resolveLocalActive = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
      assert(resolveLocalActive.rows.length === 1, "SESS-11: Active LOCAL assignment session resolves");

      // 1. Assignment Non-Active
      await bootstrapClient.query(`UPDATE access.scoped_assignments SET status = 'SUSPENDED' WHERE id = $1`, [localAssId]);
      const resolveLocalInactive = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
      assert(resolveLocalInactive.rows.length === 0, "SESS-11: Inactive LOCAL assignment fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'LOCAL', $3)`, [localAssAccountId, generateDigest(randomBytes(32).toString("hex")), localAssId]);
        assert(false, "SESS-11: Creation with inactive scoped_assignment should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-11: Creation rejected when scoped_assignment is inactive");
      }
      await bootstrapClient.query(`UPDATE access.scoped_assignments SET status = 'ACTIVE' WHERE id = $1`, [localAssId]);

      // 2. Assignment Future effective_from
      await bootstrapClient.query(`UPDATE access.scoped_assignments SET effective_from = clock_timestamp() + interval '1 hour' WHERE id = $1`, [localAssId]);
      const resolveLocalFuture = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
      assert(resolveLocalFuture.rows.length === 0, "SESS-11: Future effective_from LOCAL assignment fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'LOCAL', $3)`, [localAssAccountId, generateDigest(randomBytes(32).toString("hex")), localAssId]);
        assert(false, "SESS-11: Creation with future scoped_assignment should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-11: Creation rejected when scoped_assignment is future effective_from");
      }
      await bootstrapClient.query(`UPDATE access.scoped_assignments SET effective_from = clock_timestamp() - interval '1 hour' WHERE id = $1`, [localAssId]);

      // 3. Assignment Expired effective_to (effective_to == v_now boundary test)
      await bootstrapClient.query(`UPDATE access.scoped_assignments SET effective_from = clock_timestamp() - interval '2 hours', effective_to = clock_timestamp() WHERE id = $1`, [localAssId]);
      const resolveLocalExpired = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
      assert(resolveLocalExpired.rows.length === 0, "SESS-11: Expired LOCAL assignment (effective_to == now) fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'LOCAL', $3)`, [localAssAccountId, generateDigest(randomBytes(32).toString("hex")), localAssId]);
        assert(false, "SESS-11: Creation with expired scoped_assignment should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-11: Creation rejected when scoped_assignment is expired");
      }
      await bootstrapClient.query(`UPDATE access.scoped_assignments SET effective_from = clock_timestamp() - interval '1 hour', effective_to = NULL WHERE id = $1`, [localAssId]);

      // 4. Membership Non-Active
      await bootstrapClient.query(`UPDATE access.memberships SET status = 'SUSPENDED' WHERE id = $1`, [localAssMembershipId]);
      const resolveMemSusp = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
      assert(resolveMemSusp.rows.length === 0, "SESS-11: LOCAL session resolve fails when membership suspended");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'LOCAL', $3)`, [localAssAccountId, generateDigest(randomBytes(32).toString("hex")), localAssId]);
        assert(false, "SESS-11: LOCAL session creation with suspended membership should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-11: LOCAL session creation rejected when membership suspended");
      }
      await bootstrapClient.query(`UPDATE access.memberships SET status = 'ACTIVE' WHERE id = $1`, [localAssMembershipId]);

      // 5. Membership Future effective_from
      await bootstrapClient.query(`UPDATE access.memberships SET effective_from = clock_timestamp() + interval '1 hour', accepted_at = clock_timestamp() + interval '2 hours' WHERE id = $1`, [localAssMembershipId]);
      const resolveMemFuture = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
      assert(resolveMemFuture.rows.length === 0, "SESS-11: LOCAL session resolve fails when membership future effective_from");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'LOCAL', $3)`, [localAssAccountId, generateDigest(randomBytes(32).toString("hex")), localAssId]);
        assert(false, "SESS-11: LOCAL session creation with future membership should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-11: LOCAL session creation rejected when membership future effective_from");
      }
      await bootstrapClient.query(`UPDATE access.memberships SET effective_from = clock_timestamp() - interval '1 hour', accepted_at = clock_timestamp() - interval '1 hour' WHERE id = $1`, [localAssMembershipId]);

      // 6. Membership Expired effective_to (effective_to == v_now boundary test)
      await bootstrapClient.query(`UPDATE access.memberships SET effective_from = clock_timestamp() - interval '2 hours', effective_to = clock_timestamp(), accepted_at = clock_timestamp() - interval '2 hours' WHERE id = $1`, [localAssMembershipId]);
      const resolveMemExpired = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
      assert(resolveMemExpired.rows.length === 0, "SESS-11: LOCAL session resolve fails when membership expired (effective_to == now)");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'LOCAL', $3)`, [localAssAccountId, generateDigest(randomBytes(32).toString("hex")), localAssId]);
        assert(false, "SESS-11: LOCAL session creation with expired membership should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-11: LOCAL session creation rejected when membership expired");
      }
      await bootstrapClient.query(`UPDATE access.memberships SET effective_from = clock_timestamp() - interval '1 hour', effective_to = NULL, accepted_at = clock_timestamp() - interval '1 hour' WHERE id = $1`, [localAssMembershipId]);

      // SESS-12: PLATFORM Authority Plane Tests (Full Matrix)
      console.log("\nExecuting SESS-12: PLATFORM Authority Plane Tests...");
      const platAssRes = await bootstrapClient.query(`
        SELECT pa.id AS assignment_id, pa.subject_person_id, il.account_id
        FROM access.platform_assignments pa
        JOIN identity.identity_links il ON il.person_id = pa.subject_person_id
        JOIN identity.accounts a ON a.id = il.account_id
        WHERE pa.status = 'ACTIVE' AND a.status = 'ACTIVE' AND il.status = 'ACTIVE'
        LIMIT 1
      `);
      assert(platAssRes.rows.length > 0, "SESS-12 Fixture: Active PLATFORM assignment found");
      const platAssId = platAssRes.rows[0].assignment_id;
      const platAccountId = platAssRes.rows[0].account_id;

      const rawTokenPlat = randomBytes(32).toString("hex");
      const digestPlat = generateDigest(rawTokenPlat);
      const createPlatRes = await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'PLATFORM', NULL, $3) AS session_id`,
        [platAccountId, digestPlat, platAssId]
      );
      assert(Boolean(createPlatRes.rows[0]?.session_id), "SESS-12: PLATFORM session created successfully");
      const resolvePlatRes = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestPlat]);
      assert(resolvePlatRes.rows[0]?.authority_plane === "PLATFORM", "SESS-12: Resolved PLATFORM session returned authority_plane = PLATFORM");

      // 1. Non-active platform assignment
      await bootstrapClient.query(`UPDATE access.platform_assignments SET status = 'SUSPENDED' WHERE id = $1`, [platAssId]);
      const resolvePlatSusp = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestPlat]);
      assert(resolvePlatSusp.rows.length === 0, "SESS-12: Suspended platform assignment fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'PLATFORM', NULL, $3)`, [platAccountId, generateDigest(randomBytes(32).toString("hex")), platAssId]);
        assert(false, "SESS-12: Creation with suspended platform assignment should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-12: Creation rejected when platform assignment is suspended");
      }
      await bootstrapClient.query(`UPDATE access.platform_assignments SET status = 'ACTIVE' WHERE id = $1`, [platAssId]);

      // 2. Future effective_from
      await bootstrapClient.query(`UPDATE access.platform_assignments SET effective_from = clock_timestamp() + interval '1 hour' WHERE id = $1`, [platAssId]);
      const resolvePlatFuture = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestPlat]);
      assert(resolvePlatFuture.rows.length === 0, "SESS-12: Future platform assignment fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'PLATFORM', NULL, $3)`, [platAccountId, generateDigest(randomBytes(32).toString("hex")), platAssId]);
        assert(false, "SESS-12: Creation with future platform assignment should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-12: Creation rejected when platform assignment is future effective_from");
      }
      await bootstrapClient.query(`UPDATE access.platform_assignments SET effective_from = clock_timestamp() - interval '1 hour' WHERE id = $1`, [platAssId]);

      // 3. Expired effective_to (effective_to == v_now boundary test)
      await bootstrapClient.query(`UPDATE access.platform_assignments SET effective_to = clock_timestamp() WHERE id = $1`, [platAssId]);
      const resolvePlatExp = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestPlat]);
      assert(resolvePlatExp.rows.length === 0, "SESS-12: Expired platform assignment (effective_to == now) fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'PLATFORM', NULL, $3)`, [platAccountId, generateDigest(randomBytes(32).toString("hex")), platAssId]);
        assert(false, "SESS-12: Creation with expired platform assignment should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-12: Creation rejected when platform assignment is expired");
      }
      await bootstrapClient.query(`UPDATE access.platform_assignments SET effective_to = NULL WHERE id = $1`, [platAssId]);

      // SESS-13: SERVICE Authority Plane Tests (Full Matrix)
      console.log("\nExecuting SESS-13: SERVICE Authority Plane Tests...");
      const rawTokenSvc = randomBytes(32).toString("hex");
      const digestSvc = generateDigest(rawTokenSvc);
      const createSvcRes = await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'SERVICE', NULL, NULL, $3) AS session_id`,
        [serviceAccountId, digestSvc, serviceGrantId]
      );
      assert(Boolean(createSvcRes.rows[0]?.session_id), "SESS-13: SERVICE session created successfully");
      const resolveSvcRes = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestSvc]);
      assert(resolveSvcRes.rows[0]?.actor_kind === "SERVICE", "SESS-13: Resolved SERVICE session returned actor_kind = SERVICE");
      assert(resolveSvcRes.rows[0]?.authority_plane === "SERVICE", "SESS-13: Resolved SERVICE session returned authority_plane = SERVICE");
      assert(resolveSvcRes.rows[0]?.service_grant_key === serviceGrantKey, "SESS-13: Resolved SERVICE session returned canonical service_grant_key");

      // 1. Non-active service grant
      await bootstrapClient.query(`UPDATE access.service_principal_grants SET status = 'SUSPENDED' WHERE id = $1`, [serviceGrantId]);
      const resolveSvcSusp = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestSvc]);
      assert(resolveSvcSusp.rows.length === 0, "SESS-13: Suspended service grant fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'SERVICE', NULL, NULL, $3)`, [serviceAccountId, generateDigest(randomBytes(32).toString("hex")), serviceGrantId]);
        assert(false, "SESS-13: Creation with suspended service grant should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-13: Creation rejected when service grant is suspended");
      }
      await bootstrapClient.query(`UPDATE access.service_principal_grants SET status = 'ACTIVE' WHERE id = $1`, [serviceGrantId]);

      // 2. Future effective_from
      await bootstrapClient.query(`UPDATE access.service_principal_grants SET effective_from = clock_timestamp() + interval '1 hour' WHERE id = $1`, [serviceGrantId]);
      const resolveSvcFuture = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestSvc]);
      assert(resolveSvcFuture.rows.length === 0, "SESS-13: Future service grant fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'SERVICE', NULL, NULL, $3)`, [serviceAccountId, generateDigest(randomBytes(32).toString("hex")), serviceGrantId]);
        assert(false, "SESS-13: Creation with future service grant should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-13: Creation rejected when service grant is future effective_from");
      }
      await bootstrapClient.query(`UPDATE access.service_principal_grants SET effective_from = clock_timestamp() - interval '1 hour' WHERE id = $1`, [serviceGrantId]);

      // 3. Expired effective_to (effective_to == v_now boundary test)
      await bootstrapClient.query(`UPDATE access.service_principal_grants SET effective_to = clock_timestamp() WHERE id = $1`, [serviceGrantId]);
      const resolveSvcExp = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestSvc]);
      assert(resolveSvcExp.rows.length === 0, "SESS-13: Expired service grant (effective_to == now) fails resolution");
      try {
        await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'SERVICE', NULL, NULL, $3)`, [serviceAccountId, generateDigest(randomBytes(32).toString("hex")), serviceGrantId]);
        assert(false, "SESS-13: Creation with expired service grant should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-13: Creation rejected when service grant is expired");
      }
      await bootstrapClient.query(`UPDATE access.service_principal_grants SET effective_to = NULL WHERE id = $1`, [serviceGrantId]);

      // SESS-14: Account-Wide Logout (Keep Current = true & false)
      console.log("\nExecuting SESS-14: Account-Wide Logout...");
      const rawTokenAcc1 = randomBytes(32).toString("hex");
      const digestAcc1 = generateDigest(rawTokenAcc1);
      const sess1 = (await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3, NULL, NULL, $4) AS session_id`,
        [serviceAccountId, digestAcc1, "SERVICE", serviceGrantId]
      )).rows[0].session_id;

      const rawTokenAcc2 = randomBytes(32).toString("hex");
      const digestAcc2 = generateDigest(rawTokenAcc2);
      const sess2 = (await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3, NULL, NULL, $4) AS session_id`,
        [serviceAccountId, digestAcc2, "SERVICE", serviceGrantId]
      )).rows[0].session_id;

      const revokeKeepCurrRes = await runtimeClient.query(
        `SELECT identity.revoke_account_sessions($1, $2, true) AS cnt`,
        [digestAcc1, "PASSWORD_RESET"]
      );
      assert(revokeKeepCurrRes.rows[0]?.cnt >= 1, "SESS-14: Account-wide logout with keep_current=true revoked other sessions");

      const resolveSess1 = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestAcc1]);
      assert(resolveSess1.rows.length === 1, "SESS-14: Current session preserved when keep_current=true");

      const resolveSess2 = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestAcc2]);
      assert(resolveSess2.rows.length === 0, "SESS-14: Other session revoked when keep_current=true");

      // Test keep_current = false
      const revokeAllRes = await runtimeClient.query(
        `SELECT identity.revoke_account_sessions($1, $2, false) AS cnt`,
        [digestAcc1, "FORCE_LOGOUT"]
      );
      assert(revokeAllRes.rows[0]?.cnt >= 1, "SESS-14: Account-wide logout with keep_current=false succeeded");
      const resolveSess1After = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestAcc1]);
      assert(resolveSess1After.rows.length === 0, "SESS-14: Current session revoked when keep_current=false");

      // SESS-15: Session Rotation & Lineage Constraints (Lineage UUID & Fresh 4h Expiry Assertion)
      console.log("\nExecuting SESS-15: Session Rotation & Lineage Constraint...");
      const rawTokenRotOld = randomBytes(32).toString("hex");
      const digestRotOld = generateDigest(rawTokenRotOld);
      const oldRotSessId = (await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3, NULL, NULL, $4) AS session_id`,
        [serviceAccountId, digestRotOld, "SERVICE", serviceGrantId]
      )).rows[0].session_id;

      const rawTokenRotNew1 = randomBytes(32).toString("hex");
      const digestRotNew1 = generateDigest(rawTokenRotNew1);

      const rotTime = Date.now();
      const rotRes1 = await runtimeClient.query(
        `SELECT identity.rotate_auth_session($1, $2, $3, NULL, NULL, $4) AS new_session_id`,
        [digestRotOld, digestRotNew1, "SERVICE", serviceGrantId]
      );
      const newRotSessId = rotRes1.rows[0]?.new_session_id;
      assert(Boolean(newRotSessId), "SESS-15: Session rotation succeeded");

      // Assert rotated_from_session_id equals exact old session UUID & new absolute_expires_at reflects fresh SERVICE 4h lifetime
      const newSessRow = (await bootstrapClient.query(
        `SELECT rotated_from_session_id, absolute_expires_at FROM identity.auth_sessions WHERE id = $1`,
        [newRotSessId]
      )).rows[0];
      assert(newSessRow.rotated_from_session_id === oldRotSessId, "SESS-15: rotated_from_session_id matches exact old session UUID");
      const newAbsExpMs = new Date(newSessRow.absolute_expires_at).getTime();
      assert(Math.abs(newAbsExpMs - (rotTime + 4 * 3600 * 1000)) < 60000, "SESS-15: New rotated session absolute_expires_at reflects fresh SERVICE 4h lifetime");

      const resolveOldRot = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestRotOld]);
      assert(resolveOldRot.rows.length === 0, "SESS-15: Old rotated session is invalid");

      const resolveNewRot = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestRotNew1]);
      assert(resolveNewRot.rows.length === 1, "SESS-15: New rotated session is valid");

      // Single rotation child enforcement: second rotation from revoked old session must fail
      const rawTokenRotNew2 = randomBytes(32).toString("hex");
      const digestRotNew2 = generateDigest(rawTokenRotNew2);
      try {
        await runtimeClient.query(
          `SELECT identity.rotate_auth_session($1, $2, $3, NULL, NULL, $4)`,
          [digestRotOld, digestRotNew2, "SERVICE", serviceGrantId]
        );
        assert(false, "SESS-15: Rotation from already-revoked session should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-15: Single rotation child enforced (rejected with 28000)");
      }

      // Idle-expired session rotation rejection
      const rawTokenIdleExp = randomBytes(32).toString("hex");
      const digestIdleExp = generateDigest(rawTokenIdleExp);
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (
          account_id, authority_plane, service_grant_id, token_digest, auth_assurance_level,
          authenticated_at, last_activity_at, absolute_expires_at
        ) VALUES (
          $1, 'SERVICE', $2, $3, 'BASIC',
          clock_timestamp() - interval '14 hours',
          clock_timestamp() - interval '13 hours',
          clock_timestamp() + interval '12 hours'
        )`,
        [serviceAccountId, serviceGrantId, digestIdleExp]
      );

      try {
        const digestIdleNew = generateDigest(randomBytes(32).toString("hex"));
        await runtimeClient.query(`SELECT identity.rotate_auth_session($1, $2, $3, NULL, NULL, $4)`, [digestIdleExp, digestIdleNew, "SERVICE", serviceGrantId]);
        assert(false, "SESS-15: Rotation from idle-expired session should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-15: Idle-expired rotation rejected with SQLSTATE 28000");
      }

      // Absolute-expired session rotation rejection
      const rawTokenAbsExp = randomBytes(32).toString("hex");
      const digestAbsExp = generateDigest(rawTokenAbsExp);
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (
          account_id, authority_plane, service_grant_id, token_digest, auth_assurance_level,
          authenticated_at, last_activity_at, absolute_expires_at
        ) VALUES (
          $1, 'SERVICE', $2, $3, 'BASIC',
          clock_timestamp() - interval '25 hours',
          clock_timestamp() - interval '1 hour',
          clock_timestamp() - interval '1 hour'
        )`,
        [serviceAccountId, serviceGrantId, digestAbsExp]
      );

      try {
        const digestAbsNew = generateDigest(randomBytes(32).toString("hex"));
        await runtimeClient.query(`SELECT identity.rotate_auth_session($1, $2, $3, NULL, NULL, $4)`, [digestAbsExp, digestAbsNew, "SERVICE", serviceGrantId]);
        assert(false, "SESS-15: Rotation from absolute-expired session should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-15: Absolute-expired rotation rejected with SQLSTATE 28000");
      }

      // SESS-16/17: Direct Runtime Privileges Denied (SELECT, INSERT, UPDATE, DELETE all denied)
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

      try {
        await runtimeClient.query(`UPDATE identity.auth_sessions SET last_activity_at = clock_timestamp()`);
        assert(false, "SESS-17: Direct UPDATE on auth_sessions should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-17: Direct UPDATE denied with SQLSTATE 42501");
      }

      try {
        await runtimeClient.query(`DELETE FROM identity.auth_sessions`);
        assert(false, "SESS-17: Direct DELETE on auth_sessions should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-17: Direct DELETE denied with SQLSTATE 42501");
      }

      // SESS-18: Importer Direct Table & Function Access Denied
      console.log("\nExecuting SESS-18: Importer Direct Table & Function Access Denied...");
      try {
        await importerClient.query(`SELECT * FROM identity.auth_sessions LIMIT 1`);
        assert(false, "SESS-18: Importer direct SELECT should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-18: Importer SELECT denied with SQLSTATE 42501");
      }

      try {
        await importerClient.query(`INSERT INTO identity.auth_sessions (account_id, authority_plane, token_digest, auth_assurance_level, absolute_expires_at) VALUES ($1, 'RELATIONSHIP', '12345678901234567890123456789012', 'BASIC', clock_timestamp() + interval '1 hour')`, [humanAccountId]);
        assert(false, "SESS-18: Importer direct INSERT should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-18: Importer INSERT denied with SQLSTATE 42501");
      }

      try {
        await importerClient.query(`UPDATE identity.auth_sessions SET last_activity_at = clock_timestamp()`);
        assert(false, "SESS-18: Importer direct UPDATE should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-18: Importer UPDATE denied with SQLSTATE 42501");
      }

      try {
        await importerClient.query(`DELETE FROM identity.auth_sessions`);
        assert(false, "SESS-18: Importer direct DELETE should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-18: Importer DELETE denied with SQLSTATE 42501");
      }

      // Inspect pg_proc for vind_importer function EXECUTE privileges
      const fnPrivRes = await bootstrapClient.query(`
        SELECT proname, has_function_privilege('vind_importer', p.oid, 'execute') AS can_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'identity'
          AND proname IN (
            'create_auth_session', 'create_auth_session_internal', 'resolve_auth_session',
            'revoke_auth_session', 'revoke_account_sessions', 'rotate_auth_session', 'purge_auth_sessions'
          )
      `);
      for (const row of fnPrivRes.rows) {
        assert(row.can_exec === false, `SESS-18: Importer EXECUTE privilege is FALSE for function ${row.proname}`);
      }

      try {
        const testDigest = generateDigest("importer_exec_test");
        await importerClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [testDigest]);
        assert(false, "SESS-18: Importer EXECUTE resolve_auth_session should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-18: Importer EXECUTE function invocation denied with SQLSTATE 42501");
      }

      // SESS-19: Lifecycle Events + Canonical Actor Keys + Token/Digest Absence + SEC Retention Assertion
      console.log("\nExecuting SESS-19: Lifecycle Security Audit Events...");
      const eventsRes = await bootstrapClient.query(
        `SELECT event_type, actor_account_key, actor_person_key, retention_class_code, details FROM security.security_events ORDER BY id ASC`
      );
      assert(eventsRes.rows.length >= 4, "SESS-19: Security events recorded");

      const eventTypes = eventsRes.rows.map((r: any) => r.event_type);
      assert(eventTypes.includes("AUTH_SESSION_CREATED"), "SESS-19: AUTH_SESSION_CREATED event present");
      assert(eventTypes.includes("AUTH_SESSION_REVOKED"), "SESS-19: AUTH_SESSION_REVOKED event present");
      assert(eventTypes.includes("AUTH_SESSION_ROTATED"), "SESS-19: AUTH_SESSION_ROTATED event present");
      assert(eventTypes.includes("AUTH_ACCOUNT_SESSIONS_REVOKED"), "SESS-19: AUTH_ACCOUNT_SESSIONS_REVOKED event present");

      for (const row of eventsRes.rows) {
        if (["AUTH_SESSION_CREATED", "AUTH_SESSION_REVOKED", "AUTH_SESSION_ROTATED", "AUTH_ACCOUNT_SESSIONS_REVOKED"].includes(row.event_type)) {
          assert(row.retention_class_code === "SEC", `SESS-19: Event ${row.event_type} retention_class_code is SEC`);
          const evDetails = JSON.stringify(row.details || {});
          assert(!evDetails.includes(rawTokenHuman), `SESS-19: Raw token material absent from ${row.event_type} details`);
          assert(!evDetails.includes(digestHuman.toString("hex")), `SESS-19: Raw token digest absent from ${row.event_type} details`);
        }
      }

      // Explicit canonical key assertions for HUMAN and SERVICE events (Requirement 5)
      const humanCreatedEv = (await bootstrapClient.query(
        `SELECT actor_account_key, actor_person_key FROM security.security_events WHERE event_type = 'AUTH_SESSION_CREATED' AND subject_key = $1`,
        [humanSessionId]
      )).rows[0];
      assert(humanCreatedEv?.actor_account_key === humanAccountKey, "SESS-19: HUMAN AUTH_SESSION_CREATED actor_account_key matches canonical account_key");
      assert(humanCreatedEv?.actor_person_key === humanPersonKey, "SESS-19: HUMAN AUTH_SESSION_CREATED actor_person_key matches canonical person_key");

      const serviceCreatedEv = (await bootstrapClient.query(
        `SELECT actor_account_key, actor_person_key FROM security.security_events WHERE event_type = 'AUTH_SESSION_CREATED' AND subject_key = $1`,
        [serviceSessionId]
      )).rows[0];
      assert(serviceCreatedEv?.actor_account_key === serviceAccountKey, "SESS-19: SERVICE AUTH_SESSION_CREATED actor_account_key matches canonical account_key");
      assert(serviceCreatedEv?.actor_person_key === null, "SESS-19: SERVICE AUTH_SESSION_CREATED actor_person_key is NULL");

      const humanRevokedEv = (await bootstrapClient.query(
        `SELECT actor_account_key, actor_person_key FROM security.security_events WHERE event_type = 'AUTH_SESSION_REVOKED' AND subject_key = $1`,
        [humanSessionId]
      )).rows[0];
      assert(humanRevokedEv?.actor_account_key === humanAccountKey, "SESS-19: HUMAN AUTH_SESSION_REVOKED actor_account_key matches canonical account_key");
      assert(humanRevokedEv?.actor_person_key === humanPersonKey, "SESS-19: HUMAN AUTH_SESSION_REVOKED actor_person_key matches canonical person_key");

      const serviceRotatedEv = (await bootstrapClient.query(
        `SELECT actor_account_key, actor_person_key FROM security.security_events WHERE event_type = 'AUTH_SESSION_ROTATED' AND subject_key = $1`,
        [newRotSessId]
      )).rows[0];
      assert(serviceRotatedEv?.actor_account_key === serviceAccountKey, "SESS-19: SERVICE AUTH_SESSION_ROTATED actor_account_key matches canonical account_key");
      assert(serviceRotatedEv?.actor_person_key === null, "SESS-19: SERVICE AUTH_SESSION_ROTATED actor_person_key is NULL");

      const serviceAccountRevokedEv = (await bootstrapClient.query(
        `SELECT actor_account_key, actor_person_key FROM security.security_events WHERE event_type = 'AUTH_ACCOUNT_SESSIONS_REVOKED' AND subject_key = $1 LIMIT 1`,
        [serviceAccountKey]
      )).rows[0];
      assert(serviceAccountRevokedEv?.actor_account_key === serviceAccountKey, "SESS-19: SERVICE AUTH_ACCOUNT_SESSIONS_REVOKED actor_account_key matches canonical account_key");
      assert(serviceAccountRevokedEv?.actor_person_key === null, "SESS-19: SERVICE AUTH_ACCOUNT_SESSIONS_REVOKED actor_person_key is NULL");

      // Test HUMAN account-wide logout for SESS-19 assertion
      const rawHumanAcc1 = randomBytes(32).toString("hex");
      const digestHumanAcc1 = generateDigest(rawHumanAcc1);
      await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP')`,
        [humanAccountId, digestHumanAcc1]
      );
      await runtimeClient.query(
        `SELECT identity.revoke_account_sessions($1, 'SECURITY_LOGOUT', false)`,
        [digestHumanAcc1]
      );
      const humanAccountRevokedEv = (await bootstrapClient.query(
        `SELECT actor_account_key, actor_person_key FROM security.security_events WHERE event_type = 'AUTH_ACCOUNT_SESSIONS_REVOKED' AND subject_key = $1 ORDER BY id DESC LIMIT 1`,
        [humanAccountKey]
      )).rows[0];
      assert(humanAccountRevokedEv?.actor_account_key === humanAccountKey, "SESS-19: HUMAN AUTH_ACCOUNT_SESSIONS_REVOKED actor_account_key matches canonical account_key");
      assert(humanAccountRevokedEv?.actor_person_key === humanPersonKey, "SESS-19: HUMAN AUTH_ACCOUNT_SESSIONS_REVOKED actor_person_key matches canonical person_key");

      // SESS-20: Retention Purge Function, Batch Limit (2 then 1) & Retention Logic
      console.log("\nExecuting SESS-20: Retention Purge & Batch Limit (2 then 1)...");
      const oldRaw1 = randomBytes(32).toString("hex");
      const oldDigest1 = generateDigest(oldRaw1);
      const oldSessId1 = (await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP') AS session_id`,
        [humanAccountId, oldDigest1]
      )).rows[0].session_id;
      await bootstrapClient.query(`UPDATE identity.auth_sessions SET revoked_at = clock_timestamp() - interval '100 days', revocation_reason_code = 'TEST_PURGE' WHERE id = $1`, [oldSessId1]);

      const oldRaw2 = randomBytes(32).toString("hex");
      const oldDigest2 = generateDigest(oldRaw2);
      const oldSessId2 = (await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP') AS session_id`,
        [humanAccountId, oldDigest2]
      )).rows[0].session_id;
      await bootstrapClient.query(`UPDATE identity.auth_sessions SET revoked_at = clock_timestamp() - interval '100 days', revocation_reason_code = 'TEST_PURGE' WHERE id = $1`, [oldSessId2]);

      const oldRaw3 = randomBytes(32).toString("hex");
      const oldDigest3 = generateDigest(oldRaw3);
      const oldSessId3 = (await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP') AS session_id`,
        [humanAccountId, oldDigest3]
      )).rows[0].session_id;
      await bootstrapClient.query(`UPDATE identity.auth_sessions SET revoked_at = clock_timestamp() - interval '100 days', revocation_reason_code = 'TEST_PURGE' WHERE id = $1`, [oldSessId3]);

      // Young terminal session (revoked 1 day ago) -> retained
      const youngRaw = randomBytes(32).toString("hex");
      const youngDigest = generateDigest(youngRaw);
      const youngSessId = (await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP') AS session_id`,
        [humanAccountId, youngDigest]
      )).rows[0].session_id;
      await bootstrapClient.query(`UPDATE identity.auth_sessions SET revoked_at = clock_timestamp() - interval '1 day', revocation_reason_code = 'TEST_PURGE' WHERE id = $1`, [youngSessId]);

      // Active non-terminal session -> retained
      const activeRaw = randomBytes(32).toString("hex");
      const activeDigest = generateDigest(activeRaw);
      const activeSessId = (await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP') AS session_id`,
        [humanAccountId, activeDigest]
      )).rows[0].session_id;

      // Old idle-expired non-revoked session -> deleted by purge
      const idleExpRaw = randomBytes(32).toString("hex");
      const idleExpDigest = generateDigest(idleExpRaw);
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (
          account_id, authority_plane, token_digest, auth_assurance_level,
          authenticated_at, last_activity_at, absolute_expires_at
        ) VALUES (
          $1, 'RELATIONSHIP', $2, 'BASIC',
          clock_timestamp() - interval '101 days',
          clock_timestamp() - interval '100 days',
          clock_timestamp() + interval '1 hour'
        )`,
        [humanAccountId, idleExpDigest]
      );

      // Old absolute-expired non-revoked session -> deleted by purge
      const absExpRaw = randomBytes(32).toString("hex");
      const absExpDigest = generateDigest(absExpRaw);
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (
          account_id, authority_plane, token_digest, auth_assurance_level,
          authenticated_at, last_activity_at, absolute_expires_at
        ) VALUES (
          $1, 'RELATIONSHIP', $2, 'BASIC',
          clock_timestamp() - interval '101 days',
          clock_timestamp() - interval '1 hour',
          clock_timestamp() - interval '100 days'
        )`,
        [humanAccountId, absExpDigest]
      );

      // Purge with batch limit 2 -> should purge exactly 2 old terminal sessions
      const purgeBatchRes1 = await bootstrapClient.query(`SELECT identity.purge_auth_sessions(clock_timestamp() - interval '90 days', 2) AS cnt`);
      assert(purgeBatchRes1.rows[0]?.cnt === 2, "SESS-20: Batch limit p_limit=2 purged exactly 2 old terminal sessions");

      // Purge remaining eligible old terminal session -> should purge exactly 1
      const purgeBatchRes2 = await bootstrapClient.query(`SELECT identity.purge_auth_sessions(clock_timestamp() - interval '90 days', 1) AS cnt`);
      assert(purgeBatchRes2.rows[0]?.cnt === 1, "SESS-20: Subsequent purge p_limit=1 purged exactly 1 remaining old terminal session");

      const checkYoungRetained = await bootstrapClient.query(`SELECT id FROM identity.auth_sessions WHERE id = $1`, [youngSessId]);
      assert(checkYoungRetained.rows.length === 1, "SESS-20: Young terminal session retained");

      const checkActiveRetained = await bootstrapClient.query(`SELECT id FROM identity.auth_sessions WHERE id = $1`, [activeSessId]);
      assert(checkActiveRetained.rows.length === 1, "SESS-20: Active non-terminal session retained");

      // Final purge to clean old idle-expired and absolute-expired non-revoked sessions
      await bootstrapClient.query(`SELECT identity.purge_auth_sessions(clock_timestamp() - interval '90 days', 100)`);
      const checkIdleExpPurged = await bootstrapClient.query(`SELECT id FROM identity.auth_sessions WHERE token_digest = $1`, [idleExpDigest]);
      assert(checkIdleExpPurged.rows.length === 0, "SESS-20: Old idle-expired non-revoked session was deleted by purge");

      const checkAbsExpPurged = await bootstrapClient.query(`SELECT id FROM identity.auth_sessions WHERE token_digest = $1`, [absExpDigest]);
      assert(checkAbsExpPurged.rows.length === 0, "SESS-20: Old absolute-expired non-revoked session was deleted by purge");

      try {
        await bootstrapClient.query(`SELECT identity.purge_auth_sessions(clock_timestamp(), 20000)`);
        assert(false, "SESS-20: Invalid p_limit > 10000 should fail");
      } catch (err: any) {
        assert(err.code === "22023", "SESS-20: Excessive p_limit rejected with SQLSTATE 22023");
      }

      // SESS-21: Concurrent Resolve & Revoke (Scenario A & Scenario B with Wait Proof)
      console.log("\nExecuting SESS-21: Concurrent Resolve & Revoke (Wait Proven)...");

      // Scenario A — resolve holds lock first, revoke waits until commit
      const rawTokenConcA = randomBytes(32).toString("hex");
      const digestConcA = generateDigest(rawTokenConcA);
      await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP')`, [humanAccountId, digestConcA]);

      const clientA = new Client({ connectionString: isoRuntimeUrl });
      const clientB = new Client({ connectionString: isoRuntimeUrl });
      await clientA.connect();
      await clientB.connect();

      try {
        await clientA.query("BEGIN");
        await clientB.query("BEGIN");

        const resA = await clientA.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestConcA]);
        assert(resA.rows.length === 1, "SESS-21 Scenario A: Resolve holds FOR SHARE lock first");

        // Initiate revoke_auth_session asynchronously
        const promiseRevokeB = clientB.query(`SELECT identity.revoke_auth_session($1, 'SCENARIO_A') AS revoked`, [digestConcA]);

        // Prove promiseRevokeB has NOT settled while Transaction A is open
        const raceA = await Promise.race([
          promiseRevokeB.then(() => "SETTLED"),
          new Promise((resolve) => setTimeout(() => resolve("WAITING"), 50))
        ]);
        assert(raceA === "WAITING", "SESS-21 Scenario A: Revoke B proven WAITING for lock before Commit A");

        await clientA.query("COMMIT");
        const resRevokeB = await promiseRevokeB;
        assert(resRevokeB.rows[0]?.revoked === true, "SESS-21 Scenario A: Revoke B completes after Commit A");
        await clientB.query("COMMIT");

        const resAfterA = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestConcA]);
        assert(resAfterA.rows.length === 0, "SESS-21 Scenario A: Later resolves fail after revocation");
      } finally {
        await clientA.end().catch(() => {});
        await clientB.end().catch(() => {});
      }

      // Scenario B — revoke holds lock first, resolve waits until commit
      const rawTokenConcB = randomBytes(32).toString("hex");
      const digestConcB = generateDigest(rawTokenConcB);
      await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP')`, [humanAccountId, digestConcB]);

      const clientC = new Client({ connectionString: isoRuntimeUrl });
      const clientD = new Client({ connectionString: isoRuntimeUrl });
      await clientC.connect();
      await clientD.connect();

      try {
        await clientC.query("BEGIN");
        await clientD.query("BEGIN");

        const resRevokeC = await clientC.query(`SELECT identity.revoke_auth_session($1, 'SCENARIO_B') AS revoked`, [digestConcB]);
        assert(resRevokeC.rows[0]?.revoked === true, "SESS-21 Scenario B: Revoke C holds FOR UPDATE lock first");

        // Initiate resolve_auth_session asynchronously
        const promiseResolveD = clientD.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestConcB]);

        // Prove promiseResolveD has NOT settled while Transaction C is open
        const raceB = await Promise.race([
          promiseResolveD.then(() => "SETTLED"),
          new Promise((resolve) => setTimeout(() => resolve("WAITING"), 50))
        ]);
        assert(raceB === "WAITING", "SESS-21 Scenario B: Resolve D proven WAITING for lock before Commit C");

        await clientC.query("COMMIT");
        const resResolveD = await promiseResolveD;
        assert(resResolveD.rows.length === 0, "SESS-21 Scenario B: Resolve D completes after Commit C and sees 0 rows");
        await clientD.query("COMMIT");
      } finally {
        await clientC.end().catch(() => {});
        await clientD.end().catch(() => {});
      }

      const humanIdentityLinkId = (await bootstrapClient.query(
        `SELECT id FROM identity.identity_links WHERE account_id = $1 AND status = 'ACTIVE' ORDER BY is_primary DESC LIMIT 1`,
        [humanAccountId]
      )).rows[0].id;

      const localIdentityLinkId = (await bootstrapClient.query(
        `SELECT id FROM identity.identity_links WHERE account_id = $1 AND status = 'ACTIVE' ORDER BY is_primary DESC LIMIT 1`,
        [localAssAccountId]
      )).rows[0].id;

      const platIdentityLinkId = (await bootstrapClient.query(
        `SELECT id FROM identity.identity_links WHERE account_id = $1 AND status = 'ACTIVE' ORDER BY is_primary DESC LIMIT 1`,
        [platAccountId]
      )).rows[0].id;

      // Explicit Timeout Policy Acceptance Matrix (RELATIONSHIP, LOCAL, PLATFORM, SERVICE)
      console.log("\nExecuting Timeout Policy Acceptance Matrix...");

      // 1. RELATIONSHIP: idle 30m / absolute 8h
      const rawRelT = randomBytes(32).toString("hex");
      const digRelT = generateDigest(rawRelT);
      const relSessId = (await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP') AS session_id`, [humanAccountId, digRelT])).rows[0].session_id;
      const relRow = (await bootstrapClient.query(`SELECT authenticated_at, absolute_expires_at FROM identity.auth_sessions WHERE id = $1`, [relSessId])).rows[0];
      const relAbsDuration = (new Date(relRow.absolute_expires_at).getTime() - new Date(relRow.authenticated_at).getTime()) / 1000;
      assert(Math.abs(relAbsDuration - 8 * 3600) < 60, "Timeout Policy: RELATIONSHIP absolute lifetime is 8h");

      const digRelIn = generateDigest(randomBytes(32).toString("hex"));
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (account_id, identity_link_id, authority_plane, token_digest, auth_assurance_level, authenticated_at, last_activity_at, absolute_expires_at)
         VALUES ($1, $2, 'RELATIONSHIP', $3, 'BASIC', clock_timestamp() - interval '29 minutes', clock_timestamp() - interval '29 minutes', clock_timestamp() + interval '8 hours')`,
        [humanAccountId, humanIdentityLinkId, digRelIn]
      );
      const relJustInside = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digRelIn]);
      assert(relJustInside.rows.length === 1, "Timeout Policy: RELATIONSHIP just-inside idle (29m) is valid");

      const digRelOut = generateDigest(randomBytes(32).toString("hex"));
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (account_id, identity_link_id, authority_plane, token_digest, auth_assurance_level, authenticated_at, last_activity_at, absolute_expires_at)
         VALUES ($1, $2, 'RELATIONSHIP', $3, 'BASIC', clock_timestamp() - interval '31 minutes', clock_timestamp() - interval '31 minutes', clock_timestamp() + interval '8 hours')`,
        [humanAccountId, humanIdentityLinkId, digRelOut]
      );
      const relBeyond = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digRelOut]);
      assert(relBeyond.rows.length === 0, "Timeout Policy: RELATIONSHIP beyond idle (31m) is invalid");

      // 2. LOCAL: idle 30m / absolute 8h
      const rawLocT = randomBytes(32).toString("hex");
      const digLocT = generateDigest(rawLocT);
      const locSessId = (await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'LOCAL', $3) AS session_id`, [localAssAccountId, digLocT, localAssId])).rows[0].session_id;
      const locRow = (await bootstrapClient.query(`SELECT authenticated_at, absolute_expires_at FROM identity.auth_sessions WHERE id = $1`, [locSessId])).rows[0];
      const locAbsDuration = (new Date(locRow.absolute_expires_at).getTime() - new Date(locRow.authenticated_at).getTime()) / 1000;
      assert(Math.abs(locAbsDuration - 8 * 3600) < 60, "Timeout Policy: LOCAL absolute lifetime is 8h");

      const digLocIn = generateDigest(randomBytes(32).toString("hex"));
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (account_id, identity_link_id, authority_plane, local_assignment_id, token_digest, auth_assurance_level, authenticated_at, last_activity_at, absolute_expires_at)
         VALUES ($1, $2, 'LOCAL', $3, $4, 'BASIC', clock_timestamp() - interval '29 minutes', clock_timestamp() - interval '29 minutes', clock_timestamp() + interval '8 hours')`,
        [localAssAccountId, localIdentityLinkId, localAssId, digLocIn]
      );
      const locJustInside = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digLocIn]);
      assert(locJustInside.rows.length === 1, "Timeout Policy: LOCAL just-inside idle (29m) is valid");

      const digLocOut = generateDigest(randomBytes(32).toString("hex"));
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (account_id, identity_link_id, authority_plane, local_assignment_id, token_digest, auth_assurance_level, authenticated_at, last_activity_at, absolute_expires_at)
         VALUES ($1, $2, 'LOCAL', $3, $4, 'BASIC', clock_timestamp() - interval '31 minutes', clock_timestamp() - interval '31 minutes', clock_timestamp() + interval '8 hours')`,
        [localAssAccountId, localIdentityLinkId, localAssId, digLocOut]
      );
      const locBeyond = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digLocOut]);
      assert(locBeyond.rows.length === 0, "Timeout Policy: LOCAL beyond idle (31m) is invalid");

      // 3. PLATFORM: idle 15m / absolute 4h
      const rawPlatT = randomBytes(32).toString("hex");
      const digPlatT = generateDigest(rawPlatT);
      const platSessId = (await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'PLATFORM', NULL, $3) AS session_id`, [platAccountId, digPlatT, platAssId])).rows[0].session_id;
      const platRow = (await bootstrapClient.query(`SELECT authenticated_at, absolute_expires_at FROM identity.auth_sessions WHERE id = $1`, [platSessId])).rows[0];
      const platAbsDuration = (new Date(platRow.absolute_expires_at).getTime() - new Date(platRow.authenticated_at).getTime()) / 1000;
      assert(Math.abs(platAbsDuration - 4 * 3600) < 60, "Timeout Policy: PLATFORM absolute lifetime is 4h");

      const digPlatIn = generateDigest(randomBytes(32).toString("hex"));
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (account_id, identity_link_id, authority_plane, platform_assignment_id, token_digest, auth_assurance_level, authenticated_at, last_activity_at, absolute_expires_at)
         VALUES ($1, $2, 'PLATFORM', $3, $4, 'BASIC', clock_timestamp() - interval '14 minutes', clock_timestamp() - interval '14 minutes', clock_timestamp() + interval '4 hours')`,
        [platAccountId, platIdentityLinkId, platAssId, digPlatIn]
      );
      const platJustInside = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digPlatIn]);
      assert(platJustInside.rows.length === 1, "Timeout Policy: PLATFORM just-inside idle (14m) is valid");

      const digPlatOut = generateDigest(randomBytes(32).toString("hex"));
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (account_id, identity_link_id, authority_plane, platform_assignment_id, token_digest, auth_assurance_level, authenticated_at, last_activity_at, absolute_expires_at)
         VALUES ($1, $2, 'PLATFORM', $3, $4, 'BASIC', clock_timestamp() - interval '16 minutes', clock_timestamp() - interval '16 minutes', clock_timestamp() + interval '4 hours')`,
        [platAccountId, platIdentityLinkId, platAssId, digPlatOut]
      );
      const platBeyond = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digPlatOut]);
      assert(platBeyond.rows.length === 0, "Timeout Policy: PLATFORM beyond idle (16m) is invalid");

      // 4. SERVICE: idle 15m / absolute 4h
      const rawSvcT = randomBytes(32).toString("hex");
      const digSvcT = generateDigest(rawSvcT);
      const svcSessId = (await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'SERVICE', NULL, NULL, $3) AS session_id`, [serviceAccountId, digSvcT, serviceGrantId])).rows[0].session_id;
      const svcRow = (await bootstrapClient.query(`SELECT authenticated_at, absolute_expires_at FROM identity.auth_sessions WHERE id = $1`, [svcSessId])).rows[0];
      const svcAbsDuration = (new Date(svcRow.absolute_expires_at).getTime() - new Date(svcRow.authenticated_at).getTime()) / 1000;
      assert(Math.abs(svcAbsDuration - 4 * 3600) < 60, "Timeout Policy: SERVICE absolute lifetime is 4h");

      const digSvcIn = generateDigest(randomBytes(32).toString("hex"));
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (account_id, authority_plane, service_grant_id, token_digest, auth_assurance_level, authenticated_at, last_activity_at, absolute_expires_at)
         VALUES ($1, 'SERVICE', $2, $3, 'BASIC', clock_timestamp() - interval '14 minutes', clock_timestamp() - interval '14 minutes', clock_timestamp() + interval '4 hours')`,
        [serviceAccountId, serviceGrantId, digSvcIn]
      );
      const svcJustInside = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digSvcIn]);
      assert(svcJustInside.rows.length === 1, "Timeout Policy: SERVICE just-inside idle (14m) is valid");

      const digSvcOut = generateDigest(randomBytes(32).toString("hex"));
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (account_id, authority_plane, service_grant_id, token_digest, auth_assurance_level, authenticated_at, last_activity_at, absolute_expires_at)
         VALUES ($1, 'SERVICE', $2, $3, 'BASIC', clock_timestamp() - interval '16 minutes', clock_timestamp() - interval '16 minutes', clock_timestamp() + interval '4 hours')`,
        [serviceAccountId, serviceGrantId, digSvcOut]
      );
      const svcBeyond = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digSvcOut]);
      assert(svcBeyond.rows.length === 0, "Timeout Policy: SERVICE beyond idle (16m) is invalid");

      // Step-Up Freshness (Inside 15m = true, Older than 15m = false)
      console.log("\nExecuting Step-Up Freshness Checks...");
      const rawTokenStepUpInside = randomBytes(32).toString("hex");
      const digestStepUpInside = generateDigest(rawTokenStepUpInside);
      await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP', NULL, NULL, NULL, 'BASIC', true)`,
        [humanAccountId, digestStepUpInside]
      );
      const resStepUpInside = await runtimeClient.query(`SELECT step_up_verified FROM identity.resolve_auth_session($1)`, [digestStepUpInside]);
      assert(resStepUpInside.rows[0]?.step_up_verified === true, "SESS-StepUp: step_up_verified=true when created with p_step_up_verified=true");

      const rawTokenStepUpOutside = randomBytes(32).toString("hex");
      const digestStepUpOutside = generateDigest(rawTokenStepUpOutside);
      await bootstrapClient.query(
        `INSERT INTO identity.auth_sessions (
          account_id, identity_link_id, authority_plane, token_digest, auth_assurance_level, step_up_verified_at,
          authenticated_at, last_activity_at, absolute_expires_at
        ) VALUES (
          $1, $2, 'RELATIONSHIP', $3, 'BASIC', clock_timestamp() - interval '20 minutes',
          clock_timestamp() - interval '20 minutes', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '8 hours'
        )`,
        [humanAccountId, humanIdentityLinkId, digestStepUpOutside]
      );
      const resStepUpOutside = await runtimeClient.query(`SELECT step_up_verified FROM identity.resolve_auth_session($1)`, [digestStepUpOutside]);
      assert(resStepUpOutside.rows[0]?.step_up_verified === false, "SESS-StepUp: step_up_verified=false when step_up_verified_at is 20m old");

      // Last Activity Advancement & Absolute Expiry Non-sliding Proof
      console.log("\nExecuting Last Activity Advancement & Non-sliding Expiry Proof...");
      const rawTokenLastAct = randomBytes(32).toString("hex");
      const digestLastAct = generateDigest(rawTokenLastAct);
      const lastActSessId = (await runtimeClient.query(`SELECT identity.create_auth_session($1, $2, 'RELATIONSHIP') AS session_id`, [humanAccountId, digestLastAct])).rows[0].session_id;

      const rowBefore = (await bootstrapClient.query(`SELECT last_activity_at, absolute_expires_at FROM identity.auth_sessions WHERE id = $1`, [lastActSessId])).rows[0];

      // Pause briefly to ensure clock timestamp advances
      await new Promise((r) => setTimeout(r, 10));

      // Resolve session
      await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLastAct]);

      const rowAfter = (await bootstrapClient.query(`SELECT last_activity_at, absolute_expires_at FROM identity.auth_sessions WHERE id = $1`, [lastActSessId])).rows[0];

      const timeBefore = new Date(rowBefore.last_activity_at).getTime();
      const timeAfter = new Date(rowAfter.last_activity_at).getTime();
      assert(timeAfter > timeBefore, "SESS-LastActivity: last_activity_at advances on successful resolve");

      const absBefore = new Date(rowBefore.absolute_expires_at).getTime();
      const absAfter = new Date(rowAfter.absolute_expires_at).getTime();
      assert(absAfter === absBefore, "SESS-Policy: absolute_expires_at does NOT slide on resolve");

      // SESS-25: REAL Existing S1 Access Closure Integration Test Suite
      console.log("\nExecuting SESS-25: REAL Existing S1 Access Closure Integration Test Suite...");
      execFileSync("npx", ["tsx", "src/test-s1-foundation-access-closure.ts"], { cwd: packageRoot, env: envOverrides, stdio: "pipe", shell: true });
      assert(true, "SESS-25: REAL S1 Access Closure test suite PASSED");

      // SESS-26: REAL DB-DEC-021 Automated Test Suite (65/65 Output Summary Capture)
      console.log("\nExecuting SESS-26: DB-DEC-021 Automated Test Suite (65/65 Summary Asserted)...");
      const dec021Output = execFileSync("npx", ["tsx", "src/test-dec021-harness.ts"], { cwd: packageRoot, env: envOverrides, stdio: "pipe", shell: true }).toString();
      console.log("\n--- DB-DEC-021 Harness Output Snippet ---");
      console.log(dec021Output.split("\n").filter((l) => l.includes("FAIL") || l.includes("PASS") || l.includes("CASE-")).slice(-15).join("\n"));
      console.log("-----------------------------------------");
      assert(dec021Output.includes("PASSED=65") && dec021Output.includes("FAILED=0"), "SESS-26: DB-DEC-021 Output Summary verified 65 PASS / 0 FAIL");

      // SESS-27: Prisma validate + generate
      console.log("\nExecuting SESS-27: Prisma Validate & Generate...");
      execFileSync("npx", ["prisma", "validate"], { cwd: packageRoot, stdio: "pipe", shell: true });
      fs.rmSync(path.join(packageRoot, "src", "generated"), { recursive: true, force: true });
      execFileSync("npx", ["prisma", "generate"], { cwd: packageRoot, stdio: "pipe", shell: true });
      assert(true, "SESS-27: Prisma validate and generate PASSED");

      // SESS-28: TypeScript Build
      console.log("\nExecuting SESS-28: TypeScript Build...");
      execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: packageRoot, stdio: "pipe", shell: true });
      assert(true, "SESS-28: TypeScript package build PASSED");

    } finally {
      await runtimeClient.end().catch(() => {});
      await bootstrapClient.end().catch(() => {});
      await importerClient.end().catch(() => {});
    }

  } finally {
    // Drop isolated clean acceptance database
    console.log(`\nDropping isolated acceptance database ${acceptDbName}...`);
    const dropClient = new Client({
      connectionString: `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${targetPort}/${mainDbName}`
    });
    await dropClient.connect();
    await dropClient.query(`DROP DATABASE IF EXISTS "${acceptDbName}" WITH (FORCE)`);
    await dropClient.end();
    console.log("Isolated database dropped.");
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
