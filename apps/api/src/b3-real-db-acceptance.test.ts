import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";
import { buildApp } from "./app.js";
import { type SessionStore, type ResolvedSessionContext } from "./auth/session.js";
import { createPrismaClient, type DatabaseClient } from "@vind/database";
import { runWithRequestContextV2 } from "./auth/request-context-v2.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

dotenv.config({ path: path.join(repoRoot, ".env") });
dotenv.config({ path: path.join(repoRoot, "packages", "database", ".env") });

const bootstrapUser = process.env.POSTGRES_USER || "vind_bootstrap";
const bootstrapPassword = process.env.POSTGRES_PASSWORD;
const dbPort = process.env.POSTGRES_PORT || "5432";
const mainDbName = process.env.POSTGRES_DB || "vind_app_dev";

const acceptDbName = `vind_app_accept_b3_${Date.now()}`;

const adminUrl = `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${dbPort}/${mainDbName}`;
const ownerUrl = `postgresql://vind_migrator:d9c019e387229ff9ea243f9d5f87c6e3dc5a5d82406e8701093107e3a49ca805@127.0.0.1:${dbPort}/${acceptDbName}?options=-c%20role%3Dvind_db_owner`;
const runtimeUrl = `postgresql://vind_app_runtime:044e408d8dd3f869ce2ef5cd77aefc7d6d9c8570617400e1a94bcb3a2f7b76cd@127.0.0.1:${dbPort}/${acceptDbName}`;

class TestAcceptanceSessionStore implements SessionStore {
  private sessions = new Map<string, ResolvedSessionContext>();

  addSession(rawToken: string, session: ResolvedSessionContext): void {
    this.sessions.set(rawToken, session);
  }

  async resolveSession(rawToken: string): Promise<ResolvedSessionContext | null> {
    const session = this.sessions.get(rawToken);
    if (!session) return null;
    if (session.absoluteExpiresAt.getTime() <= Date.now()) return null;
    return session;
  }

  async revokeSession(rawToken: string): Promise<boolean> {
    return this.sessions.delete(rawToken);
  }
}

