import { HttpProblemError } from "../errors.js";

export type AuthorityPlane = "RELATIONSHIP" | "LOCAL" | "PLATFORM" | "SERVICE";
export type ActorKind = "HUMAN" | "SERVICE";

export interface AuthorityContext {
  actorKind: ActorKind;
  authorityPlane: AuthorityPlane;
  accountKey: string;
  personKey: string;
  membershipKey?: string;
  localAssignmentKey?: string;
  platformAssignmentKey?: string;
  serviceGrantKey?: string;
  organizationKey?: string;
  workspaceKey?: string;
  providerKey?: string;
  roleCode?: string;
  authAssuranceLevel?: string;
  stepUpVerified?: boolean;
  breakGlassReference?: string;
}

export function validateProviderStatusTransitionAuthority(context: AuthorityContext): void {
  if (context.breakGlassReference) {
    if (context.roleCode === "SUPER_ADMIN") return;
  }

  if (context.authorityPlane === "LOCAL") {
    if (["OWNER", "ADMIN"].includes(context.roleCode ?? "")) return;
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: "Provider status transition requires local OWNER or ADMIN role."
    });
  }

  if (context.authorityPlane === "PLATFORM") {
    if (context.roleCode === "OPERATIONS_ADMIN") return;
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: "Provider status transition on platform plane requires OPERATIONS_ADMIN role."
    });
  }

  throw new HttpProblemError({
    code: "CAPABILITY_DENIED",
    detail: "Invalid authority plane for provider status transition."
  });
}

export function validateProviderManagementAuthority(context: AuthorityContext): void {
  if (context.authorityPlane !== "LOCAL" || context.roleCode !== "OWNER") {
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: "Provider management authority is strictly reserved for local OWNER."
    });
  }
}

export function validatePublicationTransitionAuthority(context: AuthorityContext): void {
  if (context.authorityPlane !== "LOCAL") {
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: "Publication transition requires LOCAL Sahabat authority."
    });
  }

  if (!["OWNER", "ADMIN", "CONTENT_MANAGER"].includes(context.roleCode ?? "")) {
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: "Publication transition requires local OWNER, ADMIN, or CONTENT_MANAGER role."
    });
  }
}

export function validateVerificationEvidenceReadAuthority(context: AuthorityContext): void {
  // Local roles (OWNER, ADMIN) MUST NOT obtain verification evidence access
  if (context.authorityPlane === "LOCAL") {
    throw new HttpProblemError({
      code: "OBJECT_ACCESS_DENIED",
      detail: "Local Sahabat roles (OWNER/ADMIN) are denied access to verification evidence."
    });
  }

  if (context.breakGlassReference && context.roleCode === "SUPER_ADMIN") {
    return;
  }

  if (context.authorityPlane === "PLATFORM") {
    if (["MODERATOR", "OPERATIONS_ADMIN"].includes(context.roleCode ?? "")) return;
    throw new HttpProblemError({
      code: "CAPABILITY_DENIED",
      detail: "Verification evidence read requires platform MODERATOR or OPERATIONS_ADMIN role."
    });
  }

  throw new HttpProblemError({
    code: "CAPABILITY_DENIED",
    detail: "Invalid authority plane for verification evidence read."
  });
}
