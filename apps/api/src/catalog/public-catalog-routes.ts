import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

export function registerPublicCatalogRoutes(
  app: FastifyInstance,
  options: {
    dbClient: DatabaseClient;
    channelHostConfig: ChannelHostConfig;
  }
): void {
  const { dbClient, channelHostConfig } = options;

  // 1. GET /api/v1/public/providers/:providerId
  app.get<{ Params: { providerId: string } }>(
    "/api/v1/public/providers/:providerId",
    async (request, reply) => {
      const { providerId } = request.params;

      const provider = await dbClient.provider_profiles.findFirst({
        where: {
          id: providerId,
          status: "ACTIVE"
        },
        select: {
          id: true,
          display_name: true,
          provider_type: true,
          status: true,
          created_at: true
        }
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
          provider_type: provider.provider_type,
          status: provider.status,
          created_at: provider.created_at.toISOString()
        },
        meta: {
          request_id: request.vindRequestId
        }
      });
    }
  );

  // 2. GET /api/v1/public/listings
  app.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      provider_id?: string;
    };
  }>("/api/v1/public/listings", async (request, reply) => {
    const channel = resolveCanonicalChannel(request.headers.host, channelHostConfig);
    const limitNum = Math.min(Math.max(Number.parseInt(request.query.limit ?? "10", 10) || 10, 1), 50);
    const cursorStr = request.query.cursor;
    const providerIdFilter = request.query.provider_id;

    let cursorPayload = cursorStr ? decodeCursor(cursorStr) : null;
    const now = new Date();

    const whereCondition: any = {
      channel_code: channel.code,
      publication_status: "PUBLISHED",
      OR: [
        { effective_from: null },
        { effective_from: { lte: now } }
      ],
      AND: [
        {
          OR: [
            { effective_to: null },
            { effective_to: { gt: now } }
          ]
        },
        {
          provider_profiles: {
            status: "ACTIVE"
          }
        }
      ]
    };

    if (providerIdFilter) {
      whereCondition.provider_profile_id = providerIdFilter;
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

    const rows = await dbClient.channel_publications.findMany({
      where: whereCondition,
      orderBy: [
        { created_at: "desc" },
        { id: "desc" }
      ],
      take: limitNum + 1,
      include: {
        offerings: {
          select: {
            id: true,
            title: true,
            description: true
          }
        },
        packages: {
          select: {
            id: true,
            title: true
          }
        }
      }
    });

    const hasMore = rows.length > limitNum;
    const items = hasMore ? rows.slice(0, limitNum) : rows;
    const lastItem = items[items.length - 1];

    const nextCursor = hasMore && lastItem
      ? encodeCursor({ createdAt: lastItem.created_at.toISOString(), id: lastItem.id })
      : null;

    const data = items.map((row) => ({
      id: row.id,
      provider_id: row.provider_profile_id,
      offering_id: row.offering_id ?? null,
      package_id: row.package_id ?? null,
      channel_code: row.channel_code,
      publication_status: row.publication_status,
      title: row.offerings?.title ?? row.packages?.title ?? "Listing",
      description: row.offerings?.description ?? null,
      effective_from: row.effective_from ? row.effective_from.toISOString() : null,
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

  // 3. GET /api/v1/public/listings/:publicationId
  app.get<{ Params: { publicationId: string } }>(
    "/api/v1/public/listings/:publicationId",
    async (request, reply) => {
      const channel = resolveCanonicalChannel(request.headers.host, channelHostConfig);
      const { publicationId } = request.params;
      const now = new Date();

      const publication = await dbClient.channel_publications.findFirst({
        where: {
          id: publicationId,
          channel_code: channel.code,
          publication_status: "PUBLISHED",
          OR: [
            { effective_from: null },
            { effective_from: { lte: now } }
          ],
          AND: [
            {
              OR: [
                { effective_to: null },
                { effective_to: { gt: now } }
              ]
            },
            {
              provider_profiles: {
                status: "ACTIVE"
              }
            }
          ]
        },
        include: {
          provider_profiles: {
            select: {
              id: true,
              display_name: true,
              provider_type: true,
              status: true
            }
          },
          offerings: {
            select: {
              id: true,
              offering_code: true,
              title: true,
              description: true
            }
          },
          packages: {
            select: {
              id: true,
              package_code: true,
              title: true,
              anchor_offering_id: true
            }
          }
        }
      });

      if (!publication || publication.provider_profiles.status !== "ACTIVE") {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Channel publication listing not found."
        });
      }

      return reply.status(200).send({
        data: {
          id: publication.id,
          provider_id: publication.provider_profile_id,
          provider: {
            id: publication.provider_profiles.id,
            display_name: publication.provider_profiles.display_name,
            provider_type: publication.provider_profiles.provider_type
          },
          offering_id: publication.offering_id ?? null,
          offering: publication.offerings
            ? {
                id: publication.offerings.id,
                offering_code: publication.offerings.offering_code,
                title: publication.offerings.title,
                description: publication.offerings.description ?? null
              }
            : null,
          package_id: publication.package_id ?? null,
          package: publication.packages
            ? {
                id: publication.packages.id,
                package_code: publication.packages.package_code,
                title: publication.packages.title,
                anchor_offering_id: publication.packages.anchor_offering_id
              }
            : null,
          channel_code: publication.channel_code,
          publication_status: publication.publication_status,
          effective_from: publication.effective_from ? publication.effective_from.toISOString() : null,
          created_at: publication.created_at.toISOString()
        },
        meta: {
          request_id: request.vindRequestId
        }
      });
    }
  );
}
