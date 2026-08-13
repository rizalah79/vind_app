import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");

dotenv.config({ path: path.join(packageRoot, ".env") });

const adminUrl = process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;

if (!adminUrl || !runtimeUrl) {
  throw new Error(
    "DATABASE_MIGRATION_URL and DATABASE_URL are required."
  );
}

function assertLocal(urlText: string, label: string): void {
  const url = new URL(urlText);
  const effectivePort = url.port || "5432";
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    effectivePort !== "5432" ||
    (!url.pathname.startsWith("/vind_app_dev") && !url.pathname.startsWith("/vind_app_accept_"))
  ) {
    throw new Error(
      `${label} must target local database`
    );
  }
}

assertLocal(adminUrl, "DATABASE_MIGRATION_URL");
assertLocal(runtimeUrl, "DATABASE_URL");

let passed = 0;

function pass(label: string): void {
  passed += 1;
  console.log(`PASS ${label}`);
}

function fail(label: string, detail?: unknown): never {
  throw new Error(
    `FAIL ${label}${detail === undefined ? "" : `: ${String(detail)}`}`
  );
}

function assertTrue(value: unknown, label: string): void {
  if (value !== true) fail(label, value);
  pass(label);
}

function assertFalse(value: unknown, label: string): void {
  if (value !== false) fail(label, value);
  pass(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(label, `expected ${String(expected)}, got ${String(actual)}`);
  }
  pass(label);
}

async function scalar<T>(
  client: Client,
  sql: string,
  params: unknown[] = []
): Promise<T> {
  const result = await client.query(sql, params);
  const row = result.rows[0] as Record<string, T> | undefined;
  if (!row) throw new Error(`No row for scalar query: ${sql}`);
  const key = Object.keys(row)[0];
  if (key === undefined) throw new Error(`No column returned for scalar query: ${sql}`);
  return row[key] as T;
}

async function expectPgError(
  operation: () => Promise<unknown>,
  allowedCodes: string[],
  label: string
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";

    if (!allowedCodes.includes(code)) {
      fail(label, `unexpected PostgreSQL code ${code || "unknown"}`);
    }

    pass(`${label} (${code})`);
    return;
  }

  fail(label, "operation unexpectedly succeeded");
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

async function setContext(
  client: Client,
  input: ContextInput
): Promise<void> {
  await client.query(
    `
      SELECT security.set_request_context_v2(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19
      )
    `,
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
      "s1-test-correlation",
      input.requestId ?? "s1-test-request",
      input.assurance ?? "BASIC",
      input.stepUp ?? false,
      input.breakGlassReference ?? null
    ]
  );
}

async function begin(client: Client): Promise<void> {
  await client.query("BEGIN");
  await client.query("SET LOCAL timezone TO 'UTC'");
}

async function rollback(client: Client): Promise<void> {
  await client.query("ROLLBACK");
}

