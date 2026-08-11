import type { Prisma } from "@vind/database";
import { HttpProblemError } from "../errors.js";

export type AuthorityPlane = "RELATIONSHIP" | "LOCAL" | "PLATFORM" | "SERVICE";
export type ActorKind = "HUMAN" | "SERVICE";

export interface AuthorityCheckParams {
  capabilityCode: string;
  scopeType?: "ORGANIZATION" | "WORKSPACE" | "PROVIDER" | "PERSON" | undefined;
  organizationId?: string | null | undefined;
  workspaceId?: string | null | undefined;
  providerId?: string | null | undefined;
  targetChannelId?: string | null | undefined;
  targetRegionId?: string | null | undefined;
}

/**
 * Invokes canonical Access DB functions (`access.has_local_capability`, `access.has_platform_capability`,
 * `access.has_service_capability`) inside the initialized request-context v2 transaction.
 */
export async function checkCanonicalCapability(
  tx: Prisma.TransactionClient,
  authorityPlane: AuthorityPlane,
  params: AuthorityCheckParams
): Promise<boolean> {
  if (authorityPlane === "LOCAL") {
    const result = await tx.$queryRawUnsafe<Array<{ has_local_capability: boolean }>>(
      `SELECT access.has_local_capability($1, $2, NULL, $3::uuid, $4::uuid, $5::uuid) AS has_local_capability`,
      params.capabilityCode,
      params.scopeType ?? "PROVIDER",
      params.organizationId ?? null,
      params.workspaceId ?? null,
      params.providerId ?? null
    );
    return Boolean(result[0]?.has_local_capability);
  }

  if (authorityPlane === "PLATFORM") {
    const result = await tx.$queryRawUnsafe<Array<{ has_platform_capability: boolean }>>(
      `SELECT access.has_platform_capability($1, $2::uuid, $3::uuid) AS has_platform_capability`,
      params.capabilityCode,
      params.targetChannelId ?? null,
      params.targetRegionId ?? null
    );
    return Boolean(result[0]?.has_platform_capability);
  }

  if (authorityPlane === "SERVICE") {
    const result = await tx.$queryRawUnsafe<Array<{ has_service_capability: boolean }>>(
      `SELECT access.has_service_capability($1, NULL) AS has_service_capability`,
      params.capabilityCode
    );
    return Boolean(result[0]?.has_service_capability);
  }

  return false;
}

export async function assertCanonicalCapability(
  tx: Prisma.TransactionClient,
  authorityPlane: AuthorityPlane,
  params: AuthorityCheckParams
): Promise<void> {
  const allowed = await checkCanonicalCapability(tx, authorityPlane, params);
  if (!allowed) {
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: `Canonical Access capability '${params.capabilityCode}' denied on ${authorityPlane} plane.`
    });
  }
}

export async function validateProviderStatusTransitionAuthority(
  tx: Prisma.TransactionClient,
  authorityPlane: AuthorityPlane,
  providerId: string
): Promise<void> {
  await assertCanonicalCapability(tx, authorityPlane, {
    capabilityCode: "provider.status.transition",
    scopeType: "PROVIDER",
    providerId
  });
}

export async function validateProviderManagementAuthority(
  tx: Prisma.TransactionClient,
  authorityPlane: AuthorityPlane,
  providerId: string
): Promise<void> {
  if (authorityPlane !== "LOCAL") {
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: "Provider management authority is strictly reserved for local authority plane."
    });
  }

  await assertCanonicalCapability(tx, authorityPlane, {
    capabilityCode: "provider.management_authority.manage",
    scopeType: "PROVIDER",
    providerId
  });
}

export async function validatePublicationTransitionAuthority(
  tx: Prisma.TransactionClient,
  authorityPlane: AuthorityPlane,
  providerId: string
): Promise<void> {
  if (authorityPlane !== "LOCAL") {
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: "Publication transition requires LOCAL Sahabat authority."
    });
  }

  await assertCanonicalCapability(tx, authorityPlane, {
    capabilityCode: "listing.publication.transition",
    scopeType: "PROVIDER",
    providerId
  });
}

export async function validateVerificationEvidenceReadAuthority(
  tx: Prisma.TransactionClient,
  authorityPlane: AuthorityPlane,
  providerId?: string
): Promise<void> {
  if (authorityPlane === "LOCAL") {
    throw new HttpProblemError({
      code: "OBJECT_ACCESS_DENIED",
      detail: "Local Sahabat roles are strictly denied access to verification evidence."
    });
  }

  await assertCanonicalCapability(tx, authorityPlane, {
    capabilityCode: "verification.evidence.read",
    scopeType: "PROVIDER",
    providerId
  });
}
