import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");

dotenv.config({
  path: path.join(packageRoot, ".env")
});

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL;

if (!adminUrl) {
  throw new Error("DATABASE_TEST_ADMIN_URL is required.");
}

function validateLocalTestUrl(connectionString: string): void {
  const parsed = new URL(connectionString);

  if (
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost"
  ) {
    throw new Error(
      `A01 corrective tests require localhost. Received: ${parsed.hostname}`
    );
  }

  if (parsed.port !== "5432") {
    throw new Error(
      `A01 corrective tests require host port 5432. Received: ${parsed.port}`
    );
  }

  if (parsed.pathname !== "/vind_app_dev") {
    throw new Error(
      `A01 corrective tests require database vind_app_dev. Received: ${parsed.pathname}`
    );
  }
}

validateLocalTestUrl(adminUrl);

let passCount = 0;

function assert(
  condition: unknown,
  label: string
): asserts condition {
  if (!condition) {
    throw new Error(`FAIL ${label}`);
  }

  passCount += 1;
  console.log(`PASS ${String(passCount).padStart(2, "0")} ${label}`);
}

async function setRole(
  client: Client,
  role: "vind_importer" | "vind_app_runtime"
): Promise<void> {
  await client.query("RESET ROLE");
  await client.query(`SET ROLE ${role}`);
  await client.query("SET LOCAL row_security = on");
}

async function setContext(
  client: Client,
  personKey: string,
  purposeCode: string
): Promise<void> {
  await client.query(
    `
      SELECT security.set_request_context(
        $1, $2, NULL, NULL, NULL,
        NULL, $3, $4, $5, $6
      )
    `,
    [
      `a01fix:account:${personKey}`,
      personKey,
      "VINDZAM",
      "db-dec-021-a01-fix-correlation",
      "db-dec-021-a01-fix-request",
      purposeCode
    ]
  );
}

