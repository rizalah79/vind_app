import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { parseSessionCookieToken, type SessionStore } from "../auth/session.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { runWithRequestContextV2, type RequestContextV2Params } from "../auth/request-context-v2.js";
import { validateUuid } from "../catalog/validation.js";
import { type MediaDeliveryAdapter, StorageDependencyError } from "./delivery-adapter.js";

export function registerMediaRoutes(
  app: FastifyInstance,
  options: {
    dbClient: DatabaseClient;
    sessionStore: SessionStore;
    channelHostConfig: ChannelHostConfig;
    mediaDeliveryAdapter?: MediaDeliveryAdapter | undefined;
  }
): void {
  const { dbClient, sessionStore, channelHostConfig, mediaDeliveryAdapter } = options;

  async function getDeliveryAdapter(): Promise<MediaDeliveryAdapter> {
    if (!mediaDeliveryAdapter) {
      throw new HttpProblemError({
        code: "DEPENDENCY_UNAVAILABLE",
        detail: "Media delivery infrastructure is unconfigured."
      });
    }
    return mediaDeliveryAdapter;
  }

  async function prepareRequestContext(request: FastifyRequest): Promise<RequestContextV2Params> {
    const token = parseSessionCookieToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: "Session authentication required."
      });
    }

    const session = await sessionStore.resolveSession(token);
    if (!session) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: "Invalid or expired session token."
      });
    }

    const channel = resolveCanonicalChannel(request.headers.host, channelHostConfig);

    return {
      actorAccountKey: session.accountKey,
      actorPersonKey: session.personKey ?? null,
      actorKind: session.actorKind as "HUMAN" | "SERVICE",
      authorityPlane: session.authorityPlane as "RELATIONSHIP" | "LOCAL" | "PLATFORM" | "SERVICE",
      membershipKey: session.membershipKey ?? null,
      localAssignmentKey: session.localAssignmentKey ?? null,
      platformAssignmentKey: session.platformAssignmentKey ?? null,
      serviceGrantKey: session.serviceGrantKey ?? null,
      organizationKey: session.organizationKey ?? null,
      workspaceKey: session.workspaceKey ?? null,
      providerKey: session.providerKey ?? null,
      channelCode: channel.code,
      regionKey: session.regionKey ?? null,
      requestId: request.vindRequestId
    };
  }

  // 1. GET /api/v1/public/media/:mediaId/delivery (Public Media Delivery)
  app.get<{ Params: { mediaId: string } }>(
    "/api/v1/public/media/:mediaId/delivery",
    async (request, reply) => {
      const adapter = await getDeliveryAdapter();
      const mediaId = validateUuid(request.params.mediaId, "mediaId");
      const channel = resolveCanonicalChannel(request.headers.host, channelHostConfig);
      const now = new Date();

      let deliveryRow: {
        media_id: string;
        storage_locator: string;
        content_type: string;
      } | null = null;

      try {
        if (typeof (dbClient as any).$queryRaw === "function") {
          const rows = await (dbClient as any).$queryRaw`SELECT * FROM media.read_public_media_delivery(${mediaId}::uuid, ${channel.code}::text)`;
          if (Array.isArray(rows) && rows.length > 0) {
            deliveryRow = {
              media_id: rows[0].media_id,
              storage_locator: rows[0].storage_locator,
              content_type: rows[0].content_type
            };
          }
        }
      } catch (e: any) {
        // Fallback for mock or unmigrated db
      }

      if (!deliveryRow) {
        const asset = await dbClient.media_assets.findFirst({
          where: {
            id: mediaId,
            status: "ACTIVE",
            media_rights: {
              some: {
                status: "ACTIVE",
                effective_from: { lte: now },
                OR: [{ effective_to: null }, { effective_to: { gt: now } }]
              }
            },
            media_links: {
              some: {
                link_status: "ACTIVE",
                link_role: "PUBLIC_LISTING",
                effective_from: { lte: now },
                OR: [{ effective_to: null }, { effective_to: { gt: now } }]
              }
            }
          }
        });

        if (!asset) {
          throw new HttpProblemError({
            code: "RESOURCE_NOT_FOUND",
            detail: "Media asset not found or not eligible for public delivery."
          });
        }

        deliveryRow = {
          media_id: asset.id,
          storage_locator: asset.storage_path,
          content_type: asset.mime_type
        };
      }

      try {
        const deliveryResult = await adapter.generateDeliveryUrl({
          mediaId: deliveryRow.media_id,
          storageLocator: deliveryRow.storage_locator,
          mimeType: deliveryRow.content_type
        });

        reply.header("cache-control", "no-store, max-age=0, private");
        reply.header("pragma", "no-cache");

        return reply.status(200).send({
          data: {
            media_id: deliveryRow.media_id,
            content_type: deliveryRow.content_type,
            delivery_url: deliveryResult.deliveryUrl,
            expires_at: deliveryResult.expiresAt
          },
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err: unknown) {
        if (err instanceof StorageDependencyError || (err instanceof Error && err.name === "StorageDependencyError")) {
          throw new HttpProblemError({
            code: "DEPENDENCY_UNAVAILABLE",
            detail: "Media delivery storage dependency is unavailable."
          });
        }
        throw err;
      }
    }
  );

  // 2. GET /api/v1/media/:mediaId/delivery (Authenticated Media Delivery)
  app.get<{ Params: { mediaId: string } }>(
    "/api/v1/media/:mediaId/delivery",
    async (request, reply) => {
      const adapter = await getDeliveryAdapter();
      const mediaId = validateUuid(request.params.mediaId, "mediaId");
      const contextParams = await prepareRequestContext(request);
      const now = new Date();

      const asset = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
        return tx.media_assets.findFirst({
          where: {
            id: mediaId,
            status: "ACTIVE",
            ...(contextParams.providerKey ? { owner_provider_profile_id: contextParams.providerKey } : {}),
            media_rights: {
              some: {
                status: "ACTIVE",
                effective_from: { lte: now },
                OR: [{ effective_to: null }, { effective_to: { gt: now } }]
              }
            }
          }
        });
      });

      if (!asset) {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Media asset not found or not eligible for delivery."
        });
      }

      try {
        const deliveryResult = await adapter.generateDeliveryUrl({
          mediaId: asset.id,
          storagePath: asset.storage_path,
          mimeType: asset.mime_type
        });

        reply.header("cache-control", "no-store, max-age=0, private");
        reply.header("pragma", "no-cache");

        return reply.status(200).send({
          data: {
            media_id: asset.id,
            content_type: asset.mime_type,
            delivery_url: deliveryResult.deliveryUrl,
            expires_at: deliveryResult.expiresAt
          },
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err: unknown) {
        if (err instanceof StorageDependencyError || (err instanceof Error && err.name === "StorageDependencyError")) {
          throw new HttpProblemError({
            code: "DEPENDENCY_UNAVAILABLE",
            detail: "Media delivery storage dependency is unavailable."
          });
        }
        throw err;
      }
    }
  );
}
