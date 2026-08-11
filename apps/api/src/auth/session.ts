import { randomBytes } from "node:crypto";

export interface SessionData {
  sessionId: string;
  accountKey: string;
  personKey?: string | null;
  actorKind: "HUMAN" | "SERVICE";
  authorityPlane: "RELATIONSHIP" | "LOCAL" | "PLATFORM" | "SERVICE";
  authAssuranceLevel: string;
  stepUpVerified: boolean;
  membershipKey?: string | null;
  localAssignmentKey?: string | null;
  platformAssignmentKey?: string | null;
  serviceGrantKey?: string | null;
  organizationKey?: string | null;
  workspaceKey?: string | null;
  providerKey?: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionStore {
  createSession(
    data: Omit<SessionData, "sessionId" | "createdAt" | "expiresAt" | "revokedAt">,
    ttlMs?: number
  ): Promise<SessionData>;
  getSession(sessionId: string): Promise<SessionData | null>;
  revokeSession(sessionId: string): Promise<boolean>;
  clear(): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async createSession(
    data: Omit<SessionData, "sessionId" | "createdAt" | "expiresAt" | "revokedAt">,
    ttlMs: number = 86400000 // 24 hours
  ): Promise<SessionData> {
    const sessionId = `vses_${randomBytes(24).toString("hex")}`;
    const now = new Date();
    const session: SessionData = {
      ...data,
      sessionId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      revokedAt: null
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    return session;
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt) return false;

    session.revokedAt = new Date();
    return true;
  }

  async clear(): Promise<void> {
    this.sessions.clear();
  }
}

export const defaultSessionStore = new InMemorySessionStore();

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
