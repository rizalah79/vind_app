import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export function createPrismaClient(
  connectionString: string | undefined = process.env.DATABASE_URL
): PrismaClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  const adapter = new PrismaPg({
    connectionString
  });

  return new PrismaClient({
    adapter
  });
}

export type DatabaseClient = ReturnType<typeof createPrismaClient>;