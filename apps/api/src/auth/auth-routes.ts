import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpProblemError } from "../errors.js";
import {
  buildClearSessionCookieHeader,
  defaultSessionStore,
  parseSessionCookieToken,
  type SessionStore
} from "./session.js";
import { resolveCanonicalChannel } from "./channel.js";

export interface AuthRoutesOptions {
  sessionStore?: SessionStore | undefined;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions = {}
): void {
  const store = options.sessionStore ?? defaultSessionStore;

  app.get("/api/v1/me", async (request: FastifyRequest) => {
    const token = parseSessionCookieToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: "Authentication required to access /api/v1/me."
      });
    }

    const session = await store.getSession(token);
    if (!session) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: "Session cookie is invalid, expired, or revoked."
      });
    }

    const channel = resolveCanonicalChannel(
      request.headers.host,
      request.headers["x-vind-channel"] as string | string[] | undefined
    );

    const responseData: Record<string, unknown> = {
      actor_kind: session.actorKind,
      authority_plane: session.authorityPlane,
      account_id: session.accountKey,
      channel: {
        code: channel.code,
        name: channel.name
      }
    };

    if (session.personKey) {
      responseData.person_id = session.personKey;
    }

    if (session.organizationKey) {
      responseData.organization_id = session.organizationKey;
    }
    if (session.workspaceKey) {
      responseData.workspace_id = session.workspaceKey;
    }
    if (session.providerKey) {
      responseData.provider_id = session.providerKey;
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

    const revoked = await store.revokeSession(token);
    if (!revoked) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: "Session cookie is invalid, expired, or already revoked."
      });
    }

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