async function idBySeed(
  client: Client,
  table: string,
  seedKey: string
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM ${table} WHERE seed_key = $1`,
    [seedKey]
  );

  const id = result.rows[0]?.id;

  if (!id) {
    throw new Error(`Required fixture not found: ${table} ${seedKey}`);
  }

  return id;
}

async function capability(
  client: Client,
  capabilityCode: string,
  personId: string,
  organizationId: string | null = null
): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `
      SELECT access.current_actor_has_capability_for_scope(
        $1,
        'PERSON',
        $2::uuid,
        $3::uuid,
        NULL
      ) AS allowed
    `,
    [capabilityCode, personId, organizationId]
  );

  return result.rows[0]?.allowed === true;
}

async function main(): Promise<void> {
  const client = new Client({
    connectionString: adminUrl,
    application_name: "vind-db-dec-021-a01-corrective-test"
  });

  await client.connect();

  try {
    const identity = await client.query<{
      database_name: string;
      session_user_name: string;
    }>(`
      SELECT
        current_database()::text AS database_name,
        session_user::text AS session_user_name
    `);

    assert(
      identity.rows[0]?.database_name === "vind_app_dev",
      "database identity is vind_app_dev"
    );

    const ledger = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM public.vind_schema_migrations
      WHERE migration_name IN (
        '20260807223700_access_person_scope_db_dec_021_a01',
        '20260808005900_access_sensitive_capability_mapping_db_dec_021_a01_fix'
      )
    `);

    assert(
      Number(ledger.rows[0]?.count) === 2,
      "original A01 and corrective migration ledger entries exist"
    );

    const roles = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM access.roles
      WHERE code IN ('MODERATOR', 'OPERATIONS_ADMIN')
        AND is_active = true
    `);

    assert(
      Number(roles.rows[0]?.count) === 2,
      "MODERATOR and OPERATIONS_ADMIN are active"
    );

    const mapping = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM access.role_capabilities
      WHERE (role_code, capability_code, effect) IN (
        ('OWNER', 'provider.status.transition', 'ALLOW'),
        ('OWNER', 'provider.management_authority.manage', 'ALLOW'),
        ('OWNER', 'listing.publication.transition', 'ALLOW'),
        ('ADMIN', 'provider.status.transition', 'ALLOW'),
        ('ADMIN', 'listing.publication.transition', 'ALLOW'),
        ('CONTENT_MANAGER', 'listing.publication.transition', 'ALLOW'),
        ('MODERATOR', 'verification.evidence.read', 'ALLOW'),
        ('OPERATIONS_ADMIN', 'verification.evidence.read', 'ALLOW'),
        ('OPERATIONS_ADMIN', 'provider.status.transition', 'ALLOW')
      )
    `);

    assert(
      Number(mapping.rows[0]?.count) === 9,
      "all nine locked role-capability ALLOW mappings exist"
    );

    const forbidden = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM access.role_capabilities rc
      WHERE rc.role_code IN (
        'OWNER',
        'ADMIN',
        'CONTENT_MANAGER',
        'MODERATOR',
        'OPERATIONS_ADMIN',
        'OPERATIONS_STAFF',
        'ACCOUNTING'
      )
        AND rc.capability_code IN (
          'provider.status.transition',
          'provider.management_authority.manage',
          'listing.publication.transition',
          'verification.evidence.read'
        )
        AND NOT (
          (
            rc.role_code = 'OWNER'
            AND rc.capability_code IN (
              'provider.status.transition',
              'provider.management_authority.manage',
              'listing.publication.transition'
            )
            AND rc.effect = 'ALLOW'
          )
          OR
          (
            rc.role_code = 'ADMIN'
            AND rc.capability_code IN (
              'provider.status.transition',
              'listing.publication.transition'
            )
            AND rc.effect = 'ALLOW'
          )
          OR
          (
            rc.role_code = 'CONTENT_MANAGER'
            AND rc.capability_code = 'listing.publication.transition'
            AND rc.effect = 'ALLOW'
          )
          OR
          (
            rc.role_code = 'MODERATOR'
            AND rc.capability_code = 'verification.evidence.read'
            AND rc.effect = 'ALLOW'
          )
          OR
          (
            rc.role_code = 'OPERATIONS_ADMIN'
            AND rc.capability_code IN (
              'verification.evidence.read',
              'provider.status.transition'
            )
            AND rc.effect = 'ALLOW'
          )
        )
    `);

    assert(
      Number(forbidden.rows[0]?.count) === 0,
      "no forbidden mapping exists for the seven locked roles"
    );

    await client.query("BEGIN");
    await client.query("SET LOCAL timezone TO 'UTC'");

    try {
      await setRole(client, "vind_importer");

      await client.query(`
        INSERT INTO party.persons (
          seed_key,
          display_name,
          preferred_name,
          legal_name,
          status,
          locale_code,
          timezone_name,
          is_synthetic,
          contactable
        )
        VALUES
          ('smk:a01fix:person:moderator', 'A01 Fix Moderator', 'Moderator', 'A01 Fix Moderator', 'ACTIVE', 'id-ID', 'Asia/Jakarta', true, false),
          ('smk:a01fix:person:operations_admin', 'A01 Fix Operations Admin', 'Operations Admin', 'A01 Fix Operations Admin', 'ACTIVE', 'id-ID', 'Asia/Jakarta', true, false),
          ('smk:a01fix:person:owner', 'A01 Fix Owner', 'Owner', 'A01 Fix Owner', 'ACTIVE', 'id-ID', 'Asia/Jakarta', true, false),
          ('smk:a01fix:person:admin', 'A01 Fix Admin', 'Admin', 'A01 Fix Admin', 'ACTIVE', 'id-ID', 'Asia/Jakarta', true, false),
          ('smk:a01fix:person:operations_staff', 'A01 Fix Operations Staff', 'Operations Staff', 'A01 Fix Operations Staff', 'ACTIVE', 'id-ID', 'Asia/Jakarta', true, false),
          ('smk:a01fix:person:expired_moderator', 'A01 Fix Expired Moderator', 'Expired Moderator', 'A01 Fix Expired Moderator', 'ACTIVE', 'id-ID', 'Asia/Jakarta', true, false),
          ('smk:a01fix:person:future_operations_admin', 'A01 Fix Future Operations Admin', 'Future Operations Admin', 'A01 Fix Future Operations Admin', 'ACTIVE', 'id-ID', 'Asia/Jakarta', true, false)
      `);

      const moderatorId = await idBySeed(
        client,
        "party.persons",
        "smk:a01fix:person:moderator"
      );
      const operationsAdminId = await idBySeed(
        client,
        "party.persons",
        "smk:a01fix:person:operations_admin"
      );
      const ownerId = await idBySeed(
        client,
        "party.persons",
        "smk:a01fix:person:owner"
      );
      const adminId = await idBySeed(
        client,
        "party.persons",
        "smk:a01fix:person:admin"
      );
      const operationsStaffId = await idBySeed(
        client,
        "party.persons",
        "smk:a01fix:person:operations_staff"
      );
      const expiredModeratorId = await idBySeed(
        client,
        "party.persons",
        "smk:a01fix:person:expired_moderator"
      );
      const futureOperationsAdminId = await idBySeed(
        client,
        "party.persons",
        "smk:a01fix:person:future_operations_admin"
      );

      await client.query(
        `
          INSERT INTO access.scoped_assignments (
            seed_key,
            membership_id,
            role_code,
            scope_type,
            person_id,
            organization_id,
            workspace_id,
            status,
            effective_from,
            effective_to,
            reason_code
          )
          VALUES
            ('smk:a01fix:assignment:moderator', NULL, 'MODERATOR', 'PERSON', $1::uuid, NULL, NULL, 'ACTIVE', statement_timestamp() - interval '1 day', NULL, 'A01_FIX_TEST'),
            ('smk:a01fix:assignment:operations_admin', NULL, 'OPERATIONS_ADMIN', 'PERSON', $2::uuid, NULL, NULL, 'ACTIVE', statement_timestamp() - interval '1 day', NULL, 'A01_FIX_TEST'),
            ('smk:a01fix:assignment:owner', NULL, 'OWNER', 'PERSON', $3::uuid, NULL, NULL, 'ACTIVE', statement_timestamp() - interval '1 day', NULL, 'A01_FIX_TEST'),
            ('smk:a01fix:assignment:admin', NULL, 'ADMIN', 'PERSON', $4::uuid, NULL, NULL, 'ACTIVE', statement_timestamp() - interval '1 day', NULL, 'A01_FIX_TEST'),
            ('smk:a01fix:assignment:operations_staff', NULL, 'OPERATIONS_STAFF', 'PERSON', $5::uuid, NULL, NULL, 'ACTIVE', statement_timestamp() - interval '1 day', NULL, 'A01_FIX_TEST'),
            ('smk:a01fix:assignment:expired_moderator', NULL, 'MODERATOR', 'PERSON', $6::uuid, NULL, NULL, 'ACTIVE', statement_timestamp() - interval '3 day', statement_timestamp() - interval '1 day', 'A01_FIX_TEST'),
            ('smk:a01fix:assignment:future_operations_admin', NULL, 'OPERATIONS_ADMIN', 'PERSON', $7::uuid, NULL, NULL, 'ACTIVE', statement_timestamp() + interval '1 day', NULL, 'A01_FIX_TEST')
        `,
        [
          moderatorId,
          operationsAdminId,
          ownerId,
          adminId,
          operationsStaffId,
          expiredModeratorId,
          futureOperationsAdminId
        ]
      );

      await setRole(client, "vind_app_runtime");

      await setContext(
        client,
        "smk:a01fix:person:moderator",
        "A01_FIX_MODERATOR"
      );

      assert(
        await capability(
          client,
          "verification.evidence.read",
          moderatorId
        ),
        "MODERATOR evidence-read positive"
      );

      assert(
        !await capability(
          client,
          "provider.status.transition",
          moderatorId
        ),
        "MODERATOR unrelated provider-status capability negative"
      );

      await setContext(
        client,
        "smk:a01fix:person:operations_admin",
        "A01_FIX_OPERATIONS_ADMIN"
      );

      assert(
        await capability(
          client,
          "verification.evidence.read",
          operationsAdminId
        ),
        "OPERATIONS_ADMIN evidence-read positive"
      );

      assert(
        await capability(
          client,
          "provider.status.transition",
          operationsAdminId
        ),
        "OPERATIONS_ADMIN provider-status positive"
      );

      assert(
        !await capability(
          client,
          "listing.publication.transition",
          operationsAdminId
        ),
        "OPERATIONS_ADMIN unrelated publication capability negative"
      );

      await setContext(client, "smk:a01fix:person:owner", "A01_FIX_OWNER");

      assert(
        !await capability(client, "verification.evidence.read", ownerId),
        "OWNER evidence-read negative"
      );

      await setContext(client, "smk:a01fix:person:admin", "A01_FIX_ADMIN");

      assert(
        !await capability(client, "verification.evidence.read", adminId),
        "ADMIN evidence-read negative"
      );

      await setContext(
        client,
        "smk:a01fix:person:operations_staff",
        "A01_FIX_OPERATIONS_STAFF"
      );

      assert(
        !await capability(
          client,
          "verification.evidence.read",
          operationsStaffId
        ),
        "unrelated-role evidence-read negative"
      );

      assert(
        !await capability(
          client,
          "provider.status.transition",
          operationsStaffId
        ),
        "unrelated-role provider-status negative"
      );

      await setContext(
        client,
        "smk:a01fix:person:moderator",
        "A01_FIX_SCOPE_BOUNDARY"
      );

      assert(
        !await capability(
          client,
          "verification.evidence.read",
          operationsAdminId
        ),
        "PERSON scope boundary cannot authorize another person"
      );

      assert(
        !await capability(
          client,
          "verification.evidence.read",
          moderatorId,
          "00000000-0000-0000-0000-000000000001"
        ),
        "invalid PERSON target XOR fails closed"
      );

      await setContext(
        client,
        "smk:a01fix:person:expired_moderator",
        "A01_FIX_EXPIRED"
      );

      assert(
        !await capability(
          client,
          "verification.evidence.read",
          expiredModeratorId
        ),
        "expired MODERATOR assignment is authorization-ineffective"
      );

      await setContext(
        client,
        "smk:a01fix:person:future_operations_admin",
        "A01_FIX_FUTURE"
      );

      assert(
        !await capability(
          client,
          "provider.status.transition",
          futureOperationsAdminId
        ),
        "future OPERATIONS_ADMIN assignment is authorization-ineffective"
      );

      await client.query("ROLLBACK");

      console.log(`A01_CORRECTIVE_TARGETED_PASS total=${passCount}`);
      console.log(
        "A01 corrective test transaction rolled back; no corrective fixtures persisted."
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.end().catch(() => undefined);
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