describe("F. Real PostgreSQL Acceptance Test Suite — vind_app_runtime (B3)", () => {
  let app: any;
  let runtimePrismaClient: DatabaseClient;
  let sessionStore: TestAcceptanceSessionStore;

  const channelHostConfig = {
    vindzamAllowedHosts: ["vindzam.test", "localhost"],
    vindlokaAllowedHosts: ["vindloka.test"]
  };

  // Fixture Identifiers (UUIDs)
  const idOrgAlpha = "00000000-0000-4000-a000-000000000010";
  const idOrgBeta = "00000000-0000-4000-a000-000000000020";

  const idWsAlpha1 = "00000000-0000-4000-a000-000000000011";
  const idWsAlpha2 = "00000000-0000-4000-a000-000000000012";
  const idWsBeta1 = "00000000-0000-4000-a000-000000000021";

  const idProvAlpha1 = "00000000-0000-4000-a000-000000000101";
  const idProvAlphaNoPub = "00000000-0000-4000-a000-000000000102";
  const idProvInactive = "00000000-0000-4000-a000-000000000103";
  const idProvBeta1 = "00000000-0000-4000-a000-000000000104";
  const idProvIndiv = "00000000-0000-4000-a000-000000000105";

  const idOffAlpha1 = "00000000-0000-4000-a000-000000000201";
  const idOffAlpha2 = "00000000-0000-4000-a000-000000000202";
  const idOffBeta1 = "00000000-0000-4000-a000-000000000203";
  const idOffIndiv1 = "00000000-0000-4000-a000-000000000204";

  const idPkgAlpha1 = "00000000-0000-4000-a000-000000000301";

  const idPubEligible = "00000000-0000-4000-a000-000000000401";
  const idPubEligible2 = "00000000-0000-4000-a000-000000000402";
  const idPubWrongChannel = "00000000-0000-4000-a000-000000000403";
  const idPubFuture = "00000000-0000-4000-a000-000000000404";
  const idPubExpired = "00000000-0000-4000-a000-000000000405";
  const idPubInactiveProv = "00000000-0000-4000-a000-000000000406";
  const idPubUnpublished = "00000000-0000-4000-a000-000000000407";
  const idPubIndiv = "00000000-0000-4000-a000-000000000408";

  const idPerAlpha = "00000000-0000-4000-a000-000000000901";
  const idPerBeta = "00000000-0000-4000-a000-000000000902";
  const idPerIndiv = "00000000-0000-4000-a000-000000000905";

  const idMemAlpha = "00000000-0000-4000-a000-000000000801";
  const idMemBeta = "00000000-0000-4000-a000-000000000802";

  const tokenOrgAlpha = "token_org_alpha_session";
  const tokenWsAlpha1 = "token_ws_alpha_1_session";
  const tokenWsAlpha2 = "token_ws_alpha_2_session";
  const tokenWsBeta1 = "token_ws_beta_1_session";
  const tokenProvAlpha = "token_prov_alpha_session";
  const tokenProvIndiv = "token_prov_indiv_session";

  before(async () => {
    if (!bootstrapPassword) {
      throw new Error("POSTGRES_PASSWORD environment variable required for real PostgreSQL acceptance suite.");
    }

    // 1. Create fresh isolated acceptance DB
    const adminClient = new Client({ connectionString: adminUrl });
    await adminClient.connect();
    await adminClient.query(`DROP DATABASE IF EXISTS "${acceptDbName}" WITH (FORCE);`);
    await adminClient.query(`CREATE DATABASE "${acceptDbName}" OWNER vind_db_owner;`);

    // Bootstrap extensions and logical schemas
    const isoBootstrapUrl = `postgresql://${bootstrapUser}:${bootstrapPassword}@127.0.0.1:${dbPort}/${acceptDbName}`;
    const isoAdminClient = new Client({ connectionString: isoBootstrapUrl });
    await isoAdminClient.connect();
    await isoAdminClient.query(`
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

      GRANT USAGE ON SCHEMA identity, party, privacy, organization, access, geo, provider, verification, catalog, listing, media, availability, engagement, messaging, commercial, content, ads, sponsor, finance, security, integration TO vind_app_runtime;
      GRANT USAGE ON SCHEMA identity, party, privacy, organization, access, geo, provider, verification, catalog, listing, media, availability, engagement, messaging, commercial, content, ads, sponsor, finance, staging TO vind_importer;
    `);
    await isoAdminClient.end();
    await adminClient.end();

    // 2. Apply canonical migrations in order as vind_db_owner
    const ownerClient = new Client({ connectionString: ownerUrl });
    await ownerClient.connect();

    const migrationsDir = path.join(repoRoot, "packages", "database", "prisma", "migrations");
    const migrationFolders = fs.readdirSync(migrationsDir).sort();

    for (const folder of migrationFolders) {
      const sqlPath = path.join(migrationsDir, folder, "migration.sql");
      if (fs.existsSync(sqlPath)) {
        const sql = fs.readFileSync(sqlPath, "utf-8");
        await ownerClient.query(sql);
      }
    }

    // Enable command execution mode for fixture seeding
    await ownerClient.query("SELECT set_config('vind.command_execution_active', 'on', false);");

    // 3. Resolve existing channel IDs from listing.channels
    const chanRes = await ownerClient.query(`SELECT id, code FROM listing.channels`);
    const chanMap = new Map<string, string>();
    for (const row of chanRes.rows) {
      chanMap.set(row.code, row.id);
    }

    const idChanVindzam = chanMap.get("VINDZAM");
    const idChanVindloka = chanMap.get("VINDLOKA");

    if (!idChanVindzam || !idChanVindloka) {
      throw new Error("VINDZAM or VINDLOKA channel baseline not found.");
    }

    // Organizations
    await ownerClient.query(`
      INSERT INTO organization.organizations (id, seed_key, legal_name, display_name, organization_type, status, data_origin_code, is_synthetic) VALUES
      ('${idOrgAlpha}', 'org:alpha', 'Alpha Corp Legal', 'Alpha Corp', 'SYNTHETIC_DEMO', 'ACTIVE', 'SYNTHETIC_DEMO', true),
      ('${idOrgBeta}', 'org:beta', 'Beta Inc Legal', 'Beta Inc', 'SYNTHETIC_DEMO', 'ACTIVE', 'SYNTHETIC_DEMO', true);
    `);

    // Workspaces
    await ownerClient.query(`
      INSERT INTO organization.workspaces (id, seed_key, organization_id, code, display_name, status) VALUES
      ('${idWsAlpha1}', 'ws:alpha1', '${idOrgAlpha}', 'WS-A1', 'Alpha Workspace 1', 'ACTIVE'),
      ('${idWsAlpha2}', 'ws:alpha2', '${idOrgAlpha}', 'WS-A2', 'Alpha Workspace 2', 'ACTIVE'),
      ('${idWsBeta1}', 'ws:beta1', '${idOrgBeta}', 'WS-B1', 'Beta Workspace 1', 'ACTIVE');
    `);

    // Persons
    await ownerClient.query(`
      INSERT INTO party.persons (id, seed_key, display_name, status, data_origin_code, is_synthetic, contactable) VALUES
      ('${idPerAlpha}', 'person:alpha', 'Alpha Person', 'ACTIVE', 'SYNTHETIC_DEMO', true, false),
      ('${idPerBeta}', 'person:beta', 'Beta Person', 'ACTIVE', 'SYNTHETIC_DEMO', true, false),
      ('${idPerIndiv}', 'person:indiv', 'Iwan Person', 'ACTIVE', 'SYNTHETIC_DEMO', true, false);
    `);

    // Memberships
    await ownerClient.query(`
      INSERT INTO access.memberships (id, seed_key, person_id, organization_id, status, effective_from) VALUES
      ('${idMemAlpha}', 'mem:alpha', '${idPerAlpha}', '${idOrgAlpha}', 'ACTIVE', clock_timestamp() - interval '1 day'),
      ('${idMemBeta}', 'mem:beta', '${idPerBeta}', '${idOrgBeta}', 'ACTIVE', clock_timestamp() - interval '1 day');
    `);

    // Provider Profiles
    await ownerClient.query(`
      INSERT INTO provider.provider_profiles (id, seed_key, owning_organization_id, owning_person_id, provider_type, status, legal_name, display_name, data_origin_code) VALUES
      ('${idProvAlpha1}', 'prov:alpha1', '${idOrgAlpha}', NULL, 'COMPANY', 'ACTIVE', 'Alpha Provider 1 Pt', 'Alpha Provider One', 'SYNTHETIC_DEMO'),
      ('${idProvAlphaNoPub}', 'prov:alphanopub', '${idOrgAlpha}', NULL, 'COMPANY', 'ACTIVE', 'Alpha No Pub Pt', 'Alpha No Pub Provider', 'SYNTHETIC_DEMO'),
      ('${idProvInactive}', 'prov:inactive', '${idOrgAlpha}', NULL, 'COMPANY', 'SUSPENDED', 'Inactive Corp Pt', 'Inactive Provider', 'SYNTHETIC_DEMO'),
      ('${idProvBeta1}', 'prov:beta1', '${idOrgBeta}', NULL, 'COMPANY', 'ACTIVE', 'Beta Provider 1 Pt', 'Beta Provider One', 'SYNTHETIC_DEMO'),
      ('${idProvIndiv}', 'prov:indiv', NULL, '${idPerIndiv}', 'INDIVIDUAL', 'ACTIVE', 'Iwan Individual', 'Iwan Person Provider', 'SYNTHETIC_DEMO');
    `);

    // Provider Workspace Links
    await ownerClient.query(`
      INSERT INTO provider.provider_workspace_links (provider_profile_id, managing_organization_id, workspace_id, link_status, effective_from) VALUES
      ('${idProvAlpha1}', '${idOrgAlpha}', '${idWsAlpha1}', 'ACTIVE', clock_timestamp() - interval '1 day'),
      ('${idProvBeta1}', '${idOrgBeta}', '${idWsBeta1}', 'ACTIVE', clock_timestamp() - interval '1 day');
    `);

    // Scoped Assignments (Access RLS Alignment)
    await ownerClient.query(`
      INSERT INTO access.scoped_assignments (id, seed_key, membership_id, subject_person_id, role_code, scope_type, organization_id, workspace_id, provider_id, status, effective_from) VALUES
      ('00000000-0000-4000-a000-000000000811', 'sa_org_alpha', '${idMemAlpha}', '${idPerAlpha}', 'ADMIN', 'ORGANIZATION', '${idOrgAlpha}', NULL, NULL, 'ACTIVE', clock_timestamp() - interval '1 day'),
      ('00000000-0000-4000-a000-000000000812', 'sa_ws_alpha1', '${idMemAlpha}', '${idPerAlpha}', 'ADMIN', 'WORKSPACE', '${idOrgAlpha}', '${idWsAlpha1}', NULL, 'ACTIVE', clock_timestamp() - interval '1 day'),
      ('00000000-0000-4000-a000-000000000813', 'sa_ws_alpha2', '${idMemAlpha}', '${idPerAlpha}', 'ADMIN', 'WORKSPACE', '${idOrgAlpha}', '${idWsAlpha2}', NULL, 'ACTIVE', clock_timestamp() - interval '1 day'),
      ('00000000-0000-4000-a000-000000000814', 'sa_ws_beta1', '${idMemBeta}', '${idPerBeta}', 'ADMIN', 'WORKSPACE', '${idOrgBeta}', '${idWsBeta1}', NULL, 'ACTIVE', clock_timestamp() - interval '1 day'),
      ('00000000-0000-4000-a000-000000000815', 'sa_prov_alpha', '${idMemAlpha}', '${idPerAlpha}', 'ADMIN', 'PROVIDER', NULL, NULL, '${idProvAlpha1}', 'ACTIVE', clock_timestamp() - interval '1 day'),
      ('00000000-0000-4000-a000-000000000816', 'sa_prov_indiv', NULL, '${idPerIndiv}', 'ADMIN', 'PROVIDER', NULL, NULL, '${idProvIndiv}', 'ACTIVE', clock_timestamp() - interval '1 day');
    `);

    // Catalog Offerings
    await ownerClient.query(`
      INSERT INTO catalog.offerings (id, seed_key, provider_profile_id, offering_code, title, description, status) VALUES
      ('${idOffAlpha1}', 'offering:alpha1', '${idProvAlpha1}', 'OFF-A1', 'Alpha Delivery Service', 'Standard delivery service', 'ACTIVE'),
      ('${idOffAlpha2}', 'offering:alpha2', '${idProvAlpha1}', 'OFF-A2', 'Alpha Express Cargo', 'Same day express cargo', 'ACTIVE'),
      ('${idOffBeta1}', 'offering:beta1', '${idProvBeta1}', 'OFF-B1', 'Beta Freight Service', 'Heavy freight logistics', 'ACTIVE'),
      ('${idOffIndiv1}', 'offering:indiv1', '${idProvIndiv}', 'OFF-I1', 'Iwan Independent Service', 'Personal freelance service', 'ACTIVE');
    `);

    // Catalog Packages
    await ownerClient.query(`
      INSERT INTO catalog.packages (id, seed_key, provider_profile_id, package_code, title, anchor_offering_id, status) VALUES
      ('${idPkgAlpha1}', 'package:alpha1', '${idProvAlpha1}', 'PKG-A1', 'Alpha Full Package', '${idOffAlpha1}', 'ACTIVE');

      INSERT INTO catalog.package_items (package_id, offering_id, quantity, is_optional) VALUES
      ('${idPkgAlpha1}', '${idOffAlpha1}', 1, false);
    `);

    // Channel Publications
    await ownerClient.query(`
      INSERT INTO listing.channel_publications (id, seed_key, provider_profile_id, offering_id, package_id, channel_id, channel_code, publication_status, effective_from, effective_to, created_at) VALUES
      ('${idPubEligible}', 'pub:elig', '${idProvAlpha1}', '${idOffAlpha1}', NULL, '${idChanVindzam}', 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '1 day', NULL, clock_timestamp() - interval '10 minutes'),
      ('${idPubEligible2}', 'pub:elig2', '${idProvAlpha1}', '${idOffAlpha2}', NULL, '${idChanVindzam}', 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '1 day', NULL, clock_timestamp() - interval '5 minutes'),
      ('${idPubWrongChannel}', 'pub:wrongchan', '${idProvAlpha1}', '${idOffAlpha1}', NULL, '${idChanVindloka}', 'VINDLOKA', 'PUBLISHED', clock_timestamp() - interval '1 day', NULL, clock_timestamp() - interval '8 minutes'),
      ('${idPubFuture}', 'pub:fut', '${idProvAlpha1}', '${idOffAlpha1}', NULL, '${idChanVindzam}', 'VINDZAM', 'PUBLISHED', clock_timestamp() + interval '10 days', NULL, clock_timestamp() - interval '7 minutes'),
      ('${idPubExpired}', 'pub:exp', '${idProvAlpha1}', '${idOffAlpha1}', NULL, '${idChanVindzam}', 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '20 days', clock_timestamp() - interval '1 day', clock_timestamp() - interval '6 minutes'),
      ('${idPubInactiveProv}', 'pub:inactprov', '${idProvInactive}', '${idOffAlpha1}', NULL, '${idChanVindzam}', 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '1 day', NULL, clock_timestamp() - interval '4 minutes'),
      ('${idPubUnpublished}', 'pub:draft', '${idProvAlpha1}', '${idOffAlpha1}', NULL, '${idChanVindzam}', 'VINDZAM', 'DRAFT', clock_timestamp() - interval '1 day', NULL, clock_timestamp() - interval '3 minutes'),
      ('${idPubIndiv}', 'pub:indiv', '${idProvIndiv}', '${idOffIndiv1}', NULL, '${idChanVindzam}', 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '1 day', NULL, clock_timestamp() - interval '2 minutes');
    `);

    await ownerClient.end();

    // 4. Initialize Test Session Store and API Runtime connections under vind_app_runtime
    runtimePrismaClient = createPrismaClient(runtimeUrl);
    sessionStore = new TestAcceptanceSessionStore();

    const futureExpires = new Date(Date.now() + 86400000);

    sessionStore.addSession(tokenOrgAlpha, {
      sessionId: "sess_org_alpha",
      accountKey: "acc_alpha_key",
      personKey: "person:alpha",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      membershipKey: "mem:alpha",
      localAssignmentKey: "sa_org_alpha",
      platformAssignmentKey: null,
      serviceGrantKey: null,
      organizationKey: "org:alpha",
      workspaceKey: null,
      providerKey: "prov:alpha1",
      channelCode: "VINDZAM",
      regionKey: null,
      authAssuranceLevel: "AL1",
      stepUpVerified: false,
      absoluteExpiresAt: futureExpires
    });

    sessionStore.addSession(tokenWsAlpha1, {
      sessionId: "sess_ws_alpha1",
      accountKey: "acc_alpha_key",
      personKey: "person:alpha",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      membershipKey: "mem:alpha",
      localAssignmentKey: "sa_ws_alpha1",
      platformAssignmentKey: null,
      serviceGrantKey: null,
      organizationKey: "org:alpha",
      workspaceKey: "ws:alpha1",
      providerKey: "prov:alpha1",
      channelCode: "VINDZAM",
      regionKey: null,
      authAssuranceLevel: "AL1",
      stepUpVerified: false,
      absoluteExpiresAt: futureExpires
    });

    sessionStore.addSession(tokenWsAlpha2, {
      sessionId: "sess_ws_alpha2",
      accountKey: "acc_alpha_key",
      personKey: "person:alpha",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      membershipKey: "mem:alpha",
      localAssignmentKey: "sa_ws_alpha2",
      platformAssignmentKey: null,
      serviceGrantKey: null,
      organizationKey: "org:alpha",
      workspaceKey: "ws:alpha2",
      providerKey: null,
      channelCode: "VINDZAM",
      regionKey: null,
      authAssuranceLevel: "AL1",
      stepUpVerified: false,
      absoluteExpiresAt: futureExpires
    });

    sessionStore.addSession(tokenWsBeta1, {
      sessionId: "sess_ws_beta1",
      accountKey: "acc_beta_key",
      personKey: "person:beta",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      membershipKey: "mem:beta",
      localAssignmentKey: "sa_ws_beta1",
      platformAssignmentKey: null,
      serviceGrantKey: null,
      organizationKey: "org:beta",
      workspaceKey: "ws:beta1",
      providerKey: "prov:beta1",
      channelCode: "VINDZAM",
      regionKey: null,
      authAssuranceLevel: "AL1",
      stepUpVerified: false,
      absoluteExpiresAt: futureExpires
    });

    sessionStore.addSession(tokenProvAlpha, {
      sessionId: "sess_prov_alpha",
      accountKey: "acc_alpha_key",
      personKey: "person:alpha",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      membershipKey: "mem:alpha",
      localAssignmentKey: "sa_prov_alpha",
      platformAssignmentKey: null,
      serviceGrantKey: null,
      organizationKey: null,
      workspaceKey: null,
      providerKey: "prov:alpha1",
      channelCode: "VINDZAM",
      regionKey: null,
      authAssuranceLevel: "AL1",
      stepUpVerified: false,
      absoluteExpiresAt: futureExpires
    });

    sessionStore.addSession(tokenProvIndiv, {
      sessionId: "sess_prov_indiv",
      accountKey: "acc_indiv_key",
      personKey: "person:indiv",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      membershipKey: null,
      localAssignmentKey: "sa_prov_indiv",
      platformAssignmentKey: null,
      serviceGrantKey: null,
      organizationKey: null,
      workspaceKey: null,
      providerKey: "prov:indiv",
      channelCode: "VINDZAM",
      regionKey: null,
      authAssuranceLevel: "AL1",
      stepUpVerified: false,
      absoluteExpiresAt: futureExpires
    });

    app = buildApp({
      sessionStore,
      channelHostConfig,
      domainDbClient: runtimePrismaClient
    });
  });

  after(async () => {
    if (app) await app.close();
    if (runtimePrismaClient) await runtimePrismaClient.$disconnect().catch(() => {});

    // Clean drop isolated acceptance DB
    const adminClient = new Client({ connectionString: adminUrl });
    await adminClient.connect();
    await adminClient.query(`DROP DATABASE IF EXISTS "${acceptDbName}" WITH (FORCE);`);
    await adminClient.end();
  });

  // ============================================================================
  // F1. ANONYMOUS PUBLIC READS
  // ============================================================================
  describe("F1. Anonymous Public Reads", () => {
    it("Public provider: returns 200 for qualifying provider and matched canonical channel", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/providers/${idProvAlpha1}`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, idProvAlpha1);
      assert.equal(body.data.display_name, "Alpha Provider One");
      assert.equal(body.data.status, "ACTIVE");
    });

    it("Public provider: returns 404 for ACTIVE provider without qualifying channel publication", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/providers/${idProvAlphaNoPub}`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
    });

    it("Public provider: returns 404 when querying on wrong channel host", async () => {
      // idProvIndiv only has publication on VINDZAM channel
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/providers/${idProvIndiv}`,
        headers: { host: "vindloka.test" }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
    });

    it("Public provider: returns 404 for INACTIVE provider", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/providers/${idProvInactive}`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
    });

    it("Public listing collection: returns only eligible PUBLISHED listings for matched channel", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/listings",
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(Array.isArray(body.data), true);

      const pubIds = body.data.map((item: any) => item.id);

      assert.equal(pubIds.includes(idPubEligible2), true, "idPubEligible2 must be visible");
      assert.equal(pubIds.includes(idPubEligible), true, "idPubEligible must be visible");
      assert.equal(pubIds.includes(idPubIndiv), true, "idPubIndiv must be visible");

      // Negatives: wrong channel, future, expired, inactive provider, draft must all be hidden
      assert.equal(pubIds.includes(idPubWrongChannel), false, "wrong channel hidden");
      assert.equal(pubIds.includes(idPubFuture), false, "future listing hidden");
      assert.equal(pubIds.includes(idPubExpired), false, "expired listing hidden");
      assert.equal(pubIds.includes(idPubInactiveProv), false, "inactive-provider listing hidden");
      assert.equal(pubIds.includes(idPubUnpublished), false, "draft listing hidden");
    });

    it("Public listing collection: provider_id filter restricts results", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/listings?provider_id=${idProvAlpha1}`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.length, 2);
      assert.equal(body.data.every((item: any) => item.provider_id === idProvAlpha1), true);
    });

    it("Public listing collection: pagination cursor page 1 / page 2 is stable (tie-breaker created_at DESC, publication_id DESC)", async () => {
      // Fetch Page 1 with limit = 1
      const page1Res = await app.inject({
        method: "GET",
        url: `/api/v1/public/listings?provider_id=${idProvAlpha1}&limit=1`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(page1Res.statusCode, 200);
      const page1Body = page1Res.json();
      assert.equal(page1Body.data.length, 1);
      assert.equal(page1Body.data[0].id, idPubEligible2);
      assert.equal(page1Body.meta.pagination.has_more, true);
      const cursor = page1Body.meta.pagination.next_cursor;
      assert.notEqual(cursor, null);

      // Fetch Page 2 with cursor
      const page2Res = await app.inject({
        method: "GET",
        url: `/api/v1/public/listings?provider_id=${idProvAlpha1}&limit=1&cursor=${encodeURIComponent(cursor)}`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(page2Res.statusCode, 200);
      const page2Body = page2Res.json();
      assert.equal(page2Body.data.length, 1);
      assert.equal(page2Body.data[0].id, idPubEligible);
    });

    it("Public listing detail: eligible published listing returns 200 OK", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/listings/${idPubEligible}`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, idPubEligible);
      assert.equal(body.data.provider.display_name, "Alpha Provider One");
      assert.equal(body.data.offering.offering_code, "OFF-A1");
    });

    it("Public listing detail: wrong channel, unpublished, future, expired, inactive provider all return 404 RESOURCE_NOT_FOUND", async () => {
      for (const targetId of [idPubWrongChannel, idPubFuture, idPubExpired, idPubInactiveProv, idPubUnpublished]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/public/listings/${targetId}`,
          headers: { host: "vindzam.test" }
        });

        assert.equal(response.statusCode, 404, `Target ${targetId} must return 404`);
        assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
      }
    });

    it("Public API does NOT depend on Request Context V2 or session cookies", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/listings/${idPubEligible}`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 200);
    });
  });

  // ============================================================================
  // F2. AUTHENTICATED LOCAL — ORGANIZATION
  // ============================================================================
  describe("F2. Authenticated LOCAL — ORGANIZATION", () => {
    it("Allows authorized Organization actor to read Provider and Catalog detail", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${idProvAlpha1}`,
        headers: {
          host: "vindzam.test",
          cookie: `vind_session=${tokenOrgAlpha}`
        }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, idProvAlpha1);
      assert.equal(body.data.display_name, "Alpha Provider One");
    });

    it("Cross-provider negative: denies access to Beta provider for Alpha Organization session", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${idProvBeta1}`,
        headers: {
          host: "vindzam.test",
          cookie: `vind_session=${tokenOrgAlpha}`
        }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
    });
  });

  // ============================================================================
  // F3. AUTHENTICATED LOCAL — WORKSPACE
  // ============================================================================
  describe("F3. Authenticated LOCAL — WORKSPACE", () => {
    it("Provider linked to exact authorized workspace => allowed", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${idProvAlpha1}`,
        headers: {
          host: "vindzam.test",
          cookie: `vind_session=${tokenWsAlpha1}`
        }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, idProvAlpha1);
    });

    it("Same organization but different workspace => denied / 404", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${idProvAlpha1}`,
        headers: {
          host: "vindzam.test",
          cookie: `vind_session=${tokenWsAlpha2}`
        }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
    });

    it("Unrelated workspace => denied / 404", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${idProvAlpha1}`,
        headers: {
          host: "vindzam.test",
          cookie: `vind_session=${tokenWsBeta1}`
        }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
    });
  });

  // ============================================================================
  // F4. AUTHENTICATED LOCAL — PROVIDER
  // ============================================================================
  describe("F4. Authenticated LOCAL — PROVIDER", () => {
    it("Direct provider assignment => authorized Provider/Catalog read", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${idProvAlpha1}`,
        headers: {
          host: "vindzam.test",
          cookie: `vind_session=${tokenProvAlpha}`
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.id, idProvAlpha1);
    });

    it("Another provider => denied / 404", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${idProvBeta1}`,
        headers: {
          host: "vindzam.test",
          cookie: `vind_session=${tokenProvAlpha}`
        }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
    });

    it("Independent person-owned provider => authorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${idProvIndiv}`,
        headers: {
          host: "vindzam.test",
          cookie: `vind_session=${tokenProvIndiv}`
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.id, idProvIndiv);
    });
  });

  // ============================================================================
  // F5. REQUEST CONTEXT V2 LIFECYCLE & ISOLATION
  // ============================================================================
  describe("F5. Request Context V2", () => {
    it("Preserves set, domain work, clear, pool isolation, and rollback isolation", async () => {
      const contextParams = {
        actorAccountKey: "acc_alpha_key",
        actorPersonKey: "person:alpha",
        actorKind: "HUMAN" as const,
        authorityPlane: "LOCAL" as const,
        membershipKey: "mem:alpha",
        localAssignmentKey: "sa_ws_alpha1",
        platformAssignmentKey: null,
        serviceGrantKey: null,
        organizationKey: "org:alpha",
        workspaceKey: "ws:alpha1",
        providerKey: "prov:alpha1",
        channelCode: "VINDZAM",
        regionKey: null,
        requestId: "req_rcv2_test"
      };

      // 1. Verify context set & domain work succeeds within transaction
      const result = await runWithRequestContextV2(runtimePrismaClient, contextParams, async (tx: any) => {
        return tx.provider_profiles.findFirst({
          where: { id: idProvAlpha1 }
        });
      });

      assert.notEqual(result, null);
      assert.equal(result.id, idProvAlpha1);

      // 2. Verify rollback isolation: an aborted transaction does not leave context active on pool connection
      try {
        await runWithRequestContextV2(runtimePrismaClient, contextParams, async (tx: any) => {
          throw new Error("Simulated domain transaction failure");
        });
      } catch (err: any) {
        assert.equal(err.message, "Simulated domain transaction failure");
      }

      // 3. Next query without context cannot read RLS-protected table outside transaction (returns null due to RLS filter)
      const noContextResult = await (runtimePrismaClient as any).provider_profiles.findFirst({
        where: { id: idProvAlpha1 }
      });
      assert.equal(noContextResult, null);
    });
  });
});
