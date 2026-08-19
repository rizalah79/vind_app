import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { parseSessionCookieToken, type SessionStore } from "../auth/session.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { runWithRequestContextV2, type RequestContextV2Params } from "../auth/request-context-v2.js";
import { validateUuid } from "../catalog/validation.js";

export function handleMessagingRpcError(error: unknown, request?: FastifyRequest): never {
  if (request?.log) {
    request.log.error({
      requestId: request.vindRequestId,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      errorCode: (error as any)?.code
    }, "Messaging RPC operation failed");
  }

  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("AUTHENTICATION_REQUIRED")) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: msg
      });
    }
    if (msg.includes("CAPABILITY_DENIED") || msg.includes("permission denied") || msg.includes("42501")) {
      throw new HttpProblemError({
        code: "CAPABILITY_DENIED",
        detail: msg
      });
    }
    if (msg.includes("RESOURCE_NOT_FOUND")) {
      throw new HttpProblemError({
        code: "RESOURCE_NOT_FOUND",
        detail: msg
      });
    }
    if (msg.includes("STATE_CONFLICT") || msg.includes("23505")) {
      throw new HttpProblemError({
        code: "STATE_CONFLICT",
        detail: msg
      });
    }
    if (msg.includes("VALIDATION_FAILED") || msg.includes("22023") || msg.includes("22P02")) {
      throw new HttpProblemError({
        code: "VALIDATION_FAILED",
        detail: msg
      });
    }
  }
  throw error;
}

export function registerConsumerMessagingRoutes(
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

  // 1. GET /api/v1/inquiries/:inquiryId/messages
  app.get<{
    Params: { inquiryId: string };
    Querystring: { limit?: string; before_id?: string };
  }>(
    "/api/v1/inquiries/:inquiryId/messages",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const contextParams = await prepareRequestContext(request);

      const limit = request.query.limit ? Math.min(Math.max(parseInt(request.query.limit, 10), 1), 100) : 50;
      const beforeId = request.query.before_id ? validateUuid(request.query.before_id, "before_id") : null;

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT messaging.list_consumer_messages($1::uuid, $2::int, $3::uuid) as result`,
            inquiryId,
            limit,
            beforeId
          );
        });

        const result = rows[0]?.result ?? [];
        return reply.status(200).send({
          data: result,
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err) {
        handleMessagingRpcError(err, request);
      }
    }
  );

  // 2. POST /api/v1/inquiries/:inquiryId/messages
  app.post<{
    Params: { inquiryId: string };
    Body: {
      body: string;
      attachment_media_asset_ids?: string[];
      idempotency_key?: string;
    };
  }>(
    "/api/v1/inquiries/:inquiryId/messages",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const contextParams = await prepareRequestContext(request);

      const headerIdempotencyKey = request.headers["idempotency-key"] as string | undefined;
      if (!headerIdempotencyKey || typeof headerIdempotencyKey !== "string" || headerIdempotencyKey.trim() === "") {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "Idempotency-Key header is strictly required."
        });
      }
      const effectiveIdempotencyKey = headerIdempotencyKey.trim();

      const bodyText = request.body?.body;
      if (!bodyText || typeof bodyText !== "string" || bodyText.trim() === "") {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "Message body is required and must not be empty."
        });
      }

      let attachmentAssetIds: string[] | null = null;
      if (Array.isArray(request.body?.attachment_media_asset_ids) && request.body.attachment_media_asset_ids.length > 0) {
        attachmentAssetIds = request.body.attachment_media_asset_ids.map((id) => validateUuid(id, "attachment_media_asset_id"));
      }

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT messaging.send_consumer_message($1::uuid, $2, $3::uuid[], $4) as result`,
            inquiryId,
            bodyText,
            attachmentAssetIds,
            effectiveIdempotencyKey
          );
        });

        const result = rows[0]?.result;
        return reply.status(201).send({
          data: result,
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err) {
        handleMessagingRpcError(err, request);
      }
    }
  );

  // 3. POST /api/v1/inquiries/:inquiryId/messages/read
  app.post<{
    Params: { inquiryId: string };
    Body: {
      last_read_message_id?: string;
    };
  }>(
    "/api/v1/inquiries/:inquiryId/messages/read",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const contextParams = await prepareRequestContext(request);

      const lastReadMessageId = request.body?.last_read_message_id
        ? validateUuid(request.body.last_read_message_id, "last_read_message_id")
        : null;

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT messaging.mark_read($1::uuid, $2::uuid, false) as result`,
            inquiryId,
            lastReadMessageId
          );
        });

        const result = rows[0]?.result;
        return reply.status(200).send({
          data: result,
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err) {
        handleMessagingRpcError(err, request);
      }
    }
  );
}
