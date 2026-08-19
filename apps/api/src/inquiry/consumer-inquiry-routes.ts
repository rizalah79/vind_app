import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { parseSessionCookieToken, type SessionStore } from "../auth/session.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { runWithRequestContextV2, type RequestContextV2Params } from "../auth/request-context-v2.js";
import { validateUuid } from "../catalog/validation.js";

export function handleInquiryRpcError(error: unknown, request?: FastifyRequest): never {
  if (request?.log) {
    request.log.error({
      requestId: request.vindRequestId,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      errorCode: (error as any)?.code
    }, "Inquiry RPC operation failed");
  }

  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("AUTHENTICATION_REQUIRED")) {
      throw new HttpProblemError({
        code: "AUTHENTICATION_REQUIRED",
        detail: msg
      });
    }
    if (msg.includes("FORBIDDEN") || msg.includes("permission denied") || msg.includes("42501")) {
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

export function registerConsumerInquiryRoutes(
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

  // 1. POST /api/v1/inquiries (Submit Inquiry)
  app.post<{
    Body: {
      target_id: string;
      channel_code?: string;
      consent_receipt_id?: string;
      idempotency_key?: string;
      requested_start_at?: string;
      requested_end_at?: string;
      location_text?: string;
      geo_region_id?: string;
      quantity?: number;
      consumer_note?: string;
      requirement_payload?: Record<string, unknown>;
      commercial_ref?: string;
    };
  }>(
    "/api/v1/inquiries",
    async (request, reply) => {
      const contextParams = await prepareRequestContext(request);

      const headerIdempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const {
        target_id,
        channel_code,
        consent_receipt_id,
        idempotency_key,
        requested_start_at,
        requested_end_at,
        location_text,
        geo_region_id,
        quantity = 1,
        consumer_note,
        requirement_payload,
        commercial_ref
      } = request.body || {};

      if (!target_id) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "target_id is required."
        });
      }

      if (!consent_receipt_id) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "consent_receipt_id is required."
        });
      }

      if (channel_code && channel_code !== contextParams.channelCode) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: `Channel code '${channel_code}' in body does not match trusted host channel '${contextParams.channelCode}'.`
        });
      }

      const targetId = validateUuid(target_id, "target_id");
      const effectiveChannelCode = contextParams.channelCode;
      const effectiveIdempotencyKey = headerIdempotencyKey || idempotency_key || null;

      const consentReceiptId = validateUuid(consent_receipt_id, "consent_receipt_id");
      const geoRegionId = geo_region_id ? validateUuid(geo_region_id, "geo_region_id") : null;

      const reqStartAt = requested_start_at ? new Date(requested_start_at) : null;
      const reqEndAt = requested_end_at ? new Date(requested_end_at) : null;

      if (reqStartAt && isNaN(reqStartAt.getTime())) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "requested_start_at must be a valid ISO 8601 date-time string."
        });
      }

      if (reqEndAt && isNaN(reqEndAt.getTime())) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "requested_end_at must be a valid ISO 8601 date-time string."
        });
      }

      if (reqStartAt && reqEndAt && reqStartAt >= reqEndAt) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "requested_start_at must be strictly before requested_end_at."
        });
      }

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.submit_inquiry(
              $1::uuid, $2, $3::uuid, $4, $5::timestamptz, $6::timestamptz, $7, $8::uuid, $9, $10, $11::jsonb, $12
            ) as result`,
            targetId,
            effectiveChannelCode,
            consentReceiptId,
            effectiveIdempotencyKey,
            reqStartAt ? reqStartAt.toISOString() : null,
            reqEndAt ? reqEndAt.toISOString() : null,
            location_text ?? null,
            geoRegionId,
            quantity,
            consumer_note ?? null,
            requirement_payload ? JSON.stringify(requirement_payload) : "{}",
            commercial_ref ?? null
          );
        });

        const result = rows[0]?.result;
        return reply.status(201).send({
          data: result,
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err: any) {
        handleInquiryRpcError(err, request);
      }
    }
  );

  // 2. GET /api/v1/inquiries/:inquiryId (Read Consumer Inquiry)
  app.get<{
    Params: { inquiryId: string };
  }>(
    "/api/v1/inquiries/:inquiryId",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const contextParams = await prepareRequestContext(request);

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.read_consumer_inquiry($1::uuid) as result`,
            inquiryId
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
        handleInquiryRpcError(err, request);
      }
    }
  );

  // 3. GET /api/v1/inquiries (List Consumer Inquiries)
  app.get<{
    Querystring: {
      limit?: number;
      offset?: number;
    };
  }>(
    "/api/v1/inquiries",
    async (request, reply) => {
      const contextParams = await prepareRequestContext(request);
      const limit = Number(request.query.limit) || 20;
      const offset = Number(request.query.offset) || 0;

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.list_consumer_inquiries($1::int, $2::int) as result`,
            limit,
            offset
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
        handleInquiryRpcError(err, request);
      }
    }
  );

  // 4. POST /api/v1/inquiries/:inquiryId/cancel (Cancel Inquiry)
  app.post<{
    Params: { inquiryId: string };
    Body: {
      reason?: string;
    };
  }>(
    "/api/v1/inquiries/:inquiryId/cancel",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const contextParams = await prepareRequestContext(request);
      const { reason } = request.body || {};

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.cancel_inquiry($1::uuid, $2) as result`,
            inquiryId,
            reason ?? null
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
        handleInquiryRpcError(err, request);
      }
    }
  );
}
