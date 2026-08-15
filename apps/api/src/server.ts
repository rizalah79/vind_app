import { Client } from "pg";
import { buildApp } from "./app.js";
import type { ReadinessDependency } from "./readiness.js";
import { PostgresSessionStore, type DatabaseClient as SessionDatabaseClient } from "./auth/postgres-session-store.js";
import { parseChannelHostConfigFromEnv, validateChannelHostConfig } from "./auth/channel.js";
import { createPrismaClient, type DatabaseClient as DomainDatabaseClient } from "@vind/database";

export interface BuildProductionAppOptions {
  env?: Record<string, string | undefined> | undefined;
  sessionDbClient?: SessionDatabaseClient | undefined;
  domainDbClient?: DomainDatabaseClient | undefined;
  readinessDependencies?: readonly ReadinessDependency[] | undefined;
}

export function isDomainDatabaseClient(client: unknown): client is DomainDatabaseClient {
  return (
    typeof client === "object" &&
    client !== null &&
    "$queryRaw" in client &&
    typeof (client as any).$queryRaw === "function" &&
    "$transaction" in client &&
    typeof (client as any).$transaction === "function"
  );
}

export function isSessionDatabaseClient(client: unknown): client is SessionDatabaseClient {
  return (
    typeof client === "object" &&
    client !== null &&
    "query" in client &&
    typeof (client as any).query === "function"
  );
}

export async function buildProductionApp(options: BuildProductionAppOptions = {}) {
  const env = options.env ?? process.env;
  const databaseUrl = env.DATABASE_URL;

  if (!databaseUrl || !databaseUrl.trim()) {
    throw new Error("FATAL: DATABASE_URL environment variable is required for production API startup with B2 persistent session store.");
  }

  const channelHostConfig = parseChannelHostConfigFromEnv(env);
  validateChannelHostConfig(channelHostConfig);

  let sessionDbClient: SessionDatabaseClient;
  let shouldCloseSessionDb = false;

  if (options.sessionDbClient) {
    if (!isSessionDatabaseClient(options.sessionDbClient)) {
      throw new Error("FATAL: Invalid sessionDbClient supplied. Expected query-capable session database adapter.");
    }
    sessionDbClient = options.sessionDbClient;
  } else {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    sessionDbClient = client;
    shouldCloseSessionDb = true;
  }

  let domainDbClient: DomainDatabaseClient;
  let shouldCloseDomainDb = false;

  if (options.domainDbClient) {
    if (!isDomainDatabaseClient(options.domainDbClient)) {
      throw new Error("FATAL: Invalid domainDbClient supplied. Expected Prisma DatabaseClient with $queryRaw support.");
    }
    domainDbClient = options.domainDbClient;
  } else {
    domainDbClient = createPrismaClient(databaseUrl);
    shouldCloseDomainDb = true;
  }

  const sessionStore = new PostgresSessionStore(sessionDbClient);

  const app = buildApp({
    sessionStore,
    channelHostConfig,
    domainDbClient,
    ...(options.readinessDependencies ? { readinessDependencies: options.readinessDependencies } : {})
  });

  if (shouldCloseSessionDb && "end" in sessionDbClient && typeof (sessionDbClient as any).end === "function") {
    app.addHook("onClose", async () => {
      await (sessionDbClient as any).end().catch(() => {});
    });
  }

  if (shouldCloseDomainDb && "$disconnect" in domainDbClient && typeof domainDbClient.$disconnect === "function") {
    app.addHook("onClose", async () => {
      await domainDbClient.$disconnect().catch(() => {});
    });
  }

  return app;
}

if (process.argv[1] && (process.argv[1].endsWith("server.js") || process.argv[1].endsWith("server.ts"))) {
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  try {
    const app = await buildProductionApp();
    await app.listen({ host, port });
  } catch (error) {
    console.error("Failed to start production server:", error);
    process.exit(1);
  }
}
