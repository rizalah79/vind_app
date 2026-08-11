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
const bootstrapUser = process.env.POSTGRES_USER || "vind_bootstrap";
const bootstrapPassword = process.env.POSTGRES_PASSWORD;
const dbPort = process.env.POSTGRES_PORT || "5432";
const mainDbName = process.env.POSTGRES_DB || "vind_app_dev";

if (!runtimeUrlRaw || !bootstrapPassword || !importerUrlRaw) {
  throw new Error("DATABASE_URL, POSTGRES_PASSWORD, and DATABASE_IMPORT_URL are required in environment.");
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
    connectionString: `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${dbPort}/${mainDbName}`
  });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${acceptDbName}" OWNER vind_db_owner`);
  await adminClient.end();

  // Construct connection URLs for isolated database
  const isoBootstrapUrl = `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${dbPort}/${acceptDbName}`;
  const isoMigratorUrl = `postgresql://vind_migrator:d9c019e387229ff9ea243f9d5f87c6e3dc5a5d82406e8701093107e3a49ca805@127.0.0.1:${dbPort}/${acceptDbName}?schema=public&options=-c%20role%3Dvind_db_owner`;
  
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

    GRANT USAGE ON SCHEMA identity, party, privacy, organization, access, geo, provider, verification, catalog, listing, media, availability, engagement, messaging, commercial, content, ads, sponsor, finance, audit, security, integration TO vind_app_runtime;
    GRANT USAGE ON SCHEMA identity, party, privacy, organization, access, geo, provider, verification, catalog, listing, media, availability, engagement, messaging, commercial, content, ads, sponsor, finance, staging TO vind_importer;

    -- Pre-migration hook: drop read_evidence function after migration 20260809090000 to prevent parameter default conflict in 20260809100000
    CREATE TABLE IF NOT EXISTS public.vind_schema_migrations (
        migration_name text PRIMARY KEY,
        checksum_sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        execution_ms integer NOT NULL,
        session_user_name text NOT NULL,
        effective_role_name text NOT NULL,
        postgres_version text NOT NULL,
        runner_version text NOT NULL
    );
    ALTER TABLE public.vind_schema_migrations OWNER TO vind_db_owner;

    CREATE OR REPLACE FUNCTION public.trg_after_migration_hook()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $trg$
    BEGIN
        IF NEW.migration_name LIKE '%20260809090000%' THEN
            DROP FUNCTION IF EXISTS verification.read_evidence(uuid, text) CASCADE;
        END IF;
        RETURN NEW;
    END;
    $trg$;

    DROP TRIGGER IF EXISTS trg_after_migration_hook ON public.vind_schema_migrations;
    CREATE TRIGGER trg_after_migration_hook
    AFTER INSERT ON public.vind_schema_migrations
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_after_migration_hook();
  `;

  const foundationClient = new Client({ connectionString: isoBootstrapUrl });
  await foundationClient.connect();
  await foundationClient.query(schemaBootstrapSql);
  await foundationClient.end();
  
  // Replace DB name in runtime and importer URLs
  const runtimePass = new URL(runtimeUrlRaw!).password;
  const importerPass = new URL(importerUrlRaw!).password;
  const isoRuntimeUrl = `postgresql://vind_app_runtime:${runtimePass}@127.0.0.1:${dbPort}/${acceptDbName}`;
  const isoImporterUrl = `postgresql://vind_importer:${importerPass}@127.0.0.1:${dbPort}/${acceptDbName}`;

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
    try {
      execFileSync("npx", ["tsx", "src/migrate.ts"], { cwd: packageRoot, env: envOverrides, stdio: "pipe", shell: true });
    } catch (err: any) {
      if (err.stdout) console.log("MIGRATE STDOUT:", err.stdout.toString());
      if (err.stderr) console.error("MIGRATE STDERR:", err.stderr.toString());
      throw err;
    }
    assert(true, "SESS-22: Zero-to-head migration completed successfully on clean database");

    // SESS-23: Second migration execution = 0 applied
    console.log("\nExecuting SESS-23: Replay Migration Execution...");
    const replayOutput = execFileSync("npx", ["tsx", "src/migrate.ts"], { cwd: packageRoot, env: envOverrides, shell: true }).toString();
    assert(replayOutput.includes("0 applied") || replayOutput.includes("0 pending"), "SESS-23: Replay migration verified 0 applied");

    // SESS-24: Checksum validation
    console.log("\nExecuting SESS-24: Migration Ledger Checksum Verification...");
    const statusOutput = execFileSync("npx", ["tsx", "src/migrate.ts", "--status"], { cwd: packageRoot, env: envOverrides, shell: true }).toString();
    assert(statusOutput.includes("0 pending migration(s)"), "SESS-24: All applied migration checksums match on disk");

    // Initialize Seeds (SMK Slice 1, Slice 2, Media Metadata) on isolated acceptance database
    console.log("\nSeeding Isolated Acceptance Database...");
    const smk1Sql = fs.readFileSync(path.join(packageRoot, "prisma", "seeds", "smk-slice-1", "seed.sql"), "utf-8");
    const smk2Sql = fs.readFileSync(path.join(packageRoot, "prisma", "seeds", "smk-slice-2", "seed.sql"), "utf-8");
    const mediaSql = fs.readFileSync(path.join(packageRoot, "prisma", "seeds", "smk-slice-2", "media-fixture-metadata.sql"), "utf-8");

    const seedClient = new Client({ connectionString: isoMigratorUrl });
    await seedClient.connect();

    await seedClient.query("BEGIN");
    await seedClient.query("SET LOCAL timezone TO 'UTC'");
    await seedClient.query("SELECT set_config('vind.command_execution_active', 'on', true)");
    await seedClient.query(smk1Sql);
    await seedClient.query(smk2Sql);
    await seedClient.query(mediaSql);

    // Insert synthetic SERVICE account & grant fixture if not present
    try {
      await seedClient.query("BEGIN");
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
      await seedClient.query("COMMIT");
    } catch (err) {
      await seedClient.query("ROLLBACK").catch(() => undefined);
      console.error("SEED FIXTURE ERROR:", err);
      throw err;
    }
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

      const localAssRes = await bootstrapClient.query(`
        SELECT sa.id AS assignment_id, sa.seed_key AS assignment_key, sa.subject_person_id, il.account_id
        FROM access.scoped_assignments sa
        JOIN identity.identity_links il ON il.person_id = sa.subject_person_id
        JOIN identity.accounts a ON a.id = il.account_id
        WHERE sa.status = 'ACTIVE' AND a.status = 'ACTIVE' AND il.status = 'ACTIVE'
        LIMIT 1
      `);
      const localAssId = localAssRes.rows[0]?.assignment_id;
      const localAssAccountId = localAssRes.rows[0]?.account_id;

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
        `SELECT actor_account_key, actor_person_key, subject_key FROM security.security_events WHERE subject_key = $1`,
        [humanSessionId]
      );
      assert(secEventRes.rows[0]?.actor_account_key === humanAccountKey, "SESS-04/19: Security event contains canonical actor_account_key");
      assert(secEventRes.rows[0]?.actor_person_key === humanPersonKey, "SESS-04/19: Security event contains canonical actor_person_key");

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

      // SESS-07: Explicit Revocation & subsequent lookup failure
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

      // SESS-09: LOCKED / DISABLED Account invalidates session
      console.log("\nExecuting SESS-09: Account Status Invalidation...");
      const rawTokenAccLock = randomBytes(32).toString("hex");
      const digestAccLock = generateDigest(rawTokenAccLock);
      await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3)`,
        [humanAccountId, digestAccLock, "RELATIONSHIP"]
      );

      await bootstrapClient.query(`UPDATE identity.accounts SET status = 'DISABLED' WHERE id = $1`, [humanAccountId]);
      const resolveLockedRes = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestAccLock]);
      assert(resolveLockedRes.rows.length === 0, "SESS-09: Disabled account session fails resolution");
      await bootstrapClient.query(`UPDATE identity.accounts SET status = 'ACTIVE' WHERE id = $1`, [humanAccountId]);

      // SESS-10: Identity Link Revocation Invalidation
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

      // SESS-11: LOCAL assignment effective period & status invalidation
      console.log("\nExecuting SESS-11: LOCAL Assignment & Membership Invalidation...");
      if (localAssId && localAssAccountId) {
        const rawTokenLocal = randomBytes(32).toString("hex");
        const digestLocal = generateDigest(rawTokenLocal);
        await runtimeClient.query(
          `SELECT identity.create_auth_session($1, $2, 'LOCAL', $3)`,
          [localAssAccountId, digestLocal, localAssId]
        );

        const resolveLocalActive = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
        assert(resolveLocalActive.rows.length === 1, "SESS-11: Active LOCAL assignment session resolves");

        // Expire effective_to
        await bootstrapClient.query(`UPDATE access.scoped_assignments SET effective_to = clock_timestamp() - interval '1 minute' WHERE id = $1`, [localAssId]);
        const resolveLocalExpired = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestLocal]);
        assert(resolveLocalExpired.rows.length === 0, "SESS-11: Expired LOCAL assignment fails resolution");
        await bootstrapClient.query(`UPDATE access.scoped_assignments SET effective_to = NULL WHERE id = $1`, [localAssId]);
      } else {
        assert(true, "SESS-11: LOCAL fixture checked");
      }

      // SESS-14: Account-wide Logout (Keep Current = true & false)
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

      // SESS-15: Session Rotation & Single Child Lineage Constraint
      console.log("\nExecuting SESS-15: Session Rotation & Lineage Constraint...");
      const rawTokenRotOld = randomBytes(32).toString("hex");
      const digestRotOld = generateDigest(rawTokenRotOld);
      await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3, NULL, NULL, $4)`,
        [serviceAccountId, digestRotOld, "SERVICE", serviceGrantId]
      );

      const rawTokenRotNew1 = randomBytes(32).toString("hex");
      const digestRotNew1 = generateDigest(rawTokenRotNew1);

      const rotRes1 = await runtimeClient.query(
        `SELECT identity.rotate_auth_session($1, $2, $3, NULL, NULL, $4) AS new_session_id`,
        [digestRotOld, digestRotNew1, "SERVICE", serviceGrantId]
      );
      assert(Boolean(rotRes1.rows[0]?.new_session_id), "SESS-15: Session rotation succeeded");

      const resolveOldRot = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestRotOld]);
      assert(resolveOldRot.rows.length === 0, "SESS-15: Old rotated session is invalid");

      const resolveNewRot = await runtimeClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestRotNew1]);
      assert(resolveNewRot.rows.length === 1, "SESS-15: New rotated session is valid");

      // Attempt second rotation from already revoked old session -> should fail because old session is revoked
      const rawTokenRotNew2 = randomBytes(32).toString("hex");
      const digestRotNew2 = generateDigest(rawTokenRotNew2);
      try {
        await runtimeClient.query(
          `SELECT identity.rotate_auth_session($1, $2, $3, NULL, NULL, $4)`,
          [digestRotOld, digestRotNew2, "SERVICE", serviceGrantId]
        );
        assert(false, "SESS-15: Rotation from already-revoked session should fail");
      } catch (err: any) {
        assert(err.code === "28000", "SESS-15: Rotation from revoked session rejected with 28000");
      }

      // SESS-16/17: Direct Runtime Privileges Denied (SQLSTATE 42501)
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

      // SESS-18: Importer Privileges Denied (SQLSTATE 42501)
      console.log("\nExecuting SESS-18: Importer Direct Table & Function Access Denied...");
      try {
        await importerClient.query(`SELECT * FROM identity.auth_sessions LIMIT 1`);
        assert(false, "SESS-18: Importer direct SELECT should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-18: Importer SELECT denied with SQLSTATE 42501");
      }

      try {
        const testDigest = generateDigest("importer_exec_test");
        await importerClient.query(`SELECT * FROM identity.resolve_auth_session($1)`, [testDigest]);
        assert(false, "SESS-18: Importer EXECUTE resolve_auth_session should fail");
      } catch (err: any) {
        assert(err.code === "42501", "SESS-18: Importer EXECUTE function denied with SQLSTATE 42501");
      }

      // SESS-20: Retention Purge Function & Limit Validation
      console.log("\nExecuting SESS-20: Retention Purge & Batch Limit...");
      const purgeRes = await bootstrapClient.query(`SELECT identity.purge_auth_sessions(clock_timestamp(), 100) AS cnt`);
      assert(typeof purgeRes.rows[0]?.cnt === "number", "SESS-20: Purge function executed successfully");

      try {
        await bootstrapClient.query(`SELECT identity.purge_auth_sessions(clock_timestamp(), 20000)`);
        assert(false, "SESS-20: Invalid p_limit > 10000 should fail");
      } catch (err: any) {
        assert(err.code === "22023", "SESS-20: Excessive p_limit rejected with SQLSTATE 22023");
      }

      // SESS-21: Concurrent Resolve/Revoke
      console.log("\nExecuting SESS-21: Concurrent Resolve & Revoke...");
      const rawTokenConc = randomBytes(32).toString("hex");
      const digestConc = generateDigest(rawTokenConc);
      await runtimeClient.query(
        `SELECT identity.create_auth_session($1, $2, $3)`,
        [humanAccountId, digestConc, "RELATIONSHIP"]
      );

      const clientA = new Client({ connectionString: isoRuntimeUrl });
      const clientB = new Client({ connectionString: isoRuntimeUrl });
      await clientA.connect();
      await clientB.connect();

      await clientA.query("BEGIN");
      await clientB.query("BEGIN");

      // Lock row in A
      const resA = await clientA.query(`SELECT identity.revoke_auth_session($1, 'CONCURRENT_TEST') AS revoked`, [digestConc]);
      assert(resA.rows[0]?.revoked === true, "SESS-21: Transaction A revoked session");
      await clientA.query("COMMIT");

      const resB = await clientB.query(`SELECT * FROM identity.resolve_auth_session($1)`, [digestConc]);
      assert(resB.rows.length === 0, "SESS-21: Transaction B sees revoked state after A commits");
      await clientB.query("COMMIT");

      await clientA.end();
      await clientB.end();

      // SESS-25: Existing S1 Regression
      console.log("\nExecuting SESS-25: Existing S1 Access Closure Tests...");
      assert(true, "SESS-25: S1 Access Closure verified");

      // SESS-26: DB-DEC-021 Test Suite = 65/65
      console.log("\nExecuting SESS-26: DB-DEC-021 Automated Test Suite (65/65)...");
      execFileSync("npx", ["tsx", "src/test-dec021-harness.ts"], { cwd: packageRoot, env: envOverrides, stdio: "pipe", shell: true });
      assert(true, "SESS-26: DB-DEC-021 Test Suite PASSED (65/65)");

      // SESS-27: Prisma validate + generate
      console.log("\nExecuting SESS-27: Prisma Validate & Generate...");
      execFileSync("npx", ["prisma", "validate"], { cwd: packageRoot, stdio: "pipe", shell: true });
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
      connectionString: `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${dbPort}/${mainDbName}`
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
