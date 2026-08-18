import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { parseSessionCookieToken, type SessionStore } from "../auth/session.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { runWithRequestContextV2, type RequestContextV2Params } from "../auth/request-context-v2.js";
import { validateUuid } from "../catalog/validation.js";

function resolveActorScope(context: RequestContextV2Params): { scopeType: string; scopeId: string } {
  if (context.providerKey) {
    return { scopeType: "PROVIDER", scopeId: context.providerKey };
  }
  if (context.workspaceKey) {
    return { scopeType: "WORKSPACE", scopeId: context.workspaceKey };
  }
  if (context.organizationKey) {
    return { scopeType: "ORGANIZATION", scopeId: context.organizationKey };
  }
  if (context.actorPersonKey) {
    return { scopeType: "PERSON", scopeId: context.actorPersonKey };
  }
  // Default fallback if no specific scope key bound
  return { scopeType: "PERSON", scopeId: context.actorAccountKey ?? "" };
}

function handleRpcError(error: unknown): never {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("42501") || msg.includes("ACCESS_DENIED") || msg.includes("permission denied") || msg.includes("Unauthorized")) {
      throw new HttpProblemError({
        code: "CAPABILITY_DENIED",
        detail: "Action denied. Actor lacks required capability (availability.calendar.manage)."
      });
    }
    if (msg.includes("NOT_FOUND") || msg.includes("does not exist")) {
      throw new HttpProblemError({
        code: "RESOURCE_NOT_FOUND",
        detail: "The requested calendar, resource, or block was not found."
      });
    }
    if (msg.includes("CONFLICT") || msg.includes("overlap") || msg.includes("23505")) {
      throw new HttpProblemError({
        code: "STATE_CONFLICT",
        detail: "Availability conflict: overlapping rule or block exists."
      });
    }
    if (msg.includes("INVALID_ARGUMENT") || msg.includes("22023") || msg.includes("22P02")) {
      throw new HttpProblemError({
        code: "VALIDATION_FAILED",
        detail: msg
      });
    }
  }
  throw error;
}

