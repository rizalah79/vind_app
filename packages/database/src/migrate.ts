import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

const RUNNER_VERSION = "1.0.1";

const LEGACY_PROVIDER_WORKSPACE_RLS_MIGRATION =
  "20260814222000_db_ho_03_01b_provider_catalog_local_read_rls_alignment";
const ADVISORY_LOCK_KEY_1 = 865241;
const ADVISORY_LOCK_KEY_2 = 20260805;

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");
const migrationsDirectory = path.join(
  packageRoot,
  "prisma",
  "migrations"
);

if (!process.env.DATABASE_MIGRATION_URL) {
  dotenv.config({
    path: path.join(packageRoot, ".env")
  });
}

const connectionString = process.env.DATABASE_MIGRATION_URL;

if (!connectionString) {
  throw new Error("DATABASE_MIGRATION_URL is required.");
}

const statusOnly = process.argv.includes("--status");

async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(migrationsDirectory, {
    withFileTypes: true
  });

  const directoryNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const migrations: Migration[] = [];

  for (const name of directoryNames) {
    if (!/^[0-9]{14}_[a-z0-9_]+$/.test(name)) {
      throw new Error(
        `Invalid migration directory name: ${name}`
      );
    }

    const sqlPath = path.join(
      migrationsDirectory,
      name,
      "migration.sql"
    );

    const sqlBytes = await readFile(sqlPath);
    const sql = sqlBytes.toString("utf8");

    if (!sql.trim()) {
      throw new Error(`Migration is empty: ${name}`);
    }

    migrations.push({
      name,
      sql,
      checksum: createHash("sha256")
        .update(sqlBytes)
        .digest("hex")
    });
  }

  return migrations;
}

