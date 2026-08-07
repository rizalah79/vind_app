import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client, DatabaseError } from "pg";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");
const seedPath = path.join(
  packageRoot,
  "prisma",
  "seeds",
  "smk-slice-1",
  "seed.sql"
);

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
      `A01 tests require localhost. Received: ${parsed.hostname}`
    );
  }

  if (parsed.port !== "5432") {
    throw new Error(
      `A01 tests require host port 5432. Received: ${parsed.port}`
    );
  }

  if (parsed.pathname !== "/vind_app_dev") {
    throw new Error(
      `A01 tests require database vind_app_dev. Received: ${parsed.pathname}`
    );
  }
}

validateLocalTestUrl(adminUrl);

let passCount = 0;

function pass(label: string): void {
  passCount += 1;
  console.log(`PASS ${String(passCount).padStart(2, "0")} ${label}`);
}

function assert(
  condition: unknown,
  label: string
): asserts condition {
  if (!condition) {
    throw new Error(`FAIL ${label}`);
  }

  pass(label);
}

async function queryCount(
  client: Client,
  sql: string,
  values: unknown[] = []
): Promise<number> {
  const result = await client.query<{ count: string }>(sql, values);
  const value = Number(result.rows[0]?.count);

  if (!Number.isInteger(value)) {
    throw new Error(`Invalid count result for: ${sql}`);
  }

  return value;
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
  values: {
    personKey?: string;
    organizationKey?: string;
    workspaceKey?: string;
    membershipKey?: string;
    assignmentKey?: string;
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
      values.personKey ? `a01:account:${values.personKey}` : null,
      values.personKey ?? null,
      values.membershipKey ?? null,
      values.assignmentKey ?? null,
      values.organizationKey ?? null,
      values.workspaceKey ?? null,
      "VINDZAM",
      "db-dec-021-a01-correlation",
      "db-dec-021-a01-request",
      values.purposeCode
    ]
  );
}

async function expectDbError(
  client: Client,
  expectedCode: string,
  label: string,
  operation: () => Promise<void>
): Promise<void> {
  const savepoint = `sp_${passCount + 1}`;

  await client.query(`SAVEPOINT ${savepoint}`);

  try {
    await operation();
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    throw new Error(
      `FAIL ${label}: expected SQLSTATE ${expectedCode}, statement succeeded`
    );
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      .catch(() => undefined);

    if (error instanceof Error && error.message.startsWith("FAIL ")) {
      throw error;
    }

    const code =
      error instanceof DatabaseError
        ? error.code
        : typeof error === "object" &&
            error !== null &&
            "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;

    if (code !== expectedCode) {
      throw new Error(
        `FAIL ${label}: expected SQLSTATE ${expectedCode}, received ${code ?? "unknown"}`
      );
    }

    pass(label);
  } finally {
    await client.query(`RELEASE SAVEPOINT ${savepoint}`)
      .catch(() => undefined);
  }
}

async function capability(
  client: Client,
  capabilityCode: string,
  scopeType: "PERSON" | "ORGANIZATION" | "WORKSPACE",
  personId: string | null,
  organizationId: string | null,
  workspaceId: string | null
): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `
      SELECT access.current_actor_has_capability_for_scope(
        $1, $2, $3::uuid, $4::uuid, $5::uuid
      ) AS allowed
    `,
    [
      capabilityCode,
      scopeType,
      personId,
      organizationId,
      workspaceId
    ]
  );

  return result.rows[0]?.allowed === true;
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