async function setupFixtures(admin: Client): Promise<void> {
  await admin.query("SET ROLE vind_db_owner");
  await admin.query("SET timezone TO 'UTC'");

  await admin.query(`
    DELETE FROM security.data_access_logs
    WHERE request_id = 's1-data-access-request'
  `);

  await admin.query(`
    INSERT INTO geo.regions (
      seed_key,
      region_type,
      country_code,
      code,
      display_name,
      status
    )
    VALUES (
      's1:test:region:jakarta',
      'CITY',
      'ID',
      'S1TEST-JKT',
      'S1 Test Jakarta',
      'ACTIVE'
    )
    ON CONFLICT (seed_key) DO NOTHING
  `);

  const people = [
    ["moderator", "S1 Moderator"],
    ["ops_admin", "S1 Operations Admin"],
    ["support", "S1 Support"],
    ["finance_maker", "S1 Finance Maker"],
    ["finance_checker", "S1 Finance Checker"],
    ["security_auditor", "S1 Security Auditor"],
    ["super_admin", "S1 Super Admin"],
    ["approver", "S1 Break Glass Approver"],
    ["expired_moderator", "S1 Expired Moderator"]
  ] as const;

  for (const [key, name] of people) {
    await admin.query(
      `
        INSERT INTO party.persons (
          seed_key,
          display_name,
          preferred_name,
          legal_name,
          status,
          locale_code,
          timezone_name,
          is_synthetic,
          contactable,
          data_origin_code,
          source_reference
        )
        VALUES (
          $1,
          $2,
          $2,
          $2,
          'ACTIVE',
          'id-ID',
          'Asia/Jakarta',
          true,
          false,
          'SECURITY_NEGATIVE',
          's1:test-harness'
        )
        ON CONFLICT (seed_key) DO NOTHING
      `,
      [`s1:test:person:${key}`, name]
    );

    await admin.query(
      `
        INSERT INTO identity.accounts (
          seed_key,
          account_type,
          status,
          data_origin_code,
          source_reference
        )
        VALUES (
          $1,
          'HUMAN',
          'ACTIVE',
          'SECURITY_NEGATIVE',
          's1:test-harness'
        )
        ON CONFLICT (seed_key) DO NOTHING
      `,
      [`s1:test:account:${key}`]
    );

    await admin.query(
      `
        INSERT INTO identity.identity_links (
          seed_key,
          account_id,
          person_id,
          issuer,
          subject,
          assurance_level,
          status,
          is_primary
        )
        SELECT
          $1,
          a.id,
          p.id,
          'https://identity.s1-test.invalid',
          $2,
          'STRONG',
          'ACTIVE',
          true
        FROM identity.accounts a
        JOIN party.persons p ON p.seed_key = $3
        WHERE a.seed_key = $4
        ON CONFLICT (seed_key) DO NOTHING
      `,
      [
        `s1:test:identity_link:${key}`,
        key,
        `s1:test:person:${key}`,
        `s1:test:account:${key}`
      ]
    );
  }

  const platformRows = [
    ["moderator", "MODERATOR", "ROUTINE", null, null],
    ["ops_admin", "OPERATIONS_ADMIN", "ROUTINE", null, null],
    ["support", "SUPPORT_AGENT", "ROUTINE", null, null],
    ["finance_maker", "FINANCE_MAKER", "ROUTINE", null, null],
    ["finance_checker", "FINANCE_CHECKER", "ROUTINE", null, null],
    ["security_auditor", "SECURITY_AUDITOR", "ROUTINE", null, null]
  ] as const;

  for (const [key, role, mode] of platformRows) {
    await admin.query(
      `
        INSERT INTO access.platform_assignments (
          assignment_key,
          subject_person_id,
          role_code,
          assignment_mode,
          status,
          effective_from,
          reason_code
        )
        SELECT
          $1,
          p.id,
          $2,
          $3,
          'ACTIVE',
          clock_timestamp() - interval '1 hour',
          'S1_TEST'
        FROM party.persons p
        WHERE p.seed_key = $4
        ON CONFLICT (assignment_key) DO NOTHING
      `,
      [
        `s1:test:platform_assignment:${key}`,
        role,
        mode,
        `s1:test:person:${key}`
      ]
    );
  }

  await admin.query(`
    INSERT INTO access.platform_assignments (
      assignment_key,
      subject_person_id,
      role_code,
      assignment_mode,
      status,
      channel_id,
      region_id,
      effective_from,
      effective_to,
      reason_code,
      approved_by_person_id,
      approval_reference
    )
    SELECT
      's1:test:platform_assignment:super_admin',
      subject.id,
      'SUPER_ADMIN',
      'BREAK_GLASS',
      'ACTIVE',
      ch.id,
      r.id,
      clock_timestamp() - interval '5 minutes',
      clock_timestamp() + interval '1 hour',
      'S1_BREAK_GLASS_TEST',
      approver.id,
      'S1-BG-REF-001'
    FROM party.persons subject
    JOIN party.persons approver
      ON approver.seed_key = 's1:test:person:approver'
    JOIN listing.channels ch
      ON ch.code = 'VINDZAM'
    JOIN geo.regions r
      ON r.seed_key = 's1:test:region:jakarta'
    WHERE subject.seed_key = 's1:test:person:super_admin'
    ON CONFLICT (assignment_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO access.platform_assignments (
      assignment_key,
      subject_person_id,
      role_code,
      assignment_mode,
      status,
      effective_from,
      effective_to,
      reason_code
    )
    SELECT
      's1:test:platform_assignment:expired_moderator',
      p.id,
      'MODERATOR',
      'ROUTINE',
      'ACTIVE',
      clock_timestamp() - interval '2 hours',
      clock_timestamp() - interval '1 hour',
      'S1_EXPIRED_TEST'
    FROM party.persons p
    WHERE p.seed_key = 's1:test:person:expired_moderator'
    ON CONFLICT (assignment_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO identity.accounts (
      seed_key,
      account_type,
      status,
      data_origin_code,
      source_reference
    )
    VALUES (
      's1:test:account:service',
      'SERVICE',
      'ACTIVE',
      'SECURITY_NEGATIVE',
      's1:test-harness'
    )
    ON CONFLICT (seed_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO access.service_principal_grants (
      grant_key,
      subject_account_id,
      capability_code,
      status,
      purpose_code,
      channel_id,
      region_id,
      effective_from,
      reason_code
    )
    SELECT
      's1:test:service_grant:publication',
      a.id,
      'listing.publication.transition',
      'ACTIVE',
      'S1_SERVICE_TEST',
      ch.id,
      r.id,
      clock_timestamp() - interval '1 hour',
      'S1_TEST'
    FROM identity.accounts a
    JOIN listing.channels ch ON ch.code = 'VINDZAM'
    JOIN geo.regions r ON r.seed_key = 's1:test:region:jakarta'
    WHERE a.seed_key = 's1:test:account:service'
    ON CONFLICT (grant_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO access.scoped_assignments (
      seed_key,
      subject_person_id,
      membership_id,
      role_code,
      scope_type,
      scope_person_id,
      organization_id,
      workspace_id,
      status,
      effective_from,
      reason_code
    )
    SELECT
      's1:test:assignment:person_owner_alpha',
      p.id,
      NULL,
      'OWNER',
      'PERSON',
      p.id,
      NULL,
      NULL,
      'ACTIVE',
      clock_timestamp() - interval '1 hour',
      'S1_TEST'
    FROM party.persons p
    WHERE p.seed_key = 'smk:s1:person:owner_alpha'
    ON CONFLICT (seed_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO access.scoped_assignments (
      seed_key,
      subject_person_id,
      membership_id,
      role_code,
      scope_type,
      scope_person_id,
      organization_id,
      workspace_id,
      status,
      effective_from,
      reason_code
    )
    SELECT
      's1:test:assignment:content_workspace_alpha',
      p.id,
      m.id,
      'CONTENT_MANAGER',
      'WORKSPACE',
      NULL,
      o.id,
      w.id,
      'ACTIVE',
      clock_timestamp() - interval '1 hour',
      'S1_TEST'
    FROM party.persons p
    JOIN access.memberships m
      ON m.seed_key = 'smk:s1:membership:operations_alpha'
    JOIN organization.organizations o
      ON o.seed_key = 'smk:s1:org:alpha'
    JOIN organization.workspaces w
      ON w.seed_key = 'smk:s1:workspace:alpha'
    WHERE p.seed_key = 'smk:s1:person:operations_alpha'
    ON CONFLICT (seed_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO privacy.consent_receipts (
      receipt_key,
      person_id,
      purpose_code,
      policy_version,
      consent_action,
      channel_id,
      grant_effective_from,
      source_reference
    )
    SELECT
      's1:test:consent:alpha',
      p.id,
      'MARKETING',
      'v1',
      'GRANTED',
      ch.id,
      clock_timestamp() - interval '1 minute',
      's1:test-harness'
    FROM party.persons p
    JOIN listing.channels ch ON ch.code = 'VINDZAM'
    WHERE p.seed_key = 'smk:s1:person:owner_alpha'
    ON CONFLICT (receipt_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO privacy.consent_receipts (
      receipt_key,
      person_id,
      purpose_code,
      policy_version,
      consent_action,
      channel_id,
      grant_effective_from,
      source_reference
    )
    SELECT
      's1:test:consent:beta',
      p.id,
      'MARKETING',
      'v1',
      'GRANTED',
      ch.id,
      clock_timestamp() - interval '1 minute',
      's1:test-harness'
    FROM party.persons p
    JOIN listing.channels ch ON ch.code = 'VINDLOKA'
    WHERE p.seed_key = 'smk:s1:person:owner_beta'
    ON CONFLICT (receipt_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO privacy.subject_requests (
      request_key,
      person_id,
      request_type,
      status,
      request_details
    )
    SELECT
      's1:test:subject_request:alpha',
      p.id,
      'ACCESS',
      'SUBMITTED',
      '{"source":"s1-test"}'::jsonb
    FROM party.persons p
    WHERE p.seed_key = 'smk:s1:person:owner_alpha'
    ON CONFLICT (request_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO privacy.subject_requests (
      request_key,
      person_id,
      request_type,
      status,
      request_details
    )
    SELECT
      's1:test:subject_request:beta',
      p.id,
      'ACCESS',
      'SUBMITTED',
      '{"source":"s1-test"}'::jsonb
    FROM party.persons p
    WHERE p.seed_key = 'smk:s1:person:owner_beta'
    ON CONFLICT (request_key) DO NOTHING
  `);

  await admin.query(`
    INSERT INTO configuration.settings (
      setting_key,
      scope_type,
      channel_id,
      region_id,
      version,
      value_type,
      value_json,
      status,
      effective_from
    )
    VALUES (
      's1.test.threshold',
      'GLOBAL',
      NULL,
      NULL,
      1,
      'INTEGER',
      '1'::jsonb,
      'ACTIVE',
      clock_timestamp() - interval '1 hour'
    )
    ON CONFLICT DO NOTHING
  `);

  await admin.query(`
    INSERT INTO configuration.settings (
      setting_key,
      scope_type,
      channel_id,
      region_id,
      version,
      value_type,
      value_json,
      status,
      effective_from
    )
    SELECT
      's1.test.threshold',
      'CHANNEL',
      ch.id,
      NULL,
      1,
      'INTEGER',
      '2'::jsonb,
      'ACTIVE',
      clock_timestamp() - interval '1 hour'
    FROM listing.channels ch
    WHERE ch.code = 'VINDZAM'
    ON CONFLICT DO NOTHING
  `);
}