async function ensureMigrationLedger(
  client: Client
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.vind_schema_migrations (
      migration_name text PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      execution_ms integer NOT NULL,
      session_user_name text NOT NULL,
      effective_role_name text NOT NULL,
      postgres_version text NOT NULL,
      runner_version text NOT NULL,

      CONSTRAINT vind_schema_migrations_name_format
        CHECK (
          migration_name ~ '^[0-9]{14}_[a-z0-9_]+$'
        ),

      CONSTRAINT vind_schema_migrations_checksum_format
        CHECK (
          checksum_sha256 ~ '^[0-9a-f]{64}$'
        ),

      CONSTRAINT vind_schema_migrations_execution_ms
        CHECK (execution_ms >= 0)
    )
  `);

  await client.query(`
    REVOKE ALL
    ON TABLE public.vind_schema_migrations
    FROM PUBLIC
  `);

  await client.query(`
    GRANT SELECT
    ON TABLE public.vind_schema_migrations
    TO vind_readonly
  `);
}

async function applyMigrationSql(
  client: Client,
  migration: Migration
): Promise<void> {
  if (
    migration.name !==
    LEGACY_PROVIDER_WORKSPACE_RLS_MIGRATION
  ) {
    await client.query(migration.sql);
    return;
  }

  const preconditionResult = await client.query(`
    SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls
    FROM pg_class c
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'provider'
      AND c.relname IN ('provider_profiles', 'provider_workspace_links')
      AND c.relkind = 'r'
  `);

  if (
    preconditionResult.rowCount !== 2 ||
    preconditionResult.rows.some((r) => r.rls_enabled !== true || r.force_rls !== true)
  ) {
    throw new Error(
      "Replay compatibility precondition failed for " +
      LEGACY_PROVIDER_WORKSPACE_RLS_MIGRATION +
      ": provider.provider_profiles and provider.provider_workspace_links must exist with relrowsecurity=true and relforcerowsecurity=true."
    );
  }

  console.log(
    `COMPAT   ${migration.name} ` +
    "(temporarily disabling FORCE RLS inside migration transaction)"
  );

  await client.query(`
    ALTER TABLE provider.provider_profiles
    NO FORCE ROW LEVEL SECURITY
  `);

  await client.query(`
    ALTER TABLE provider.provider_workspace_links
    NO FORCE ROW LEVEL SECURITY
  `);

  await client.query(migration.sql);

  await client.query(`
    ALTER TABLE provider.provider_profiles
    FORCE ROW LEVEL SECURITY
  `);

  await client.query(`
    ALTER TABLE provider.provider_workspace_links
    FORCE ROW LEVEL SECURITY
  `);

  const postconditionResult = await client.query(`
    SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls
    FROM pg_class c
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'provider'
      AND c.relname IN ('provider_profiles', 'provider_workspace_links')
      AND c.relkind = 'r'
  `);

  if (
    postconditionResult.rowCount !== 2 ||
    postconditionResult.rows.some((r) => r.rls_enabled !== true || r.force_rls !== true)
  ) {
    throw new Error(
      "Replay compatibility postcondition failed for " +
      LEGACY_PROVIDER_WORKSPACE_RLS_MIGRATION +
      ": provider.provider_profiles and provider.provider_workspace_links must have relrowsecurity=true and relforcerowsecurity=true after restore."
    );
  }
}

async function main(): Promise<void> {
  const migrations = await loadMigrations();
  const client = new Client({
    connectionString,
    application_name: "vind-migration-runner"
  });

  let advisoryLockAcquired = false;

  try {
    await client.connect();

    await client.query("SET ROLE vind_db_owner");
    await client.query("SET timezone TO 'UTC'");

    await client.query(
      "SELECT pg_advisory_lock($1, $2)",
      [ADVISORY_LOCK_KEY_1, ADVISORY_LOCK_KEY_2]
    );

    advisoryLockAcquired = true;

    await ensureMigrationLedger(client);

    const appliedResult = await client.query(`
      SELECT migration_name, checksum_sha256
      FROM public.vind_schema_migrations
      ORDER BY migration_name
    `);

    const appliedMigrations = new Map<string, string>();

    for (const row of appliedResult.rows as Array<{
      migration_name: string;
      checksum_sha256: string;
    }>) {
      appliedMigrations.set(
        row.migration_name,
        row.checksum_sha256
      );
    }

    let hasChecksumMismatch = false;
    const pending: Migration[] = [];

    for (const migration of migrations) {
      const existingChecksum = appliedMigrations.get(
        migration.name
      );

      if (!existingChecksum) {
        console.log(`PENDING  ${migration.name}`);
        pending.push(migration);
        continue;
      }

      if (existingChecksum !== migration.checksum) {
        console.error(`MISMATCH ${migration.name}`);
        console.error(`  recorded: ${existingChecksum}`);
        console.error(`  current:  ${migration.checksum}`);
        hasChecksumMismatch = true;
        continue;
      }

      console.log(`APPLIED  ${migration.name}`);
    }

    if (hasChecksumMismatch) {
      throw new Error(
        "Migration checksum mismatch detected. " +
        "Applied migrations must never be edited."
      );
    }

    if (statusOnly) {
      console.log(
        `Status complete: ${pending.length} pending migration(s).`
      );
      return;
    }

    for (const migration of pending) {
      const startedAt = Date.now();

      await client.query("BEGIN");

      try {
        await client.query(
          "SET LOCAL lock_timeout TO '15s'"
        );
        await client.query(
          "SET LOCAL statement_timeout TO '0'"
        );
        await client.query(
          "SET LOCAL idle_in_transaction_session_timeout TO '5min'"
        );
        await client.query(
          "SET LOCAL timezone TO 'UTC'"
        );

        await applyMigrationSql(client, migration);

        const identityResult = await client.query(`
          SELECT
            session_user::text AS session_user_name,
            current_user::text AS effective_role_name,
            current_setting('server_version') AS postgres_version
        `);

        const identity = identityResult.rows[0] as {
          session_user_name: string;
          effective_role_name: string;
          postgres_version: string;
        };

        const executionMs = Date.now() - startedAt;

        await client.query(
          `
            INSERT INTO public.vind_schema_migrations (
              migration_name,
              checksum_sha256,
              execution_ms,
              session_user_name,
              effective_role_name,
              postgres_version,
              runner_version
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            migration.name,
            migration.checksum,
            executionMs,
            identity.session_user_name,
            identity.effective_role_name,
            identity.postgres_version,
            RUNNER_VERSION
          ]
        );

        await client.query("COMMIT");

        console.log(
          `MIGRATED ${migration.name} (${executionMs} ms)`
        );
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log(
      `Migration complete: ${pending.length} applied.`
    );
  } finally {
    if (advisoryLockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock($1, $2)",
          [ADVISORY_LOCK_KEY_1, ADVISORY_LOCK_KEY_2]
        );
      } catch {
        // Connection close also releases session advisory locks.
      }
    }

    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);

  console.error(message);
  process.exitCode = 1;
});