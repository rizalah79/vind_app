import { Client } from "pg";
import { buildApp } from "./app.js";
import { PostgresSessionStore } from "./auth/postgres-session-store.js";
import { parseChannelHostConfigFromEnv, validateChannelHostConfig } from "./auth/channel.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";

const databaseUrl = process.env.DATABASE_URL;
let dbClient: Client | undefined;
let sessionStore: PostgresSessionStore | undefined;

if (databaseUrl) {
  dbClient = new Client({ connectionString: databaseUrl });
  await dbClient.connect();
  sessionStore = new PostgresSessionStore(dbClient);
}

const channelHostConfig = parseChannelHostConfigFromEnv();
validateChannelHostConfig(channelHostConfig);

const app = buildApp({
  ...(sessionStore && channelHostConfig.vindzamAllowedHosts.length > 0 ? { sessionStore, channelHostConfig } : {})
});

if (dbClient) {
  app.addHook("onClose", async () => {
    await dbClient?.end().catch(() => {});
  });
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  if (dbClient) {
    await dbClient.end().catch(() => {});
  }
  process.exit(1);
}
