import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpProblemError } from "../errors.js";
import {
  buildClearSessionCookieHeader,
  parseSessionCookieToken,
  type SessionStore
} from "./session.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "./channel.js";

export interface AuthRoutesOptions {
  sessionStore: SessionStore;
  channelHostConfig: ChannelHostConfig;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions
): void {
  const { sessionStore, channelHostConfig } = options;

  app.get("/api/v1/me", async (request: FastifyRequest) => {
    const token = parseSessionCookieToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: "Authentication required to access /api/v1/me."
      });
    }

    const session = await sessionStore.resolveSession(token);
    if (!session) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: "Session cookie is invalid, expired, or revoked."
      });
    }

    const channel = resolveCanonicalChannel(
      request.headers.host,
      channelHostConfig,
      request.headers["x-vind-channel"] as string | string[] | undefined
    );

    const responseData: Record<string, unknown> = {
      actor_kind: session.actorKind,
      authority_plane: session.authorityPlane,
      account_key: session.accountKey,
      channel: {
        code: channel.code,
        name: channel.name
      }
    };

    if (session.personKey) {
      responseData.person_key = session.personKey;
    }
    if (session.membershipKey) {
      responseData.membership_key = session.membershipKey;
    }
    if (session.localAssignmentKey) {
      responseData.local_assignment_key = session.localAssignmentKey;
    }
    if (session.platformAssignmentKey) {
      responseData.platform_assignment_key = session.platformAssignmentKey;
    }
    if (session.serviceGrantKey) {
      responseData.service_grant_key = session.serviceGrantKey;
    }
    if (session.organizationKey) {
      responseData.organization_key = session.organizationKey;
    }
    if (session.workspaceKey) {
      responseData.workspace_key = session.workspaceKey;
    }
    if (session.providerKey) {
      responseData.provider_key = session.providerKey;
    }
    if (session.regionKey) {
      responseData.region_key = session.regionKey;
    }

    return {
      data: responseData,
      meta: {
        request_id: request.vindRequestId || request.id
      }
    };
  });

  app.post("/api/v1/session/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = parseSessionCookieToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: "Authentication required to logout session."
      });
    }

    // Call revokeSession idempotently; do not throw on unknown/expired token
    await sessionStore.revokeSession(token, "USER_LOGOUT");

    reply.header("Set-Cookie", buildClearSessionCookieHeader());

    return {
      data: {
        success: true
      },
      meta: {
        request_id: request.vindRequestId || request.id
      }
    };
  });
}
