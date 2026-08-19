import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { parseSessionCookieToken, type SessionStore } from "../auth/session.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { runWithRequestContextV2, type RequestContextV2Params } from "../auth/request-context-v2.js";
import { validateUuid } from "../catalog/validation.js";
import { handleInquiryRpcError } from "./consumer-inquiry-routes.js";

export function registerSahabatInquiryRoutes(
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

  // 1. GET /api/v1/sahabat/inquiries (List Sahabat Inquiries)
  app.get<{
    Querystring: {
      limit?: number;
      offset?: number;
      provider_profile_id?: string;
    };
  }>(
    "/api/v1/sahabat/inquiries",
    async (request, reply) => {
      const contextParams = await prepareRequestContext(request);
      const limit = Number(request.query.limit) || 20;
      const offset = Number(request.query.offset) || 0;
      const provId = request.query.provider_profile_id ? validateUuid(request.query.provider_profile_id, "provider_profile_id") : null;

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.list_sahabat_inquiries(
              p_provider_profile_id => $1::uuid,
              p_limit => $2::int,
              p_offset => $3::int
            ) as result`,
            provId,
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

  // 2. GET /api/v1/sahabat/inquiries/:inquiryId (Read Sahabat Inquiry)
  app.get<{
    Params: { inquiryId: string };
  }>(
    "/api/v1/sahabat/inquiries/:inquiryId",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const contextParams = await prepareRequestContext(request);

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.read_sahabat_inquiry($1::uuid) as result`,
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

  // 3. POST /api/v1/sahabat/inquiries/:inquiryId/activate (Activate Inquiry)
  app.post<{
    Params: { inquiryId: string };
  }>(
    "/api/v1/sahabat/inquiries/:inquiryId/activate",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const contextParams = await prepareRequestContext(request);

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.activate_inquiry($1::uuid) as result`,
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

  // 4. POST /api/v1/sahabat/inquiries/:inquiryId/assign (Assign Inquiry)
  app.post<{
    Params: { inquiryId: string };
    Body: {
      assigned_person_id: string;
      scoped_assignment_id?: string;
      reason?: string;
    };
  }>(
    "/api/v1/sahabat/inquiries/:inquiryId/assign",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const { assigned_person_id, scoped_assignment_id, reason } = request.body || {};

      if (!assigned_person_id) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "assigned_person_id is required."
        });
      }

      const assignedPersonId = validateUuid(assigned_person_id, "assigned_person_id");
      const scopedAssId = scoped_assignment_id ? validateUuid(scoped_assignment_id, "scoped_assignment_id") : null;
      const contextParams = await prepareRequestContext(request);

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.assign_inquiry($1::uuid, $2::uuid, $3::uuid, $4) as result`,
            inquiryId,
            assignedPersonId,
            scopedAssId,
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

  // 5. POST /api/v1/sahabat/inquiries/:inquiryId/close (Close Inquiry)
  app.post<{
    Params: { inquiryId: string };
    Body: {
      reason?: string;
    };
  }>(
    "/api/v1/sahabat/inquiries/:inquiryId/close",
    async (request, reply) => {
      const inquiryId = validateUuid(request.params.inquiryId, "inquiryId");
      const contextParams = await prepareRequestContext(request);
      const { reason } = request.body || {};

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRawUnsafe<Array<{ result: any }>>(
            `SELECT engagement.close_inquiry($1::uuid, $2) as result`,
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
