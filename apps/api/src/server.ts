import { Client } from "pg";
import { buildApp } from "./app.js";
import type { ReadinessDependency } from "./readiness.js";
import { PostgresSessionStore, type DatabaseClient } from "./auth/postgres-session-store.js";
import { parseChannelHostConfigFromEnv, validateChannelHostConfig } from "./auth/channel.js";

export interface BuildProductionAppOptions {
  env?: Record<string, string | undefined> | undefined;
  dbClient?: DatabaseClient | undefined;
  readinessDependencies?: readonly ReadinessDependency[] | undefined;
}

export async function buildProductionApp(options: BuildProductionAppOptions = {}) {
  const env = options.env ?? process.env;
  const databaseUrl = env.DATABASE_URL;

  if (!databaseUrl || !databaseUrl.trim()) {
    throw new Error("FATAL: DATABASE_URL environment variable is required for production API startup with B2 persistent session store.");
  }

  const channelHostConfig = parseChannelHostConfigFromEnv(env);
  validateChannelHostConfig(channelHostConfig);

  let dbClient: DatabaseClient;
  let shouldCloseDb = false;

  if (options.dbClient) {
    dbClient = options.dbClient;
  } else {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    dbClient = client;
    shouldCloseDb = true;
  }

  const sessionStore = new PostgresSessionStore(dbClient);

  const app = buildApp({
    sessionStore,
    channelHostConfig,
    dbClient,
    ...(options.readinessDependencies ? { readinessDependencies: options.readinessDependencies } : {})
  });

  if (shouldCloseDb && "end" in dbClient && typeof (dbClient as any).end === "function") {
    app.addHook("onClose", async () => {
      await (dbClient as any).end().catch(() => {});
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
