import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { parseSessionCookieToken, type SessionStore } from "../auth/session.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { runWithRequestContextV2, type RequestContextV2Params } from "../auth/request-context-v2.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { validateLimit, validateUuid } from "./validation.js";

export function registerAuthenticatedCatalogRoutes(
  app: FastifyInstance,
  options: {
    dbClient: DatabaseClient;
    sessionStore: SessionStore;
    channelHostConfig: ChannelHostConfig;
  }
): void {
  const { dbClient, sessionStore, channelHostConfig } = options;

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

  // 4. GET /api/v1/providers/:providerId
  app.get<{ Params: { providerId: string } }>(
    "/api/v1/providers/:providerId",
    async (request, reply) => {
      const providerId = validateUuid(request.params.providerId, "providerId");
      const contextParams = await prepareRequestContext(request);

      const provider = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
        return tx.provider_profiles.findFirst({
          where: { id: providerId }
        });
      });

      if (!provider) {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Provider profile not found."
        });
      }

      return reply.status(200).send({
        data: {
          id: provider.id,
          display_name: provider.display_name,
          legal_name: provider.legal_name,
          provider_type: provider.provider_type,
          status: provider.status,
          owning_organization_id: provider.owning_organization_id ?? null,
          owning_person_id: provider.owning_person_id ?? null,
          created_at: provider.created_at.toISOString(),
          updated_at: provider.updated_at.toISOString()
        },
        meta: {
          request_id: request.vindRequestId
        }
      });
    }
  );

  // 5. GET /api/v1/providers/:providerId/offerings
  app.get<{
    Params: { providerId: string };
    Querystring: {
      cursor?: string;
      limit?: string;
      status?: string;
    };
  }>("/api/v1/providers/:providerId/offerings", async (request, reply) => {
    const providerId = validateUuid(request.params.providerId, "providerId");
    const limitNum = validateLimit(request.query.limit);
    const statusFilter = request.query.status;

    const cursorStr = request.query.cursor;
    const cursorPayload = cursorStr !== undefined && cursorStr !== ""
      ? decodeCursor(cursorStr)
      : null;

    const contextParams = await prepareRequestContext(request);

    const result = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
      const provider = await tx.provider_profiles.findFirst({
        where: { id: providerId }
      });

      if (!provider) {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Provider profile not found."
        });
      }

      const whereCondition: any = {
        provider_profile_id: providerId,
        AND: []
      };

      if (statusFilter !== undefined && statusFilter !== "") {
        whereCondition.status = statusFilter;
      }

      if (cursorPayload) {
        const cursorDate = new Date(cursorPayload.createdAt);
        whereCondition.AND.push({
          OR: [
            { created_at: { lt: cursorDate } },
            {
              created_at: cursorDate,
              id: { lt: cursorPayload.id }
            }
          ]
        });
      }

      const rows = await tx.offerings.findMany({
        where: whereCondition,
        orderBy: [
          { created_at: "desc" },
          { id: "desc" }
        ],
        take: limitNum + 1
      });

      return rows;
    });

    const hasMore = result.length > limitNum;
    const items = hasMore ? result.slice(0, limitNum) : result;
    const lastItem = items[items.length - 1];

    const nextCursor = hasMore && lastItem
      ? encodeCursor({ createdAt: lastItem.created_at.toISOString(), id: lastItem.id })
      : null;

    const data = items.map((row: any) => ({
      id: row.id,
      provider_profile_id: row.provider_profile_id,
      offering_code: row.offering_code,
      title: row.title,
      description: row.description ?? null,
      status: row.status,
      created_at: row.created_at.toISOString()
    }));

    return reply.status(200).send({
      data,
      meta: {
        request_id: request.vindRequestId,
        pagination: {
          next_cursor: nextCursor,
          has_more: hasMore
        }
      }
    });
  });

  // 6. GET /api/v1/catalog/offerings/:offeringId
  app.get<{ Params: { offeringId: string } }>(
    "/api/v1/catalog/offerings/:offeringId",
    async (request, reply) => {
      const offeringId = validateUuid(request.params.offeringId, "offeringId");
      const contextParams = await prepareRequestContext(request);

      const offering = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
        return tx.offerings.findFirst({
          where: { id: offeringId },
          include: {
            offering_resources: {
              include: {
                resources: true
              }
            }
          }
        });
      });

      if (!offering) {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Offering not found."
        });
      }

      const resources = (offering.offering_resources || []).map((item: any) => ({
        resource_id: item.resources.id,
        resource_code: item.resources.resource_code,
        title: item.resources.title,
        resource_type: item.resources.resource_type,
        quantity: item.quantity
      }));

      return reply.status(200).send({
        data: {
          id: offering.id,
          provider_profile_id: offering.provider_profile_id,
          offering_code: offering.offering_code,
          title: offering.title,
          description: offering.description ?? null,
          status: offering.status,
          resources,
          created_at: offering.created_at.toISOString(),
          updated_at: offering.updated_at.toISOString()
        },
        meta: {
          request_id: request.vindRequestId
        }
      });
    }
  );

  // 7. GET /api/v1/catalog/packages/:packageId
  app.get<{ Params: { packageId: string } }>(
    "/api/v1/catalog/packages/:packageId",
    async (request, reply) => {
      const packageId = validateUuid(request.params.packageId, "packageId");
      const contextParams = await prepareRequestContext(request);

      const pkg = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
        return tx.packages.findFirst({
          where: { id: packageId },
          include: {
            package_items: {
              include: {
                offerings: true
              }
            }
          }
        });
      });

      if (!pkg) {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Package not found."
        });
      }

      const items = (pkg.package_items || []).map((item: any) => ({
        offering_id: item.offerings.id,
        offering_code: item.offerings.offering_code,
        title: item.offerings.title,
        quantity: item.quantity,
        is_optional: item.is_optional
      }));

      return reply.status(200).send({
        data: {
          id: pkg.id,
          provider_profile_id: pkg.provider_profile_id,
          package_code: pkg.package_code,
          title: pkg.title,
          anchor_offering_id: pkg.anchor_offering_id,
          status: pkg.status,
          items,
          created_at: pkg.created_at.toISOString(),
          updated_at: pkg.updated_at.toISOString()
        },
        meta: {
          request_id: request.vindRequestId
        }
      });
    }
  );
}
