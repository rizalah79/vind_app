export interface ResolvedSessionContext {
  sessionId: string;
  accountKey: string;
  personKey?: string | null;
  actorKind: "HUMAN" | "SERVICE";
  authorityPlane: "RELATIONSHIP" | "LOCAL" | "PLATFORM" | "SERVICE";
  membershipKey?: string | null;
  localAssignmentKey?: string | null;
  platformAssignmentKey?: string | null;
  serviceGrantKey?: string | null;
  organizationKey?: string | null;
  workspaceKey?: string | null;
  providerKey?: string | null;
  authorityChannelCode?: string | null;
  regionKey?: string | null;
  authAssuranceLevel: string;
  stepUpVerified: boolean;
  absoluteExpiresAt: Date;
}

export interface SessionStore {
  resolveSession(rawToken: string): Promise<ResolvedSessionContext | null>;
  revokeSession(rawToken: string, reasonCode?: string): Promise<boolean>;
}

export const sessionCookieName = "vind_session" as const;

/**
 * Extracts session token exclusively from the canonical HttpOnly cookie `vind_session`.
 * Bearer header session parsing is intentionally excluded for Stage-1 opaque cookie security.
 */
export function parseSessionCookieToken(headers: Record<string, string | string[] | undefined>): string | null {
  const cookieHeader = headers["cookie"];
  if (typeof cookieHeader === "string") {
    const match = cookieHeader.match(/(?:^|;\s*)vind_session=([^;]+)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1].trim());
    }
  }
  return null;
}

export function buildSessionCookieHeader(sessionId: string): string {
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/api/v1; HttpOnly; Secure; SameSite=Lax`;
}

export function buildClearSessionCookieHeader(): string {
  return `${sessionCookieName}=; Path=/api/v1; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
