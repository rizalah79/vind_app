export type DependencyStatus = "ready" | "down";

export interface DependencyReadiness {
  name: string;
  status: DependencyStatus;
}

export interface ReadinessDependency {
  name: string;
  check: () => Promise<void>;
}

export interface ReadinessResult {
  ready: boolean;
  dependencies: DependencyReadiness[];
}

export async function checkReadiness(
  dependencies: readonly ReadinessDependency[]
): Promise<ReadinessResult> {
  const results: DependencyReadiness[] = [];

  for (const dependency of dependencies) {
    try {
      await dependency.check();
      results.push({
        name: dependency.name,
        status: "ready"
      });
    } catch {
      results.push({
        name: dependency.name,
        status: "down"
      });
    }
  }

  return {
    ready: results.every((dependency) => dependency.status === "ready"),
    dependencies: results
  };
}

export function createDatabaseReadinessDependency(): ReadinessDependency {
  return {
    name: "database",
    async check(): Promise<void> {
      const { createPrismaClient } = await import("@vind/database");
      const client = createPrismaClient();

      try {
        await client.$queryRaw`SELECT 1`;
      } finally {
        await client.$disconnect().catch(() => undefined);
      }
    }
  };
}
