import type { DatabaseClient } from "@vind/database";

export interface RequestContextV2Params {
  actorAccountKey?: string | null | undefined;
  actorPersonKey?: string | null | undefined;
  actorKind: "HUMAN" | "SERVICE";
  authorityPlane: "RELATIONSHIP" | "LOCAL" | "PLATFORM" | "SERVICE";
  membershipKey?: string | null | undefined;
  localAssignmentKey?: string | null | undefined;
  platformAssignmentKey?: string | null | undefined;
  serviceGrantKey?: string | null | undefined;
  organizationKey?: string | null | undefined;
  workspaceKey?: string | null | undefined;
  providerKey?: string | null | undefined;
  channelCode?: string | null | undefined;
  regionKey?: string | null | undefined;
  purposeCode?: string | null | undefined;
  correlationId?: string | null | undefined;
  requestId?: string | null | undefined;
  authAssuranceLevel?: string | null | undefined;
  stepUpVerified?: boolean;
  breakGlassReference?: string | null | undefined;
}

/**
 * Runs a transactional database callback wrapped in security.set_request_context_v2.
 * Context is strictly transaction-local and cleared before & after execution to prevent
 * connection pool leakage.
 */
export async function runWithRequestContextV2<T>(
  db: DatabaseClient,
  params: RequestContextV2Params,
  fn: (tx: Parameters<Parameters<DatabaseClient["$transaction"]>[0]>[0]) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    try {
      // 1. Clear any residual connection context
      await tx.$executeRawUnsafe(`SELECT security.clear_request_context()`);

      // 2. Set strict request context v2
      await tx.$executeRawUnsafe(
        `SELECT security.set_request_context_v2(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19
        )`,
        params.actorAccountKey ?? null,
        params.actorPersonKey ?? null,
        params.actorKind,
        params.authorityPlane,
        params.membershipKey ?? null,
        params.localAssignmentKey ?? null,
        params.platformAssignmentKey ?? null,
        params.serviceGrantKey ?? null,
        params.organizationKey ?? null,
        params.workspaceKey ?? null,
        params.providerKey ?? null,
        params.channelCode ?? null,
        params.regionKey ?? null,
        params.purposeCode ?? null,
        params.correlationId ?? null,
        params.requestId ?? null,
        params.authAssuranceLevel ?? null,
        params.stepUpVerified ?? false,
        params.breakGlassReference ?? null
      );

      // 3. Execute domain work inside initialized request context
      return await fn(tx);
    } finally {
      // 4. Clear request context on completion/error before releasing connection
      try {
        await tx.$executeRawUnsafe(`SELECT security.clear_request_context()`);
      } catch {
        // Ignore cleanup failure in rollback
      }
    }
  });
}
