import { createHash } from "node:crypto";
import type { ResolvedSessionContext, SessionStore } from "./session.js";

export interface DatabaseClient {
  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }>;
}

export class PostgresSessionStore implements SessionStore {
  constructor(private db: DatabaseClient) {}

  async resolveSession(rawToken: string): Promise<ResolvedSessionContext | null> {
    if (!rawToken || typeof rawToken !== "string") {
      return null;
    }

    const tokenDigest = createHash("sha256").update(rawToken, "utf8").digest();

    const result = await this.db.query<{
      session_id: string;
      actor_account_key: string;
      actor_person_key: string | null;
      actor_kind: "HUMAN" | "SERVICE";
      authority_plane: "RELATIONSHIP" | "LOCAL" | "PLATFORM" | "SERVICE";
      membership_key: string | null;
      local_assignment_key: string | null;
      platform_assignment_key: string | null;
      service_grant_key: string | null;
      organization_key: string | null;
      workspace_key: string | null;
      provider_key: string | null;
      channel_code: string | null;
      region_key: string | null;
      auth_assurance_level: string;
      step_up_verified: boolean;
      absolute_expires_at: Date | string;
    }>(
      `SELECT * FROM identity.resolve_auth_session($1)`,
      [tokenDigest]
    );

    if (!result || !result.rows || result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      accountKey: row.actor_account_key,
      personKey: row.actor_person_key ?? null,
      actorKind: row.actor_kind,
      authorityPlane: row.authority_plane,
      membershipKey: row.membership_key ?? null,
      localAssignmentKey: row.local_assignment_key ?? null,
      platformAssignmentKey: row.platform_assignment_key ?? null,
      serviceGrantKey: row.service_grant_key ?? null,
      organizationKey: row.organization_key ?? null,
      workspaceKey: row.workspace_key ?? null,
      providerKey: row.provider_key ?? null,
      authorityChannelCode: row.channel_code ?? null,
      regionKey: row.region_key ?? null,
      authAssuranceLevel: row.auth_assurance_level,
      stepUpVerified: Boolean(row.step_up_verified),
      absoluteExpiresAt: row.absolute_expires_at instanceof Date ? row.absolute_expires_at : new Date(row.absolute_expires_at)
    };
  }

  async revokeSession(rawToken: string, reasonCode: string = "USER_LOGOUT"): Promise<boolean> {
    if (!rawToken || typeof rawToken !== "string") {
      return false;
    }

    const tokenDigest = createHash("sha256").update(rawToken, "utf8").digest();

    const result = await this.db.query<{ revoke_auth_session: boolean }>(
      `SELECT identity.revoke_auth_session($1, $2) AS revoke_auth_session`,
      [tokenDigest, reasonCode]
    );

    if (!result || !result.rows || result.rows.length === 0) {
      return false;
    }

    const row = result.rows[0];
    if (!row) {
      return false;
    }

    return Boolean(row.revoke_auth_session);
  }
}