export function registerAuthenticatedAvailabilityRoutes(
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

  // 1. PUT /api/v1/sahabat/resources/:resourceId/calendar
  app.put<{
    Params: { resourceId: string };
    Body: {
      timezone: string;
      default_status?: "AVAILABLE" | "UNAVAILABLE";
      slot_duration_minutes?: number;
      min_advance_notice_hours?: number;
      max_advance_notice_days?: number;
      buffer_minutes?: number;
    };
  }>(
    "/api/v1/sahabat/resources/:resourceId/calendar",
    async (request, reply) => {
      const resourceId = validateUuid(request.params.resourceId, "resourceId");
      const {
        timezone,
        default_status = "AVAILABLE",
        slot_duration_minutes = 60,
        min_advance_notice_hours = 0,
        max_advance_notice_days = 365,
        buffer_minutes = 0
      } = request.body || {};

      if (!timezone || typeof timezone !== "string" || timezone.trim() === "") {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "timezone is required and must be a valid IANA timezone string."
        });
      }

      const contextParams = await prepareRequestContext(request);
      const scope = resolveActorScope(contextParams);

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRaw<Array<{
            id: string;
            resource_id: string;
            timezone: string;
            default_status: string;
            slot_duration_minutes: number;
            min_advance_notice_hours: number;
            max_advance_notice_days: number;
            buffer_minutes: number;
            created_at: Date | string;
            updated_at: Date | string;
          }>>`
            SELECT
              id,
              resource_id,
              timezone,
              default_status,
              slot_duration_minutes,
              min_advance_notice_hours,
              max_advance_notice_days,
              buffer_minutes,
              created_at,
              updated_at
            FROM availability.configure_resource_calendar(
              ${resourceId}::uuid,
              ${timezone.trim()},
              ${default_status},
              ${slot_duration_minutes}::integer,
              ${min_advance_notice_hours}::integer,
              ${max_advance_notice_days}::integer,
              ${buffer_minutes}::integer,
              ${contextParams.actorAccountKey}::text,
              ${contextParams.actorPersonKey}::text,
              ${scope.scopeType},
              ${scope.scopeId}
            )
          `;
        });

        const calendar = rows[0];
        if (!calendar) {
          throw new HttpProblemError({
            code: "RESOURCE_NOT_FOUND",
            detail: "Resource calendar configuration failed."
          });
        }

        return reply.status(200).send({
          data: {
            id: calendar.id,
            resource_id: calendar.resource_id,
            timezone: calendar.timezone,
            default_status: calendar.default_status,
            slot_duration_minutes: Number(calendar.slot_duration_minutes),
            min_advance_notice_hours: Number(calendar.min_advance_notice_hours),
            max_advance_notice_days: Number(calendar.max_advance_notice_days),
            buffer_minutes: Number(calendar.buffer_minutes),
            created_at: new Date(calendar.created_at).toISOString(),
            updated_at: new Date(calendar.updated_at).toISOString()
          },
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err) {
        handleRpcError(err);
      }
    }
  );

  // 2. POST /api/v1/sahabat/calendars/:calendarId/rules
  app.post<{
    Params: { calendarId: string };
    Body: {
      rule_pattern: "AVAILABLE" | "UNAVAILABLE";
      day_of_week: number;
      start_time: string;
      end_time: string;
      effective_from?: string | null;
      effective_to?: string | null;
    };
  }>(
    "/api/v1/sahabat/calendars/:calendarId/rules",
    async (request, reply) => {
      const calendarId = validateUuid(request.params.calendarId, "calendarId");
      const {
        rule_pattern,
        day_of_week,
        start_time,
        end_time,
        effective_from = null,
        effective_to = null
      } = request.body || {};

      if (!rule_pattern || !["AVAILABLE", "UNAVAILABLE"].includes(rule_pattern)) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "rule_pattern must be AVAILABLE or UNAVAILABLE."
        });
      }

      if (typeof day_of_week !== "number" || day_of_week < 0 || day_of_week > 6) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "day_of_week must be an integer between 0 (Sunday) and 6 (Saturday)."
        });
      }

      if (!start_time || !end_time) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "start_time and end_time (HH:MM format) are required."
        });
      }

      const contextParams = await prepareRequestContext(request);
      const scope = resolveActorScope(contextParams);

      const effFrom = effective_from ? new Date(effective_from).toISOString() : null;
      const effTo = effective_to ? new Date(effective_to).toISOString() : null;

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRaw<Array<{
            id: string;
            calendar_id: string;
            rule_pattern: string;
            day_of_week: number;
            start_time: string;
            end_time: string;
            effective_from: Date | string | null;
            effective_to: Date | string | null;
            created_at: Date | string;
          }>>`
            SELECT
              id,
              calendar_id,
              rule_pattern,
              day_of_week,
              start_time,
              end_time,
              effective_from,
              effective_to,
              created_at
            FROM availability.create_calendar_rule(
              ${calendarId}::uuid,
              ${rule_pattern},
              ${day_of_week}::integer,
              ${start_time}::time,
              ${end_time}::time,
              ${effFrom}::timestamptz,
              ${effTo}::timestamptz,
              ${contextParams.actorAccountKey}::text,
              ${contextParams.actorPersonKey}::text,
              ${scope.scopeType},
              ${scope.scopeId}
            )
          `;
        });

        const rule = rows[0];
        if (!rule) {
          throw new HttpProblemError({
            code: "RESOURCE_NOT_FOUND",
            detail: "Calendar rule creation failed."
          });
        }

        return reply.status(201).send({
          data: {
            id: rule.id,
            calendar_id: rule.calendar_id,
            rule_pattern: rule.rule_pattern,
            day_of_week: Number(rule.day_of_week),
            start_time: String(rule.start_time),
            end_time: String(rule.end_time),
            effective_from: rule.effective_from ? new Date(rule.effective_from).toISOString() : null,
            effective_to: rule.effective_to ? new Date(rule.effective_to).toISOString() : null,
            created_at: new Date(rule.created_at).toISOString()
          },
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err) {
        handleRpcError(err);
      }
    }
  );

  // 3. POST /api/v1/sahabat/calendars/:calendarId/blocks
  app.post<{
    Params: { calendarId: string };
    Body: {
      starts_at: string;
      ends_at: string;
      block_status?: "UNAVAILABLE" | "MAINTENANCE" | "CUSTOM";
      title?: string | null;
      private_notes?: string | null;
    };
  }>(
    "/api/v1/sahabat/calendars/:calendarId/blocks",
    async (request, reply) => {
      const calendarId = validateUuid(request.params.calendarId, "calendarId");
      const {
        starts_at,
        ends_at,
        block_status = "UNAVAILABLE",
        title = null,
        private_notes = null
      } = request.body || {};

      if (!starts_at || !ends_at) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "starts_at and ends_at are required date-time strings."
        });
      }

      const startsAt = new Date(starts_at);
      const endsAt = new Date(ends_at);

      if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || startsAt >= endsAt) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "starts_at must be a valid date-time strictly before ends_at."
        });
      }

      const contextParams = await prepareRequestContext(request);
      const scope = resolveActorScope(contextParams);

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRaw<Array<{
            id: string;
            calendar_id: string;
            block_status: string;
            starts_at: Date | string;
            ends_at: Date | string;
            title: string | null;
            private_notes: string | null;
            created_at: Date | string;
          }>>`
            SELECT
              id,
              calendar_id,
              block_status,
              starts_at,
              ends_at,
              title,
              private_notes,
              created_at
            FROM availability.create_calendar_block(
              ${calendarId}::uuid,
              ${startsAt.toISOString()}::timestamptz,
              ${endsAt.toISOString()}::timestamptz,
              ${block_status},
              ${title},
              ${private_notes},
              ${contextParams.actorAccountKey}::text,
              ${contextParams.actorPersonKey}::text,
              ${scope.scopeType},
              ${scope.scopeId}
            )
          `;
        });

        const block = rows[0];
        if (!block) {
          throw new HttpProblemError({
            code: "RESOURCE_NOT_FOUND",
            detail: "Calendar block creation failed."
          });
        }

        return reply.status(201).send({
          data: {
            id: block.id,
            calendar_id: block.calendar_id,
            block_status: block.block_status,
            starts_at: new Date(block.starts_at).toISOString(),
            ends_at: new Date(block.ends_at).toISOString(),
            title: block.title ?? null,
            private_notes: block.private_notes ?? null,
            created_at: new Date(block.created_at).toISOString()
          },
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err) {
        handleRpcError(err);
      }
    }
  );

  // 4. DELETE /api/v1/sahabat/blocks/:blockId
  app.delete<{
    Params: { blockId: string };
  }>(
    "/api/v1/sahabat/blocks/:blockId",
    async (request, reply) => {
      const blockId = validateUuid(request.params.blockId, "blockId");

      const contextParams = await prepareRequestContext(request);
      const scope = resolveActorScope(contextParams);

      try {
        const rows = await runWithRequestContextV2(dbClient, contextParams, async (tx: any) => {
          return tx.$queryRaw<Array<{
            id: string;
            released: boolean;
          }>>`
            SELECT
              id,
              released
            FROM availability.release_calendar_block(
              ${blockId}::uuid,
              ${contextParams.actorAccountKey}::text,
              ${contextParams.actorPersonKey}::text,
              ${scope.scopeType},
              ${scope.scopeId}
            )
          `;
        });

        const result = rows[0];
        if (!result || !result.released) {
          throw new HttpProblemError({
            code: "RESOURCE_NOT_FOUND",
            detail: "Calendar block not found or already released."
          });
        }

        return reply.status(200).send({
          data: {
            id: result.id,
            released: true
          },
          meta: {
            request_id: request.vindRequestId
          }
        });
      } catch (err) {
        handleRpcError(err);
      }
    }
  );
}
