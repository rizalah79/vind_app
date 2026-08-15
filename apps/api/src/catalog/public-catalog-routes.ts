import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { validateLimit, validateUuid } from "./validation.js";

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
      const providerId = validateUuid(request.params.providerId, "providerId");
      const channel = resolveCanonicalChannel(request.headers.host, channelHostConfig);

      const rows = await dbClient.$queryRaw<Array<{
        provider_id: string;
        display_name: string;
        provider_type: string;
        status: string;
        created_at: Date | string;
      }>>`
        SELECT
          provider_id,
          display_name,
          provider_type,
          status,
          created_at
        FROM provider.read_public_provider(${providerId}::uuid, ${channel.code})
      `;

      const provider = rows[0];

      if (!provider) {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Provider profile not found."
        });
      }

      return reply.status(200).send({
        data: {
          id: provider.provider_id,
          display_name: provider.display_name,
          provider_type: provider.provider_type,
          status: provider.status,
          created_at: new Date(provider.created_at).toISOString()
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
    const limitNum = validateLimit(request.query.limit);
    const providerIdFilter = request.query.provider_id
      ? validateUuid(request.query.provider_id, "provider_id")
      : null;

    const cursorStr = request.query.cursor;
    const cursorPayload = cursorStr !== undefined && cursorStr !== ""
      ? decodeCursor(cursorStr)
      : null;

    const beforeCreatedAt = cursorPayload ? new Date(cursorPayload.createdAt) : null;
    const beforePublicationId = cursorPayload ? cursorPayload.id : null;

    const rows = await dbClient.$queryRaw<Array<{
      publication_id: string;
      provider_id: string;
      offering_id: string | null;
      package_id: string | null;
      channel_code: string;
      publication_status: string;
      title: string;
      description: string | null;
      effective_from: Date | string | null;
      created_at: Date | string;
    }>>`
      SELECT
        publication_id,
        provider_id,
        offering_id,
        package_id,
        channel_code,
        publication_status,
        title,
        description,
        effective_from,
        created_at
      FROM listing.read_public_listings(
        ${channel.code},
        ${providerIdFilter}::uuid,
        ${beforeCreatedAt}::timestamptz,
        ${beforePublicationId}::uuid,
        ${limitNum}
      )
    `;

    const hasMore = rows.length > limitNum;
    const items = hasMore ? rows.slice(0, limitNum) : rows;
    const lastItem = items[items.length - 1];

    const nextCursor = hasMore && lastItem
      ? encodeCursor({
          createdAt: new Date(lastItem.created_at).toISOString(),
          id: lastItem.publication_id
        })
      : null;

    const data = items.map((row) => ({
      id: row.publication_id,
      provider_id: row.provider_id,
      offering_id: row.offering_id ?? null,
      package_id: row.package_id ?? null,
      channel_code: row.channel_code,
      publication_status: row.publication_status,
      title: row.title,
      description: row.description ?? null,
      effective_from: row.effective_from ? new Date(row.effective_from).toISOString() : null,
      created_at: new Date(row.created_at).toISOString()
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
      const publicationId = validateUuid(request.params.publicationId, "publicationId");
      const channel = resolveCanonicalChannel(request.headers.host, channelHostConfig);

      const rows = await dbClient.$queryRaw<Array<{
        publication_id: string;
        provider_id: string;
        provider_display_name: string;
        provider_type: string;
        offering_id: string | null;
        offering_code: string | null;
        offering_title: string | null;
        offering_description: string | null;
        package_id: string | null;
        package_code: string | null;
        package_title: string | null;
        package_anchor_offering_id: string | null;
        channel_code: string;
        publication_status: string;
        effective_from: Date | string | null;
        created_at: Date | string;
      }>>`
        SELECT
          publication_id,
          provider_id,
          provider_display_name,
          provider_type,
          offering_id,
          offering_code,
          offering_title,
          offering_description,
          package_id,
          package_code,
          package_title,
          package_anchor_offering_id,
          channel_code,
          publication_status,
          effective_from,
          created_at
        FROM listing.read_public_listing(
          ${publicationId}::uuid,
          ${channel.code}
        )
      `;

      const publication = rows[0];

      if (!publication) {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Channel publication listing not found."
        });
      }

      return reply.status(200).send({
        data: {
          id: publication.publication_id,
          provider_id: publication.provider_id,
          provider: {
            id: publication.provider_id,
            display_name: publication.provider_display_name,
            provider_type: publication.provider_type
          },
          offering_id: publication.offering_id ?? null,
          offering: publication.offering_id
            ? {
                id: publication.offering_id,
                offering_code: publication.offering_code!,
                title: publication.offering_title!,
                description: publication.offering_description ?? null
              }
            : null,
          package_id: publication.package_id ?? null,
          package: publication.package_id
            ? {
                id: publication.package_id,
                package_code: publication.package_code!,
                title: publication.package_title!,
                anchor_offering_id: publication.package_anchor_offering_id!
              }
            : null,
          channel_code: publication.channel_code,
          publication_status: publication.publication_status,
          effective_from: publication.effective_from ? new Date(publication.effective_from).toISOString() : null,
          created_at: new Date(publication.created_at).toISOString()
        },
        meta: {
          request_id: request.vindRequestId
        }
      });
    }
  );
}
