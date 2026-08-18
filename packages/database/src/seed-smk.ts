import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

type SeedCommand = "apply" | "verify" | "cleanup";

interface SeedIds {
  ownerAlphaPersonId: string;
  alphaOrganizationId: string;
  betaOrganizationId: string;
}

interface CountExpectation {
  label: string;
  sql: string;
  expected: number;
}

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");
const seedDirectory = path.join(
  packageRoot,
  "prisma",
  "seeds",
  "smk-slice-1"
);

dotenv.config({
  path: path.join(packageRoot, ".env")
});

const command = (process.argv[2] ?? "apply") as SeedCommand;
const argumentsSet = new Set(process.argv.slice(3));

const rawMigrationUrl = process.env.DATABASE_MIGRATION_URL;

function getMigrationUrl(): string | undefined {
  if (!rawMigrationUrl) return undefined;
  const url = new URL(rawMigrationUrl);
  url.searchParams.set("options", "-c role=vind_db_owner");
  return url.toString();
}

const migrationConnectionString = getMigrationUrl();

const runtimeConnectionString =
  process.env.DATABASE_URL;

if (!migrationConnectionString) {
  throw new Error("DATABASE_MIGRATION_URL is required.");
}

if (!runtimeConnectionString) {
  throw new Error("DATABASE_URL is required.");
}

function validateLocalConnectionUrl(
  connectionString: string,
  label: string
): void {
  const parsed = new URL(connectionString);

  if (
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost"
  ) {
    throw new Error(
      `${label} must use localhost. Received: ${parsed.hostname}`
    );
  }

  const effectivePort = parsed.port || "5432";
  if (effectivePort !== "5432" && effectivePort !== process.env.ISOLATED_PORT) {
    throw new Error(
      `${label} must use port 5432. Received: ${parsed.port || "default (5432)"}`
    );
  }

  if (parsed.pathname !== "/vind_app_dev" && (!process.env.ISOLATED_DB_NAME || parsed.pathname !== `/${process.env.ISOLATED_DB_NAME}`)) {
    throw new Error(
      `${label} must target vind_app_dev. ` +
      `Received: ${parsed.pathname}`
    );
  }
}

validateLocalConnectionUrl(
  migrationConnectionString,
  "DATABASE_MIGRATION_URL"
);

validateLocalConnectionUrl(
  runtimeConnectionString,
  "DATABASE_URL"
);