async function runTests(admin: Client, runtime: Client): Promise<void> {
  const ownerAlphaPersonId = await scalar<string>(
    admin,
    `SELECT id::text FROM party.persons
     WHERE seed_key = 'smk:s1:person:owner_alpha'`
  );
  const alphaOrgId = await scalar<string>(
    admin,
    `SELECT id::text FROM organization.organizations
     WHERE seed_key = 'smk:s1:org:alpha'`
  );
  const betaOrgId = await scalar<string>(
    admin,
    `SELECT id::text FROM organization.organizations
     WHERE seed_key = 'smk:s1:org:beta'`
  );
  const alphaWorkspaceId = await scalar<string>(
    admin,
    `SELECT id::text FROM organization.workspaces
     WHERE seed_key = 'smk:s1:workspace:alpha'`
  );
  const vindzamId = await scalar<string>(
    admin,
    `SELECT id::text FROM listing.channels WHERE code = 'VINDZAM'`
  );
  const vindlokaId = await scalar<string>(
    admin,
    `SELECT id::text FROM listing.channels WHERE code = 'VINDLOKA'`
  );
  const regionId = await scalar<string>(
    admin,
    `SELECT id::text FROM geo.regions
     WHERE seed_key = 's1:test:region:jakarta'`
  );

  assertEqual(
    await scalar<number>(
      admin,
      `SELECT count(*)::int FROM access.roles
       WHERE authority_plane = 'PLATFORM'
       AND code IN (
         'SUPER_ADMIN','OPERATIONS_ADMIN','MODERATOR',
         'SUPPORT_AGENT','ADS_OPERATOR','FINANCE_MAKER',
         'FINANCE_CHECKER','SECURITY_AUDITOR','REPORT_VIEWER'
       )`
    ),
    9,
    "nine platform roles"
  );

  assertEqual(
    await scalar<number>(
      admin,
      `SELECT count(*)::int FROM access.role_capabilities
       WHERE role_code IN ('OWNER','ADMIN')
       AND capability_code = 'verification.evidence.read'`
    ),
    0,
    "OWNER/ADMIN evidence-read absent"
  );

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "smk:s1:account:owner_alpha",
      personKey: "smk:s1:person:owner_alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      localAssignmentKey: "s1:test:assignment:person_owner_alpha",
      purposeCode: "S1_PERSON"
    });

    assertTrue(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_local_capability(
          'provider.status.transition',
          'PERSON',
          $1::uuid,
          NULL,NULL,NULL
        )`,
        [ownerAlphaPersonId]
      ),
      "PERSON local capability positive"
    );

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_local_capability(
          'provider.status.transition',
          'PERSON',
          $1::uuid,
          NULL,NULL,NULL
        )`,
        [
          await scalar<string>(
            admin,
            `SELECT id::text FROM party.persons
             WHERE seed_key = 'smk:s1:person:owner_beta'`
          )
        ]
      ),
      "PERSON cross-person denied"
    );
  } finally {
    await rollback(runtime);
  }

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "smk:s1:account:owner_alpha",
      personKey: "smk:s1:person:owner_alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s1:membership:owner_alpha",
      localAssignmentKey: "smk:s1:assignment:owner_alpha",
      organizationKey: "smk:s1:org:alpha",
      purposeCode: "S1_ORG"
    });

    assertTrue(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_local_capability(
          'provider.status.transition',
          'ORGANIZATION',
          NULL,$1::uuid,NULL,NULL
        )`,
        [alphaOrgId]
      ),
      "ORGANIZATION local capability positive"
    );

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_local_capability(
          'provider.status.transition',
          'ORGANIZATION',
          NULL,$1::uuid,NULL,NULL
        )`,
        [betaOrgId]
      ),
      "ORGANIZATION cross-tenant denied"
    );

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_local_capability(
          'provider.status.transition',
          'PROVIDER',
          NULL,NULL,NULL,
          '11111111-1111-1111-1111-111111111111'::uuid
        )`
      ),
      "future PROVIDER scope fail-closed"
    );

    assertEqual(
      await scalar<number>(
        runtime,
        `SELECT count(*)::int
         FROM access.scoped_assignments
         WHERE seed_key LIKE 'smk:s1:%'`
      ),
      1,
      "RLS scoped assignments self-only"
    );

    await expectPgError(
      async () =>
        runtime.query(
          `
            INSERT INTO access.scoped_assignments (
              seed_key,subject_person_id,membership_id,
              role_code,scope_type,scope_person_id,
              organization_id,workspace_id,status,
              effective_from,reason_code
            )
            VALUES (
              's1:test:runtime-self-escalation',
              $1::uuid,NULL,'OWNER','PERSON',$1::uuid,
              NULL,NULL,'ACTIVE',clock_timestamp(),'BAD'
            )
          `,
          [ownerAlphaPersonId]
        ),
      ["42501"],
      "runtime direct self-assignment denied"
    );
  } finally {
    await rollback(runtime);
  }

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "smk:s1:account:operations_alpha",
      personKey: "smk:s1:person:operations_alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      membershipKey: "smk:s1:membership:operations_alpha",
      localAssignmentKey: "s1:test:assignment:content_workspace_alpha",
      organizationKey: "smk:s1:org:alpha",
      workspaceKey: "smk:s1:workspace:alpha",
      purposeCode: "S1_WORKSPACE"
    });

    assertTrue(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_local_capability(
          'listing.publication.transition',
          'WORKSPACE',
          NULL,$1::uuid,$2::uuid,NULL
        )`,
        [alphaOrgId, alphaWorkspaceId]
      ),
      "WORKSPACE capability positive"
    );
  } finally {
    await rollback(runtime);
  }

  await expectPgError(
    async () =>
      admin.query(
        `
          INSERT INTO access.scoped_assignments (
            seed_key,subject_person_id,membership_id,
            role_code,scope_type,scope_person_id,
            organization_id,workspace_id,status,
            effective_from,reason_code
          )
          SELECT
            's1:test:provider-invalid',
            p.id,NULL,'OWNER','PROVIDER',NULL,
            NULL,NULL,'ACTIVE',clock_timestamp(),'BAD'
          FROM party.persons p
          WHERE p.seed_key = 'smk:s1:person:owner_alpha'
        `
      ),
    ["23514", "23502"],
    "PROVIDER assignment insert rejected in S1"
  );

  const platformCases = [
    {
      key: "moderator",
      capability: "verification.evidence.read",
      expected: true
    },
    {
      key: "moderator",
      capability: "provider.status.transition",
      expected: false
    },
    {
      key: "ops_admin",
      capability: "verification.evidence.read",
      expected: true
    },
    {
      key: "ops_admin",
      capability: "provider.status.transition",
      expected: true
    },
    {
      key: "support",
      capability: "provider.status.transition",
      expected: false
    },
    {
      key: "finance_maker",
      capability: "provider.status.transition",
      expected: false
    },
    {
      key: "finance_checker",
      capability: "verification.evidence.read",
      expected: false
    },
    {
      key: "security_auditor",
      capability: "verification.evidence.read",
      expected: false
    }
  ] as const;

  for (const testCase of platformCases) {
    await begin(runtime);
    try {
      await setContext(runtime, {
        accountKey: `s1:test:account:${testCase.key}`,
        personKey: `s1:test:person:${testCase.key}`,
        actorKind: "HUMAN",
        plane: "PLATFORM",
        platformAssignmentKey:
          `s1:test:platform_assignment:${testCase.key}`,
        purposeCode: "S1_PLATFORM"
      });

      const result = await scalar<boolean>(
        runtime,
        `SELECT access.has_platform_capability($1,NULL,NULL)`,
        [testCase.capability]
      );

      if (testCase.expected) {
        assertTrue(
          result,
          `${testCase.key} ${testCase.capability} positive`
        );
      } else {
        assertFalse(
          result,
          `${testCase.key} ${testCase.capability} negative`
        );
      }
    } finally {
      await rollback(runtime);
    }
  }

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "s1:test:account:expired_moderator",
      personKey: "s1:test:person:expired_moderator",
      actorKind: "HUMAN",
      plane: "PLATFORM",
      platformAssignmentKey:
        "s1:test:platform_assignment:expired_moderator",
      purposeCode: "S1_EXPIRED"
    });

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_platform_capability(
          'verification.evidence.read',NULL,NULL
        )`
      ),
      "expired platform assignment denied"
    );
  } finally {
    await rollback(runtime);
  }

  await expectPgError(
    async () =>
      admin.query(`
        INSERT INTO access.platform_assignments (
          assignment_key,subject_person_id,role_code,
          assignment_mode,status,effective_from,
          reason_code
        )
        SELECT
          's1:test:invalid-routine-super-admin',
          p.id,'SUPER_ADMIN','ROUTINE','ACTIVE',
          clock_timestamp(),'BAD'
        FROM party.persons p
        WHERE p.seed_key = 's1:test:person:super_admin'
      `),
    ["23514"],
    "routine SUPER_ADMIN rejected"
  );

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "s1:test:account:super_admin",
      personKey: "s1:test:person:super_admin",
      actorKind: "HUMAN",
      plane: "PLATFORM",
      platformAssignmentKey:
        "s1:test:platform_assignment:super_admin",
      channelCode: "VINDZAM",
      regionKey: "s1:test:region:jakarta",
      purposeCode: "S1_BREAK_GLASS",
      assurance: "STRONG",
      stepUp: false,
      breakGlassReference: "S1-BG-REF-001"
    });

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_platform_capability(
          'provider.management_authority.manage',
          $1::uuid,$2::uuid
        )`,
        [vindzamId, regionId]
      ),
      "break-glass without step-up denied"
    );

    await setContext(runtime, {
      accountKey: "s1:test:account:super_admin",
      personKey: "s1:test:person:super_admin",
      actorKind: "HUMAN",
      plane: "PLATFORM",
      platformAssignmentKey:
        "s1:test:platform_assignment:super_admin",
      channelCode: "VINDZAM",
      regionKey: "s1:test:region:jakarta",
      purposeCode: "S1_BREAK_GLASS",
      assurance: "STRONG",
      stepUp: true,
      breakGlassReference: "WRONG"
    });

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_platform_capability(
          'provider.management_authority.manage',
          $1::uuid,$2::uuid
        )`,
        [vindzamId, regionId]
      ),
      "break-glass wrong reference denied"
    );

    await setContext(runtime, {
      accountKey: "s1:test:account:super_admin",
      personKey: "s1:test:person:super_admin",
      actorKind: "HUMAN",
      plane: "PLATFORM",
      platformAssignmentKey:
        "s1:test:platform_assignment:super_admin",
      channelCode: "VINDZAM",
      regionKey: "s1:test:region:jakarta",
      purposeCode: "S1_BREAK_GLASS",
      assurance: "STRONG",
      stepUp: true,
      breakGlassReference: "S1-BG-REF-001"
    });

    assertTrue(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_platform_capability(
          'provider.management_authority.manage',
          $1::uuid,$2::uuid
        )`,
        [vindzamId, regionId]
      ),
      "valid finite break-glass positive"
    );
  } finally {
    await rollback(runtime);
  }

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "s1:test:account:service",
      actorKind: "SERVICE",
      plane: "SERVICE",
      serviceGrantKey: "s1:test:service_grant:publication",
      channelCode: "VINDZAM",
      regionKey: "s1:test:region:jakarta",
      purposeCode: "S1_SERVICE_TEST"
    });

    assertTrue(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_service_capability(
          'listing.publication.transition',
          $1::uuid,$2::uuid
        )`,
        [vindzamId, regionId]
      ),
      "service principal exact capability positive"
    );

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_service_capability(
          'provider.status.transition',
          $1::uuid,$2::uuid
        )`,
        [vindzamId, regionId]
      ),
      "service principal ungranted capability denied"
    );

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_service_capability(
          'listing.publication.transition',
          $1::uuid,$2::uuid
        )`,
        [vindlokaId, regionId]
      ),
      "service principal channel mismatch denied"
    );

    await expectPgError(
      async () =>
        runtime.query(
          `SELECT count(*) FROM access.service_principal_grants`
        ),
      ["42501"],
      "service grants raw runtime read denied"
    );
  } finally {
    await rollback(runtime);
  }

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "smk:s1:account:owner_alpha",
      personKey: "smk:s1:person:owner_alpha",
      actorKind: "HUMAN",
      plane: "RELATIONSHIP",
      purposeCode: "S1_PRIVACY"
    });

    assertEqual(
      await scalar<number>(
        runtime,
        `SELECT count(*)::int FROM privacy.consent_receipts
         WHERE receipt_key LIKE 's1:test:consent:%'`
      ),
      1,
      "privacy consent self-only RLS"
    );

    assertEqual(
      await scalar<number>(
        runtime,
        `SELECT count(*)::int FROM privacy.subject_requests
         WHERE request_key LIKE 's1:test:subject_request:%'`
      ),
      1,
      "subject request self-only RLS"
    );
  } finally {
    await rollback(runtime);
  }

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "s1:test:account:moderator",
      personKey: "s1:test:person:moderator",
      actorKind: "HUMAN",
      plane: "PLATFORM",
      platformAssignmentKey:
        "s1:test:platform_assignment:moderator",
      purposeCode: "VERIFY_PROVIDER",
      requestId: "s1-data-access-request"
    });

    assertTrue(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_platform_capability(
          'verification.evidence.read',NULL,NULL
        )`
      ),
      "restricted evidence capability foundation positive"
    );

    const logId = await scalar<string>(
      runtime,
      `
        SELECT security.record_data_access(
          'READ',
          'verification',
          'verification_evidence',
          's1:test:evidence',
          ARRAY['evidence_type','status'],
          1,
          'S1_TEST'
        )::text
      `
    );

    if (!logId) fail("data-access log helper returned id");
    pass("data-access log helper returned id");

    await runtime.query("COMMIT");
  } catch (error) {
    await rollback(runtime).catch(() => undefined);
    throw error;
  }

  assertEqual(
    await scalar<number>(
      admin,
      `SELECT count(*)::int
       FROM security.data_access_logs
       WHERE request_id = 's1-data-access-request'
         AND target_schema = 'verification'
         AND target_relation = 'verification_evidence'`
    ),
    1,
    "restricted data access log persisted"
  );

  assertEqual(
    await scalar<string>(
      runtime,
      `SELECT configuration.get_effective_setting(
        's1.test.threshold',$1::uuid,NULL
      )::text`,
      [vindzamId]
    ),
    "2",
    "channel config overrides global"
  );

  assertEqual(
    await scalar<string>(
      runtime,
      `SELECT configuration.get_effective_setting(
        's1.test.threshold',$1::uuid,NULL
      )::text`,
      [vindlokaId]
    ),
    "1",
    "global config fallback"
  );

  assertEqual(
    await scalar<number>(
      admin,
      `SELECT count(*)::int FROM party.persons
       WHERE seed_key LIKE 'smk:s1:%'
         AND (
           data_origin_code <> 'SYNTHETIC_DEMO'
           OR source_reference IS NULL
         )`
    ),
    0,
    "SMK person provenance reconciled"
  );

  assertEqual(
    await scalar<number>(
      admin,
      `SELECT count(*)::int FROM organization.organizations
       WHERE seed_key LIKE 'smk:s1:%'
         AND (
           data_origin_code <> 'SYNTHETIC_DEMO'
           OR source_reference IS NULL
         )`
    ),
    0,
    "SMK organization provenance reconciled"
  );

  assertEqual(
    await scalar<number>(
      admin,
      `SELECT count(*)::int FROM identity.accounts
       WHERE seed_key LIKE 'smk:s1:%'
         AND (
           data_origin_code <> 'SYNTHETIC_DEMO'
           OR source_reference IS NULL
         )`
    ),
    0,
    "SMK account provenance reconciled"
  );

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "smk:s1:account:owner_alpha",
      personKey: "smk:s1:person:owner_alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      localAssignmentKey: "smk:s1:assignment:owner_alpha",
      organizationKey: "smk:s1:org:alpha",
      purposeCode: "S1_POOL_A"
    });

    assertEqual(
      await scalar<string | null>(
        runtime,
        `SELECT security.context_value('actor_person_key')`
      ),
      "smk:s1:person:owner_alpha",
      "connection context request A initialized"
    );

    await runtime.query("COMMIT");

    await begin(runtime);

    assertEqual(
      await scalar<string | null>(
        runtime,
        `SELECT security.context_value('actor_person_key')`
      ),
      null,
      "connection pool actor context reset after commit"
    );

    assertEqual(
      await scalar<string | null>(
        runtime,
        `SELECT security.context_value('break_glass_reference')`
      ),
      null,
      "connection pool break-glass context reset"
    );

    assertFalse(
      await scalar<boolean>(
        runtime,
        `SELECT access.has_local_capability(
          'provider.status.transition',
          'ORGANIZATION',
          NULL,$1::uuid,NULL,NULL
        )`,
        [alphaOrgId]
      ),
      "no-context authorization fails closed"
    );
  } finally {
    await rollback(runtime);
  }

  await begin(runtime);
  try {
    await setContext(runtime, {
      accountKey: "smk:s1:account:owner_alpha",
      personKey: "smk:s1:person:owner_alpha",
      actorKind: "HUMAN",
      plane: "LOCAL",
      localAssignmentKey: "smk:s1:assignment:owner_alpha",
      organizationKey: "smk:s1:org:alpha",
      purposeCode: "S1_BOLA"
    });

    assertEqual(
      await scalar<number>(
        runtime,
        `SELECT count(*)::int FROM privacy.subject_requests
         WHERE request_key = 's1:test:subject_request:beta'`
      ),
      0,
      "IDOR/BOLA guessed privacy object denied"
    );
  } finally {
    await rollback(runtime);
  }

  await expectPgError(
    async () =>
      admin.query(`
        INSERT INTO access.service_principal_grants (
          grant_key,subject_account_id,capability_code,
          status,purpose_code,effective_from,reason_code
        )
        SELECT
          's1:test:invalid-human-service-grant',
          a.id,
          'listing.publication.transition',
          'ACTIVE',
          'BAD',
          clock_timestamp(),
          'BAD'
        FROM identity.accounts a
        WHERE a.seed_key = 'smk:s1:account:owner_alpha'
      `),
    ["23514"],
    "HUMAN account service grant rejected"
  );

  assertEqual(
    await scalar<number>(
      admin,
      `SELECT count(*)::int
       FROM information_schema.columns
       WHERE table_schema='access'
         AND table_name='scoped_assignments'
         AND column_name='provider_id'`
    ),
    1,
    "provider_id column present after DEC-021"
  );

  assertEqual(
    await scalar<number>(
      admin,
      `SELECT count(*)::int
       FROM access.role_capabilities
       WHERE role_code='SUPER_ADMIN'
         AND capability_code IN (
           'provider.status.transition',
           'provider.management_authority.manage',
           'listing.publication.transition',
           'verification.evidence.read'
         )`
    ),
    0,
    "SUPER_ADMIN has no routine sensitive mapping"
  );
}

async function main(): Promise<void> {
  const admin = new Client({
    connectionString: adminUrl,
    application_name: "vind-s1-access-test-admin"
  });
  const runtime = new Client({
    connectionString: runtimeUrl,
    application_name: "vind-s1-access-test-runtime"
  });

  try {
    await admin.connect();
    await runtime.connect();

    assertEqual(
      await scalar<string>(
        admin,
        `SELECT current_database()::text`
      ),
      process.env.POSTGRES_DB || "vind_app_dev",
      "admin database identity"
    );

    assertEqual(
      await scalar<string>(
        runtime,
        `SELECT session_user::text`
      ),
      "vind_app_runtime",
      "runtime session identity"
    );

    await setupFixtures(admin);
    await runTests(admin, runtime);

    console.log(`S1_TEST_COUNT=${passed}`);
    console.log("S1_FOUNDATION_ACCESS_CLOSURE_TEST_PASS");
  } finally {
    await admin.end().catch(() => undefined);
    await runtime.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
