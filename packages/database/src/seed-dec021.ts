import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

type SeedCommand = "apply" | "cleanup" | "verify";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, "..");
const seedDirectory = path.join(
  packageRoot,
  "prisma",
  "seeds",
  "smk-slice-2"
);

dotenv.config({
  path: path.join(packageRoot, ".env")
});

const command = (process.argv[2] ?? "apply") as SeedCommand;

const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
const runtimeConnectionString = process.env.DATABASE_URL;

if (!migrationConnectionString || !runtimeConnectionString) {
  throw new Error("DATABASE_MIGRATION_URL and DATABASE_URL are required.");
}

function validateLocalConnectionUrl(connectionString: string, label: string): void {
  const parsed = new URL(connectionString);

  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`${label} must use localhost. Received: ${parsed.hostname}`);
  }

  if (parsed.port && parsed.port !== "5432" && parsed.port !== process.env.ISOLATED_PORT) {
    throw new Error(`${label} must use canonical port 5432. Received: ${parsed.port}`);
  }

  if (parsed.pathname !== "/vind_app_dev" && parsed.pathname !== "/vind_app_disposable_dev" && (!process.env.ISOLATED_DB_NAME || parsed.pathname !== `/${process.env.ISOLATED_DB_NAME}`)) {
    throw new Error(`${label} must target vind_app_dev or vind_app_disposable_dev. Received: ${parsed.pathname}`);
  }
}

validateLocalConnectionUrl(migrationConnectionString, "DATABASE_MIGRATION_URL");
validateLocalConnectionUrl(runtimeConnectionString, "DATABASE_URL");

async function applySeed(): Promise<void> {
  const seedSql = await readFile(path.join(seedDirectory, "seed.sql"), "utf8");
  const mediaSql = await readFile(path.join(seedDirectory, "media-fixture-metadata.sql"), "utf8");
  const client = new Client({ connectionString: migrationConnectionString, application_name: "vind-seed-dec021-apply" });

  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET ROLE vind_db_owner");
    await client.query("SET LOCAL timezone TO 'UTC'");
    await client.query("SELECT set_config('vind.command_execution_active', 'on', true)");

    const combinedSql = seedSql + "\n" + mediaSql;
    const cleanSql = combinedSql
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    const statements = cleanSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await client.query(statement);
    }

    await client.query("RESET ROLE");
    await client.query("COMMIT");
    console.log("SMK Slice 2 DB-DEC021 seed applied successfully.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifySeed(): Promise<void> {
  const client = new Client({ connectionString: migrationConnectionString, application_name: "vind-seed-dec021-verify" });

  try {
    await client.connect();
    await client.query("SET ROLE vind_db_owner");
    const resOrgs = await client.query("SELECT count(*)::integer as count FROM organization.organizations WHERE data_origin_code = 'SYNTHETIC_DEMO'");
    const resProvs = await client.query("SELECT count(*)::integer as count FROM provider.provider_profiles");
    const resCases = await client.query("SELECT count(*)::integer as count FROM verification.verification_cases");
    const resEvs = await client.query("SELECT count(*)::integer as count FROM verification.verification_evidence");
    const resOfferings = await client.query("SELECT count(*)::integer as count FROM catalog.offerings");
    const resPubs = await client.query("SELECT count(*)::integer as count FROM listing.channel_publications");
    const resMedia = await client.query("SELECT count(*)::integer as count FROM media.media_assets");
    const resGeos = await client.query("SELECT count(*)::integer as count FROM geo.regions WHERE seed_key LIKE 'smk:s2:geo:%'");
    await client.query("RESET ROLE");

    console.log("Seed verification counts:");
    console.log(`- Synthetic Organizations: ${resOrgs.rows[0].count}`);
    console.log(`- Provider Profiles: ${resProvs.rows[0].count}`);
    console.log(`- Verification Cases: ${resCases.rows[0].count}`);
    console.log(`- Verification Evidence: ${resEvs.rows[0].count}`);
    console.log(`- Catalog Offerings: ${resOfferings.rows[0].count}`);
    console.log(`- Channel Publications: ${resPubs.rows[0].count}`);
    console.log(`- Media Assets: ${resMedia.rows[0].count}`);
    console.log(`- Geo Regions: ${resGeos.rows[0].count}`);

    if (Number(resProvs.rows[0].count) < 10 || Number(resOfferings.rows[0].count) < 10 || Number(resPubs.rows[0].count) < 10) {
      throw new Error("Seed verification failed: count below required thresholds.");
    }

    console.log("SMK Slice 2 DB-DEC021 seed verification PASSED.");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (command === "apply") {
    await applySeed();
  } else if (command === "verify") {
    await verifySeed();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