function assertEqual(
  actual: number,
  expected: number,
  label: string
): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${expected}, received ${actual}`
    );
  }

  console.log(`PASS ${label}: ${actual}`);
}

async function assertDatabaseIdentity(
  client: Client,
  expectedSessionUser: string
): Promise<void> {
  const result = await client.query<{
    database_name: string;
    session_user_name: string;
    effective_user_name: string;
  }>(`
    SELECT
      current_database()::text AS database_name,
      session_user::text AS session_user_name,
      current_user::text AS effective_user_name
  `);

  const identity = result.rows[0];

  if (!identity) {
    throw new Error("Database identity query returned no row.");
  }

  if (identity.database_name !== "vind_app_dev" && (!process.env.ISOLATED_DB_NAME || identity.database_name !== process.env.ISOLATED_DB_NAME)) {
    throw new Error(
      `Refusing database: ${identity.database_name}`
    );
  }

  if (identity.session_user_name !== expectedSessionUser) {
    throw new Error(
      `Expected session user ${expectedSessionUser}, ` +
      `received ${identity.session_user_name}`
    );
  }

  if (identity.effective_user_name !== expectedSessionUser && identity.effective_user_name !== "vind_db_owner") {
    throw new Error(
      `Unexpected effective user: ${identity.effective_user_name}`
    );
  }
}

async function assertRequiredMigrations(
  client: Client
): Promise<void> {
  const result = await client.query<{
    migration_name: string;
  }>(`
    SELECT migration_name
    FROM public.vind_schema_migrations
    WHERE migration_name IN (
      '20260805093000_platform_control_core',
      '20260805210000_identity_organization_access',
      '20260808140000_foundation_access_closure_s1'
    )
    ORDER BY migration_name
  `);

  if (result.rowCount !== 3) {
    throw new Error(
      "Required Platform Control Core, Slice 1, and S1 Access Closure " +
      "migrations are not all applied."
    );
  }
}

async function queryCount(
  client: Client,
  sql: string
): Promise<number> {
  const result = await client.query<{ count: string }>(sql);
  const value = Number(result.rows[0]?.count);

  if (!Number.isInteger(value)) {
    throw new Error(`Invalid count result for query: ${sql}`);
  }

  return value;
}

const seedCountExpectations: CountExpectation[] = [
  {
    label: "organizations",
    sql: `
      SELECT count(*)::text AS count
      FROM organization.organizations
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 2
  },
  {
    label: "workspaces",
    sql: `
      SELECT count(*)::text AS count
      FROM organization.workspaces
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 2
  },
  {
    label: "locations",
    sql: `
      SELECT count(*)::text AS count
      FROM geo.locations
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 2
  },
  {
    label: "persons",
    sql: `
      SELECT count(*)::text AS count
      FROM party.persons
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 4
  },
  {
    label: "contact points",
    sql: `
      SELECT count(*)::text AS count
      FROM party.contact_points
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 6
  },
  {
    label: "consumer profiles",
    sql: `
      SELECT count(*)::text AS count
      FROM party.consumer_profiles
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 1
  },
  {
    label: "accounts",
    sql: `
      SELECT count(*)::text AS count
      FROM identity.accounts
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 4
  },
  {
    label: "identity links",
    sql: `
      SELECT count(*)::text AS count
      FROM identity.identity_links
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 4
  },
  {
    label: "memberships",
    sql: `
      SELECT count(*)::text AS count
      FROM access.memberships
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 3
  },
  {
    label: "scoped assignments",
    sql: `
      SELECT count(*)::text AS count
      FROM access.scoped_assignments
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 3
  },
  {
    label: "PIC assignments",
    sql: `
      SELECT count(*)::text AS count
      FROM access.pic_assignments
      WHERE seed_key LIKE 'smk:s1:%'
    `,
    expected: 3
  }
];

async function verifySeedCounts(
  client: Client
): Promise<void> {
  for (const expectation of seedCountExpectations) {
    const actual = await queryCount(
      client,
      expectation.sql
    );

    assertEqual(
      actual,
      expectation.expected,
      `SMK ${expectation.label}`
    );
  }
}

async function verifyNoSeedRows(
  client: Client
): Promise<void> {
  for (const expectation of seedCountExpectations) {
    const actual = await queryCount(
      client,
      expectation.sql
    );

    assertEqual(
      actual,
      0,
      `cleanup ${expectation.label}`
    );
  }
}

async function verifySyntheticInvariants(
  client: Client
): Promise<void> {
  const personViolations = await queryCount(client, `
    SELECT count(*)::text AS count
    FROM party.persons
    WHERE seed_key LIKE 'smk:s1:%'
      AND (
        is_synthetic = false
        OR contactable = true
      )
  `);

  assertEqual(
    personViolations,
    0,
    "synthetic person violations"
  );

  const organizationViolations = await queryCount(client, `
    SELECT count(*)::text AS count
    FROM organization.organizations
    WHERE seed_key LIKE 'smk:s1:%'
      AND (
        is_synthetic = false
        OR organization_type <> 'SYNTHETIC_DEMO'
      )
  `);

  assertEqual(
    organizationViolations,
    0,
    "synthetic organization violations"
  );

  const contactViolations = await queryCount(client, `
    SELECT count(*)::text AS count
    FROM party.contact_points
    WHERE seed_key LIKE 'smk:s1:%'
      AND (
        is_synthetic = false
        OR contactable = true
        OR (
          contact_type = 'EMAIL'
          AND normalized_value NOT LIKE '%.invalid'
        )
        OR (
          contact_type = 'PHONE'
          AND normalized_value NOT LIKE 'otp-sim:%'
        )
      )
  `);

  assertEqual(
    contactViolations,
    0,
    "synthetic contact violations"
  );

  const locationViolations = await queryCount(client, `
    SELECT count(*)::text AS count
    FROM geo.locations
    WHERE seed_key LIKE 'smk:s1:%'
      AND (
        is_synthetic = false
        OR coordinate_source_type <> 'SYNTHETIC'
      )
  `);

  assertEqual(
    locationViolations,
    0,
    "synthetic location violations"
  );

  const personOriginViolations = await queryCount(client, `
    SELECT count(*)::text AS count
    FROM party.persons
    WHERE seed_key LIKE 'smk:s1:%'
      AND (
        data_origin_code <> 'SYNTHETIC_DEMO'
        OR source_reference IS NULL
      )
  `);

  assertEqual(
    personOriginViolations,
    0,
    "synthetic person provenance violations"
  );

  const organizationOriginViolations = await queryCount(client, `
    SELECT count(*)::text AS count
    FROM organization.organizations
    WHERE seed_key LIKE 'smk:s1:%'
      AND (
        data_origin_code <> 'SYNTHETIC_DEMO'
        OR source_reference IS NULL
      )
  `);

  assertEqual(
    organizationOriginViolations,
    0,
    "synthetic organization provenance violations"
  );

  const accountOriginViolations = await queryCount(client, `
    SELECT count(*)::text AS count
    FROM identity.accounts
    WHERE seed_key LIKE 'smk:s1:%'
      AND (
        data_origin_code <> 'SYNTHETIC_DEMO'
        OR source_reference IS NULL
      )
  `);

  assertEqual(
    accountOriginViolations,
    0,
    "synthetic account provenance violations"
  );
}

async function loadSeedIds(
  client: Client
): Promise<SeedIds> {
  const result = await client.query<SeedIds>(`
    SELECT
      (
        SELECT id::text
        FROM party.persons
        WHERE seed_key = 'smk:s1:person:owner_alpha'
      ) AS "ownerAlphaPersonId",
      (
        SELECT id::text
        FROM organization.organizations
        WHERE seed_key = 'smk:s1:org:alpha'
      ) AS "alphaOrganizationId",
      (
        SELECT id::text
        FROM organization.organizations
        WHERE seed_key = 'smk:s1:org:beta'
      ) AS "betaOrganizationId"
  `);

  const ids = result.rows[0];

  if (
    !ids?.ownerAlphaPersonId ||
    !ids.alphaOrganizationId ||
    !ids.betaOrganizationId
  ) {
    throw new Error("Required SMK identifiers are missing.");
  }

  return ids;
}

async function setRequestContext(
  client: Client,
  values: {
    accountKey: string;
    personKey: string;
    membershipKey?: string;
    assignmentKey?: string;
    organizationKey?: string;
    workspaceKey?: string;
    channelCode?: string;
    purposeCode: string;
  }
): Promise<void> {
  await client.query(
    `
      SELECT security.set_request_context(
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10
      )
    `,
    [
      values.accountKey,
      values.personKey,
      values.membershipKey ?? null,
      values.assignmentKey ?? null,
      values.organizationKey ?? null,
      values.workspaceKey ?? null,
      values.channelCode ?? "VINDZAM",
      "smk-s1-correlation",
      "smk-s1-request",
      values.purposeCode
    ]
  );
}

async function withTransaction(
  client: Client,
  operation: () => Promise<void>
): Promise<void> {
  await client.query("BEGIN");

  try {
    await client.query("SET LOCAL timezone TO 'UTC'");
    await operation();
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function getDatabaseErrorCode(
  error: unknown
): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error
  ) {
    return String(
      (error as { code?: unknown }).code
    );
  }

  return undefined;
}

async function verifyRuntimeRls(
  client: Client,
  ids: SeedIds
): Promise<void> {
  await withTransaction(client, async () => {
    const personCount = await queryCount(client, `
      SELECT count(*)::text AS count
      FROM party.persons
      WHERE seed_key LIKE 'smk:s1:%'
    `);

    const organizationCount = await queryCount(client, `
      SELECT count(*)::text AS count
      FROM organization.organizations
      WHERE seed_key LIKE 'smk:s1:%'
    `);

    assertEqual(personCount, 0, "RLS no-context persons");
    assertEqual(
      organizationCount,
      0,
      "RLS no-context organizations"
    );
  });

  await withTransaction(client, async () => {
    await setRequestContext(client, {
      accountKey: "smk:s1:account:owner_alpha",
      personKey: "smk:s1:person:owner_alpha",
      membershipKey: "smk:s1:membership:owner_alpha",
      assignmentKey: "smk:s1:assignment:owner_alpha",
      organizationKey: "smk:s1:org:alpha",
      workspaceKey: "smk:s1:workspace:alpha",
      channelCode: "VINDZAM",
      purposeCode: "SMK_OWNER_ALPHA_TEST"
    });

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM party.persons
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Alpha own person"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM party.contact_points
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      2,
      "RLS owner Alpha contacts"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM identity.accounts
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Alpha account"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM organization.organizations
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Alpha organization"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM organization.workspaces
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Alpha workspace"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM geo.locations
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Alpha location"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM access.memberships
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      2,
      "RLS owner Alpha organization memberships"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM access.scoped_assignments
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Alpha scoped assignments"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM access.pic_assignments
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Alpha PIC assignments"
    );

    const crossTenantUpdate = await client.query(`
      UPDATE organization.organizations
      SET display_name = display_name
      WHERE seed_key = 'smk:s1:org:beta'
      RETURNING id
    `);

    assertEqual(
      crossTenantUpdate.rowCount ?? 0,
      0,
      "RLS cross-tenant update hidden"
    );

    await client.query("SAVEPOINT cross_tenant_insert");

    let denialVerified = false;

    try {
      await client.query(
        `
          INSERT INTO access.memberships (
            seed_key,
            person_id,
            organization_id,
            workspace_id,
            status,
            effective_from,
            accepted_at
          )
          VALUES (
            'smk:s1:test:cross_org_denied',
            $1::uuid,
            $2::uuid,
            NULL,
            'ACTIVE',
            '2026-08-05T00:00:00Z'::timestamptz,
            '2026-08-05T00:00:00Z'::timestamptz
          )
        `,
        [
          ids.ownerAlphaPersonId,
          ids.betaOrganizationId
        ]
      );
    } catch (error) {
      await client.query(
        "ROLLBACK TO SAVEPOINT cross_tenant_insert"
      );

      const errorCode = getDatabaseErrorCode(error);

      if (errorCode !== "42501") {
        throw new Error(
          "Cross-tenant insert failed for an unexpected " +
          `reason. PostgreSQL code: ${errorCode ?? "unknown"}`
        );
      }

      denialVerified = true;
    }

    if (!denialVerified) {
      await client.query(
        "ROLLBACK TO SAVEPOINT cross_tenant_insert"
      );

      throw new Error(
        "RLS cross-tenant membership insert was not denied."
      );
    }

    await client.query(
      "RELEASE SAVEPOINT cross_tenant_insert"
    );

    console.log(
      "PASS RLS cross-tenant insert denied with code 42501"
    );
  });

  await withTransaction(client, async () => {
    await setRequestContext(client, {
      accountKey: "smk:s1:account:owner_beta",
      personKey: "smk:s1:person:owner_beta",
      membershipKey: "smk:s1:membership:owner_beta",
      assignmentKey: "smk:s1:assignment:owner_beta",
      organizationKey: "smk:s1:org:beta",
      workspaceKey: "smk:s1:workspace:beta",
      channelCode: "VINDLOKA",
      purposeCode: "SMK_OWNER_BETA_TEST"
    });

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM party.persons
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Beta own person"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM organization.organizations
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Beta organization"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM access.memberships
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS owner Beta memberships"
    );
  });

  await withTransaction(client, async () => {
    await setRequestContext(client, {
      accountKey: "smk:s1:account:consumer",
      personKey: "smk:s1:person:consumer",
      channelCode: "VINDZAM",
      purposeCode: "SMK_CONSUMER_TEST"
    });

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM party.persons
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS consumer own person"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM party.contact_points
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      2,
      "RLS consumer contacts"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM party.consumer_profiles
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      1,
      "RLS consumer profile"
    );

    assertEqual(
      await queryCount(client, `
        SELECT count(*)::text AS count
        FROM organization.organizations
        WHERE seed_key LIKE 'smk:s1:%'
      `),
      0,
      "RLS consumer organizations"
    );
  });
}

async function applySeed(): Promise<void> {
  const seedSql = await readFile(
    path.join(seedDirectory, "seed.sql"),
    "utf8"
  );

  const client = new Client({
    connectionString: migrationConnectionString,
    application_name: "vind-smk-slice-1-apply"
  });

  try {
    await client.connect();

    await assertDatabaseIdentity(
      client,
      "vind_migrator"
    );

    await assertRequiredMigrations(client);

    await client.query("BEGIN");
    await client.query("SET ROLE vind_db_owner");

    try {
      await client.query(
        "SET LOCAL lock_timeout TO '15s'"
      );
      await client.query(
        "SET LOCAL statement_timeout TO '2min'"
      );
      await client.query(seedSql);
      await client.query("RESET ROLE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    await verifySeedCounts(client);
    await verifySyntheticInvariants(client);

    console.log(
      "SMK Slice 1 seed applied successfully."
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifySeed(): Promise<void> {
  const importClient = new Client({
    connectionString: migrationConnectionString,
    application_name: "vind-smk-slice-1-verify-migrator"
  });

  let ids: SeedIds;

  try {
    await importClient.connect();
    await assertDatabaseIdentity(
      importClient,
      "vind_migrator"
    );
    await assertRequiredMigrations(importClient);
    await verifySeedCounts(importClient);
    await verifySyntheticInvariants(importClient);
    ids = await loadSeedIds(importClient);
  } finally {
    await importClient.end().catch(() => undefined);
  }

  const runtimeClient = new Client({
    connectionString: runtimeConnectionString,
    application_name: "vind-smk-slice-1-verify-runtime"
  });

  try {
    await runtimeClient.connect();
    await assertDatabaseIdentity(
      runtimeClient,
      "vind_app_runtime"
    );
    await verifyRuntimeRls(runtimeClient, ids);

    console.log(
      "SMK Slice 1 seed and RLS verification passed."
    );
  } finally {
    await runtimeClient.end().catch(() => undefined);
  }
}

async function cleanupSeed(): Promise<void> {
  if (!argumentsSet.has("--confirm-smk-cleanup")) {
    throw new Error(
      "Cleanup requires --confirm-smk-cleanup."
    );
  }

  const cleanupSql = await readFile(
    path.join(seedDirectory, "cleanup.sql"),
    "utf8"
  );

  const client = new Client({
    connectionString: migrationConnectionString,
    application_name: "vind-smk-slice-1-cleanup"
  });

  try {
    await client.connect();
    await assertDatabaseIdentity(client, "vind_migrator");

    await client.query("BEGIN");

    try {
      await client.query(
        "SET LOCAL lock_timeout TO '15s'"
      );
      await client.query(
        "SET LOCAL statement_timeout TO '2min'"
      );
      await client.query(cleanupSql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    await verifyNoSeedRows(client);

    console.log(
      "SMK Slice 1 seed cleanup completed."
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "apply":
      await applySeed();
      return;

    case "verify":
      await verifySeed();
      return;

    case "cleanup":
      await cleanupSeed();
      return;

    default:
      throw new Error(
        `Unsupported seed command: ${String(command)}`
      );
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.stack ?? error.message
      : String(error);

  console.error(message);
  process.exitCode = 1;
});