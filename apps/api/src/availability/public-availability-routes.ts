import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "@vind/database";
import { HttpProblemError } from "../errors.js";
import { resolveCanonicalChannel, type ChannelHostConfig } from "../auth/channel.js";
import { validateUuid } from "../catalog/validation.js";

export function registerPublicAvailabilityRoutes(
  app: FastifyInstance,
  options: {
    dbClient: DatabaseClient;
    channelHostConfig: ChannelHostConfig;
  }
): void {
  const { dbClient, channelHostConfig } = options;

  app.get<{
    Params: { resourceId: string };
    Querystring: {
      start_time: string;
      end_time: string;
    };
  }>(
    "/api/v1/public/resources/:resourceId/availability",
    async (request, reply) => {
      const resourceId = validateUuid(request.params.resourceId, "resourceId");
      const channel = resolveCanonicalChannel(request.headers.host, channelHostConfig);

      const startTimeRaw = request.query.start_time;
      const endTimeRaw = request.query.end_time;

      if (!startTimeRaw || !endTimeRaw) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "start_time and end_time query parameters are required."
        });
      }

      const startTime = new Date(startTimeRaw);
      const endTime = new Date(endTimeRaw);

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "start_time and end_time must be valid ISO 8601 date-time strings."
        });
      }

      if (startTime >= endTime) {
        throw new HttpProblemError({
          code: "VALIDATION_FAILED",
          detail: "start_time must be strictly before end_time."
        });
      }

      const rows = await dbClient.$queryRaw<Array<{
        resource_id: string;
        is_available: boolean;
        status: string;
        mode: string;
        resource_timezone: string;
        slots: Array<{
          starts_at: Date | string;
          ends_at: Date | string;
          is_available: boolean;
        }> | null;
      }>>`
        SELECT
          resource_id,
          is_available,
          status,
          mode,
          resource_timezone,
          slots
        FROM availability.read_public_availability(
          ${resourceId}::uuid,
          ${startTime.toISOString()}::timestamptz,
          ${endTime.toISOString()}::timestamptz,
          ${channel.code}
        )
      `;

      const result = rows[0];

      if (!result || result.mode === "HIDDEN") {
        throw new HttpProblemError({
          code: "RESOURCE_NOT_FOUND",
          detail: "Resource availability not found or resource is not published."
        });
      }

      const slots = Array.isArray(result.slots)
        ? result.slots.map((s) => ({
            starts_at: new Date(s.starts_at).toISOString(),
            ends_at: new Date(s.ends_at).toISOString(),
            is_available: Boolean(s.is_available)
          }))
        : [];

      return reply.status(200).send({
        data: {
          resource_id: result.resource_id,
          is_available: result.is_available,
          status: result.status,
          mode: result.mode,
          resource_timezone: result.resource_timezone,
          slots
        },
        meta: {
          request_id: request.vindRequestId
        }
      });
    }
  );
}
