import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpProblemError } from "../errors.js";
import {
  buildClearSessionCookieHeader,
  defaultSessionStore,
  parseSessionToken,
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
    const token = parseSessionToken(request.headers as Record<string, string | string[] | undefined>);
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
        detail: "Session token is invalid, expired, or revoked."
      });
    }

    const channel = resolveCanonicalChannel(
      request.headers.host,
      request.headers["x-vind-channel"] as string | string[] | undefined
    );

    return {
      data: {
        actor_kind: session.actorKind,
        authority_plane: session.authorityPlane,
        account: {
          id: session.accountKey,
          seed_key: session.accountKey,
          account_type: session.actorKind,
          status: "ACTIVE"
        },
        person: {
          id: session.personKey,
          seed_key: session.personKey,
          display_name: `Person ${session.personKey}`
        },
        channel: {
          code: channel.code,
          name: channel.name
        },
        organization_id: session.organizationKey,
        workspace_id: session.workspaceKey,
        provider_id: session.providerKey
      },
      meta: {
        request_id: request.vindRequestId || request.id
      }
    };
  });

  app.post("/api/v1/session/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = parseSessionToken(request.headers as Record<string, string | string[] | undefined>);
    if (token) {
      await store.revokeSession(token);
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