async function main(): Promise<void> {
  const client = new Client({
    connectionString: adminUrl,
    application_name: "vind-db-dec-021-a01-test"
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

    const migrationCount = await queryCount(client, `
      SELECT count(*)::text AS count
      FROM public.vind_schema_migrations
      WHERE migration_name =
        '20260807223700_access_person_scope_db_dec_021_a01'
    `);

    assert(
      migrationCount === 1,
      "A01 migration ledger entry exists exactly once"
    );

    const seedSql = await readFile(seedPath, "utf8");

    await client.query("BEGIN");
    await client.query("SET LOCAL timezone TO 'UTC'");

    try {
      // ---------------------------------------------------
      // SMK Slice 1 reconciliation in this rollback-only test
      // ---------------------------------------------------
      await setRole(client, "vind_importer");
      await client.query(seedSql);
      await client.query(seedSql);

      const expectedCounts: Array<[string, string, number]> = [
        ["organizations", "organization.organizations", 2],
        ["workspaces", "organization.workspaces", 2],
        ["locations", "geo.locations", 2],
        ["persons", "party.persons", 4],
        ["contact points", "party.contact_points", 6],
        ["consumer profiles", "party.consumer_profiles", 1],
        ["accounts", "identity.accounts", 4],
        ["identity links", "identity.identity_links", 4],
        ["memberships", "access.memberships", 3],
        ["scoped assignments", "access.scoped_assignments", 3],
        ["PIC assignments", "access.pic_assignments", 3]
      ];

      for (const [label, table, expected] of expectedCounts) {
        const count = await queryCount(
          client,
          `
            SELECT count(*)::text AS count
            FROM ${table}
            WHERE seed_key LIKE 'smk:s1:%'
          `
        );

        assert(
          count === expected,
          `SMK replay reconciliation ${label}=${expected}`
        );
      }

      // ---------------------------------------------------
      // A01 PERSON fixtures
      // ---------------------------------------------------
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
          (
            'smk:a01:person:independent',
            'Independent A01',
            'Independent A01',
            'Independent A01',
            'ACTIVE',
            'id-ID',
            'Asia/Jakarta',
            true,
            false
          ),
          (
            'smk:a01:person:outsider',
            'Outsider A01',
            'Outsider A01',
            'Outsider A01',
            'ACTIVE',
            'id-ID',
            'Asia/Jakarta',
            true,
            false
          ),
          (
            'smk:a01:person:admin',
            'Admin A01',
            'Admin A01',
            'Admin A01',
            'ACTIVE',
            'id-ID',
            'Asia/Jakarta',
            true,
            false
          ),
          (
            'smk:a01:person:content',
            'Content A01',
            'Content A01',
            'Content A01',
            'ACTIVE',
            'id-ID',
            'Asia/Jakarta',
            true,
            false
          ),
          (
            'smk:a01:person:operations',
            'Operations A01',
            'Operations A01',
            'Operations A01',
            'ACTIVE',
            'id-ID',
            'Asia/Jakarta',
            true,
            false
          ),
          (
            'smk:a01:person:expired',
            'Expired A01',
            'Expired A01',
            'Expired A01',
            'ACTIVE',
            'id-ID',
            'Asia/Jakarta',
            true,
            false
          ),
          (
            'smk:a01:person:period',
            'Period A01',
            'Period A01',
            'Period A01',
            'ACTIVE',
            'id-ID',
            'Asia/Jakarta',
            true,
            false
          ),
          (
            'smk:a01:person:expired_membership',
            'Expired Membership A01',
            'Expired Membership A01',
            'Expired Membership A01',
            'ACTIVE',
            'id-ID',
            'Asia/Jakarta',
            true,
            false
          )
      `);

      const independentId = await idBySeed(
        client,
        "party.persons",
        "smk:a01:person:independent"
      );
      const outsiderId = await idBySeed(
        client,
        "party.persons",
        "smk:a01:person:outsider"
      );
      const adminId = await idBySeed(
        client,
        "party.persons",
        "smk:a01:person:admin"
      );
      const contentId = await idBySeed(
        client,
        "party.persons",
        "smk:a01:person:content"
      );
      const operationsId = await idBySeed(
        client,
        "party.persons",
        "smk:a01:person:operations"
      );
      const expiredId = await idBySeed(
        client,
        "party.persons",
        "smk:a01:person:expired"
      );
      const periodId = await idBySeed(
        client,
        "party.persons",
        "smk:a01:person:period"
      );
      const expiredMembershipPersonId = await idBySeed(
        client,
        "party.persons",
        "smk:a01:person:expired_membership"
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
            (
              'smk:a01:assignment:independent_owner',
              NULL,
              'OWNER',
              'PERSON',
              $1::uuid,
              NULL,
              NULL,
              'ACTIVE',
              statement_timestamp() - interval '1 day',
              NULL,
              'A01_TEST'
            ),
            (
              'smk:a01:assignment:outsider_owner',
              NULL,
              'OWNER',
              'PERSON',
              $2::uuid,
              NULL,
              NULL,
              'ACTIVE',
              statement_timestamp() - interval '1 day',
              NULL,
              'A01_TEST'
            ),
            (
              'smk:a01:assignment:admin',
              NULL,
              'ADMIN',
              'PERSON',
              $3::uuid,
              NULL,
              NULL,
              'ACTIVE',
              statement_timestamp() - interval '1 day',
              NULL,
              'A01_TEST'
            ),
            (
              'smk:a01:assignment:content',
              NULL,
              'CONTENT_MANAGER',
              'PERSON',
              $4::uuid,
              NULL,
              NULL,
              'ACTIVE',
              statement_timestamp() - interval '1 day',
              NULL,
              'A01_TEST'
            ),
            (
              'smk:a01:assignment:operations',
              NULL,
              'OPERATIONS_STAFF',
              'PERSON',
              $5::uuid,
              NULL,
              NULL,
              'ACTIVE',
              statement_timestamp() - interval '1 day',
              NULL,
              'A01_TEST'
            ),
            (
              'smk:a01:assignment:expired',
              NULL,
              'OWNER',
              'PERSON',
              $6::uuid,
              NULL,
              NULL,
              'ACTIVE',
              statement_timestamp() - interval '3 day',
              statement_timestamp() - interval '1 day',
              'A01_TEST'
            )
        `,
        [
          independentId,
          outsiderId,
          adminId,
          contentId,
          operationsId,
          expiredId
        ]
      );

      assert(
        await queryCount(
          client,
          `
            SELECT count(*)::text AS count
            FROM access.scoped_assignments
            WHERE seed_key = 'smk:a01:assignment:independent_owner'
              AND scope_type = 'PERSON'
              AND person_id = $1::uuid
              AND membership_id IS NULL
              AND organization_id IS NULL
              AND workspace_id IS NULL
          `,
          [independentId]
        ) === 1,
        "valid independent PERSON assignment"
      );

      const alphaMembershipId = await idBySeed(
        client,
        "access.memberships",
        "smk:s1:membership:owner_alpha"
      );
      const alphaOrgId = await idBySeed(
        client,
        "organization.organizations",
        "smk:s1:org:alpha"
      );
      const betaOrgId = await idBySeed(
        client,
        "organization.organizations",
        "smk:s1:org:beta"
      );
      const alphaWorkspaceId = await idBySeed(
        client,
        "organization.workspaces",
        "smk:s1:workspace:alpha"
      );

      await client.query(
        `
          INSERT INTO access.memberships (
            seed_key,
            person_id,
            organization_id,
            workspace_id,
            status,
            effective_from,
            effective_to,
            accepted_at
          )
          VALUES (
            'smk:a01:membership:expired',
            $1::uuid,
            $2::uuid,
            NULL,
            'ACTIVE',
            statement_timestamp() - interval '3 day',
            statement_timestamp() - interval '1 day',
            statement_timestamp() - interval '3 day'
          )
        `,
        [expiredMembershipPersonId, alphaOrgId]
      );

      const expiredMembershipId = await idBySeed(
        client,
        "access.memberships",
        "smk:a01:membership:expired"
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
          VALUES (
            'smk:a01:assignment:expired_membership_owner',
            $1::uuid,
            'OWNER',
            'ORGANIZATION',
            NULL,
            $2::uuid,
            NULL,
            'ACTIVE',
            statement_timestamp() - interval '3 day',
            NULL,
            'A01_TEST'
          )
        `,
        [expiredMembershipId, alphaOrgId]
      );

      await expectDbError(
        client,
        "23514",
        "PERSON rejects membership_id",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id, status
              )
              VALUES (
                'smk:a01:invalid:person_membership',
                $1::uuid,
                'OWNER',
                'PERSON',
                $2::uuid,
                NULL,
                NULL,
                'ACTIVE'
              )
            `,
            [alphaMembershipId, periodId]
          );
        }
      );

      await expectDbError(
        client,
        "23514",
        "PERSON rejects organization_id",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id, status
              )
              VALUES (
                'smk:a01:invalid:person_org',
                NULL,
                'OWNER',
                'PERSON',
                $1::uuid,
                $2::uuid,
                NULL,
                'ACTIVE'
              )
            `,
            [periodId, alphaOrgId]
          );
        }
      );

      await expectDbError(
        client,
        "23514",
        "ORGANIZATION rejects missing membership_id",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id, status
              )
              VALUES (
                'smk:a01:invalid:org_no_membership',
                NULL,
                'OWNER',
                'ORGANIZATION',
                NULL,
                $1::uuid,
                NULL,
                'ACTIVE'
              )
            `,
            [alphaOrgId]
          );
        }
      );

      await expectDbError(
        client,
        "23514",
        "WORKSPACE rejects missing workspace_id",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id, status
              )
              VALUES (
                'smk:a01:invalid:workspace_missing',
                $1::uuid,
                'OWNER',
                'WORKSPACE',
                NULL,
                $2::uuid,
                NULL,
                'ACTIVE'
              )
            `,
            [alphaMembershipId, alphaOrgId]
          );
        }
      );

      await expectDbError(
        client,
        "23514",
        "ORGANIZATION rejects person_id",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id, status
              )
              VALUES (
                'smk:a01:invalid:org_person',
                $1::uuid,
                'OWNER',
                'ORGANIZATION',
                $2::uuid,
                $3::uuid,
                NULL,
                'ACTIVE'
              )
            `,
            [alphaMembershipId, periodId, alphaOrgId]
          );
        }
      );

      await expectDbError(
        client,
        "23514",
        "validator preserves membership/organization consistency",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id, status
              )
              VALUES (
                'smk:a01:invalid:membership_org',
                $1::uuid,
                'OWNER',
                'ORGANIZATION',
                NULL,
                $2::uuid,
                NULL,
                'ACTIVE'
              )
            `,
            [alphaMembershipId, betaOrgId]
          );
        }
      );

      await expectDbError(
        client,
        "23514",
        "validator preserves workspace organization consistency",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id, status
              )
              VALUES (
                'smk:a01:invalid:workspace_org',
                $1::uuid,
                'OWNER',
                'WORKSPACE',
                NULL,
                $2::uuid,
                $3::uuid,
                'ACTIVE'
              )
            `,
            [alphaMembershipId, betaOrgId, alphaWorkspaceId]
          );
        }
      );

      await expectDbError(
        client,
        "23P01",
        "PERSON active-period overlap rejected",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id,
                status, effective_from, effective_to
              )
              VALUES (
                'smk:a01:invalid:person_overlap',
                NULL,
                'OWNER',
                'PERSON',
                $1::uuid,
                NULL,
                NULL,
                'ACTIVE',
                statement_timestamp() - interval '2 hour',
                statement_timestamp() + interval '2 hour'
              )
            `,
            [independentId]
          );
        }
      );

      await client.query(
        `
          INSERT INTO access.scoped_assignments (
            seed_key, membership_id, role_code, scope_type,
            person_id, organization_id, workspace_id,
            status, effective_from, effective_to
          )
          VALUES
            (
              'smk:a01:period:one',
              NULL,
              'OWNER',
              'PERSON',
              $1::uuid,
              NULL,
              NULL,
              'ACTIVE',
              statement_timestamp() - interval '4 day',
              statement_timestamp() - interval '3 day'
            ),
            (
              'smk:a01:period:two',
              NULL,
              'OWNER',
              'PERSON',
              $1::uuid,
              NULL,
              NULL,
              'ACTIVE',
              statement_timestamp() - interval '3 day',
              statement_timestamp() - interval '2 day'
            )
        `,
        [periodId]
      );

      assert(
        await queryCount(
          client,
          `
            SELECT count(*)::text AS count
            FROM access.scoped_assignments
            WHERE seed_key IN (
              'smk:a01:period:one',
              'smk:a01:period:two'
            )
          `
        ) === 2,
        "adjacent non-overlapping PERSON periods allowed"
      );

      // ---------------------------------------------------
      // RLS: no context and PERSON self-scope
      // ---------------------------------------------------
      await setRole(client, "vind_app_runtime");
      await setContext(client, {
        purposeCode: "A01_NO_CONTEXT"
      });

      assert(
        await queryCount(
          client,
          `
            SELECT count(*)::text AS count
            FROM access.scoped_assignments
            WHERE seed_key LIKE 'smk:a01:assignment:%'
          `
        ) === 0,
        "RLS no-context hides PERSON assignments"
      );

      await setContext(client, {
        personKey: "smk:a01:person:independent",
        purposeCode: "A01_PERSON_SELF"
      });

      assert(
        await queryCount(
          client,
          `
            SELECT count(*)::text AS count
            FROM access.scoped_assignments
            WHERE seed_key LIKE 'smk:a01:assignment:%'
          `
        ) === 1,
        "RLS PERSON self-scope reads only own assignment"
      );

      assert(
        await queryCount(
          client,
          `
            SELECT count(*)::text AS count
            FROM access.scoped_assignments
            WHERE seed_key = 'smk:a01:assignment:outsider_owner'
          `
        ) === 0,
        "RLS PERSON cross-person read denied"
      );

      await expectDbError(
        client,
        "42501",
        "runtime cannot self-grant a PERSON assignment",
        async () => {
          await client.query(
            `
              INSERT INTO access.scoped_assignments (
                seed_key, membership_id, role_code, scope_type,
                person_id, organization_id, workspace_id, status
              )
              VALUES (
                'smk:a01:runtime:self_grant',
                NULL,
                'OWNER',
                'PERSON',
                $1::uuid,
                NULL,
                NULL,
                'ACTIVE'
              )
            `,
            [independentId]
          );
        }
      );

      const updateResult = await client.query(`
        UPDATE access.scoped_assignments
        SET reason_code = 'ILLEGAL_SELF_UPDATE'
        WHERE seed_key = 'smk:a01:assignment:independent_owner'
      `);

      assert(
        updateResult.rowCount === 0,
        "runtime cannot directly update own PERSON assignment"
      );

      // ---------------------------------------------------
      // PERSON capability authorization
      // ---------------------------------------------------
      assert(
        await capability(
          client,
          "provider.status.transition",
          "PERSON",
          independentId,
          null,
          null
        ),
        "PERSON OWNER has provider.status.transition"
      );

      assert(
        await capability(
          client,
          "provider.management_authority.manage",
          "PERSON",
          independentId,
          null,
          null
        ),
        "PERSON OWNER has provider.management_authority.manage"
      );

      assert(
        await capability(
          client,
          "listing.publication.transition",
          "PERSON",
          independentId,
          null,
          null
        ),
        "PERSON OWNER has listing.publication.transition"
      );

      assert(
        !await capability(
          client,
          "verification.evidence.read",
          "PERSON",
          independentId,
          null,
          null
        ),
        "PERSON OWNER does not have verification.evidence.read"
      );

      await setContext(client, {
        personKey: "smk:a01:person:admin",
        purposeCode: "A01_PERSON_ADMIN"
      });

      assert(
        await capability(
          client,
          "provider.status.transition",
          "PERSON",
          adminId,
          null,
          null
        ),
        "PERSON ADMIN has provider.status.transition"
      );

      assert(
        !await capability(
          client,
          "provider.management_authority.manage",
          "PERSON",
          adminId,
          null,
          null
        ),
        "PERSON ADMIN lacks provider.management_authority.manage"
      );

      assert(
        await capability(
          client,
          "listing.publication.transition",
          "PERSON",
          adminId,
          null,
          null
        ),
        "PERSON ADMIN has listing.publication.transition"
      );

      assert(
        !await capability(
          client,
          "verification.evidence.read",
          "PERSON",
          adminId,
          null,
          null
        ),
        "PERSON ADMIN does not have verification.evidence.read"
      );

      await setContext(client, {
        personKey: "smk:a01:person:content",
        purposeCode: "A01_PERSON_CONTENT"
      });

      assert(
        await capability(
          client,
          "listing.publication.transition",
          "PERSON",
          contentId,
          null,
          null
        ),
        "PERSON CONTENT_MANAGER has listing.publication.transition"
      );

      assert(
        !await capability(
          client,
          "provider.status.transition",
          "PERSON",
          contentId,
          null,
          null
        ),
        "PERSON CONTENT_MANAGER lacks provider.status.transition"
      );

      await setContext(client, {
        personKey: "smk:a01:person:operations",
        purposeCode: "A01_PERSON_OPERATIONS"
      });

      assert(
        !await capability(
          client,
          "listing.publication.transition",
          "PERSON",
          operationsId,
          null,
          null
        ),
        "PERSON OPERATIONS_STAFF lacks locked publication capability"
      );

      await setContext(client, {
        personKey: "smk:a01:person:expired",
        purposeCode: "A01_PERSON_EXPIRED"
      });

      assert(
        !await capability(
          client,
          "provider.status.transition",
          "PERSON",
          expiredId,
          null,
          null
        ),
        "expired PERSON assignment is not authorization-effective"
      );

      await setContext(client, {
        personKey: "smk:a01:person:outsider",
        purposeCode: "A01_PERSON_OUTSIDER"
      });

      assert(
        !await capability(
          client,
          "provider.status.transition",
          "PERSON",
          independentId,
          null,
          null
        ),
        "PERSON capability cannot authorize another person boundary"
      );

      // ---------------------------------------------------
      // ORGANIZATION / WORKSPACE regression
      // ---------------------------------------------------
      await setContext(client, {
        personKey: "smk:s1:person:owner_alpha",
        membershipKey: "smk:s1:membership:owner_alpha",
        assignmentKey: "smk:s1:assignment:owner_alpha",
        organizationKey: "smk:s1:org:alpha",
        workspaceKey: "smk:s1:workspace:alpha",
        purposeCode: "A01_ORG_ALPHA"
      });

      assert(
        await queryCount(
          client,
          `
            SELECT count(*)::text AS count
            FROM access.scoped_assignments
            WHERE seed_key LIKE 'smk:s1:%'
          `
        ) === 2,
        "ORGANIZATION RLS regression: Alpha sees 2 Slice 1 assignments"
      );

      assert(
        await capability(
          client,
          "provider.status.transition",
          "ORGANIZATION",
          null,
          alphaOrgId,
          null
        ),
        "ORGANIZATION OWNER authorization remains effective"
      );

      const sameOrgUpdate = await client.query(`
        UPDATE access.scoped_assignments
        SET reason_code = 'A01_SAME_ORG_ALLOWED'
        WHERE seed_key = 'smk:s1:assignment:owner_alpha'
      `);

      assert(
        sameOrgUpdate.rowCount === 1,
        "ORGANIZATION same-tenant assignment update remains allowed"
      );

      const crossOrgUpdate = await client.query(`
        UPDATE access.scoped_assignments
        SET reason_code = 'A01_ILLEGAL_CROSS_ORG'
        WHERE seed_key = 'smk:s1:assignment:owner_beta'
      `);

      assert(
        crossOrgUpdate.rowCount === 0,
        "ORGANIZATION cross-tenant assignment update remains denied"
      );

      await setContext(client, {
        personKey: "smk:a01:person:expired_membership",
        organizationKey: "smk:s1:org:alpha",
        purposeCode: "A01_EXPIRED_MEMBERSHIP"
      });

      assert(
        !await capability(
          client,
          "provider.status.transition",
          "ORGANIZATION",
          null,
          alphaOrgId,
          null
        ),
        "expired organization membership is not authorization-effective"
      );

      await setContext(client, {
        personKey: "smk:s1:person:owner_beta",
        membershipKey: "smk:s1:membership:owner_beta",
        assignmentKey: "smk:s1:assignment:owner_beta",
        organizationKey: "smk:s1:org:beta",
        workspaceKey: "smk:s1:workspace:beta",
        purposeCode: "A01_ORG_BETA"
      });

      assert(
        await queryCount(
          client,
          `
            SELECT count(*)::text AS count
            FROM access.scoped_assignments
            WHERE seed_key LIKE 'smk:s1:%'
          `
        ) === 1,
        "ORGANIZATION RLS regression: Beta sees 1 Slice 1 assignment"
      );

      await setContext(client, {
        personKey: "smk:s1:person:operations_alpha",
        membershipKey: "smk:s1:membership:operations_alpha",
        assignmentKey: "smk:s1:assignment:operations_alpha",
        organizationKey: "smk:s1:org:alpha",
        workspaceKey: "smk:s1:workspace:alpha",
        purposeCode: "A01_WORKSPACE_ALPHA"
      });

      assert(
        !await capability(
          client,
          "listing.publication.transition",
          "WORKSPACE",
          null,
          alphaOrgId,
          alphaWorkspaceId
        ),
        "WORKSPACE OPERATIONS_STAFF does not gain locked publication capability"
      );

      // Invalid target shape must fail closed.
      assert(
        !await capability(
          client,
          "provider.status.transition",
          "PERSON",
          independentId,
          alphaOrgId,
          null
        ),
        "capability resolver fails closed on invalid target XOR"
      );

      await client.query("ROLLBACK");

      console.log(`A01_TEST_SUITE_PASS total=${passCount}`);
      console.log("A01 test transaction rolled back; no test fixtures persisted.");
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
