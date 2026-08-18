# Stage 1 Block 1A Availability Core — WS03 API & OpenAPI Contracts Handoff

## Summary of Accomplishments

1. **OpenAPI 3.1 Contract Specification (`packages/contracts/src/openapi.ts`)**
   - Added paths for public reading and Sahabat management:
     - `GET /api/v1/public/resources/{resourceId}/availability`
     - `PUT /api/v1/sahabat/resources/{resourceId}/calendar`
     - `POST /api/v1/sahabat/calendars/{calendarId}/rules`
     - `POST /api/v1/sahabat/calendars/{calendarId}/blocks`
     - `DELETE /api/v1/sahabat/blocks/{blockId}`
   - Added schemas for response envelopes and DTOs:
     - `PublicAvailabilityEnvelope`, `PublicAvailability`, `AvailabilitySlot`
     - `ResourceCalendarEnvelope`, `ResourceCalendar`
     - `CalendarRuleEnvelope`, `CalendarRule`
     - `CalendarBlockEnvelope`, `CalendarBlock`
     - `CalendarBlockReleasedEnvelope`, `CalendarBlockReleased`
   - Added assertions to `packages/contracts/src/openapi.test.ts`.

2. **Fastify Route Implementations (`apps/api/src/availability/`)**
   - `public-availability-routes.ts`: `GET /api/v1/public/resources/:resourceId/availability`
     - Resolves canonical channel (`request.headers.host`, `channelHostConfig`).
     - Invokes `availability.read_public_availability(resourceId, start_time, end_time, channel_code)` SECURITY DEFINER RPC.
     - Enforces zero private data leakage (zero private block reason, zero private notes, zero customer identity).
     - Returns 404 `RESOURCE_NOT_FOUND` if mode is `HIDDEN` or resource unpublished.
   - `authenticated-availability-routes.ts`:
     - `PUT /api/v1/sahabat/resources/:resourceId/calendar`: Configures calendar timezone and settings via `availability.configure_resource_calendar` RPC.
     - `POST /api/v1/sahabat/calendars/:calendarId/rules`: Creates recurring rules via `availability.create_calendar_rule` RPC.
     - `POST /api/v1/sahabat/calendars/:calendarId/blocks`: Creates manual/operational blocks via `availability.create_calendar_block` RPC.
     - `DELETE /api/v1/sahabat/blocks/:blockId`: Releases block override via `availability.release_calendar_block` RPC.
     - Uses `runWithRequestContextV2` to set transaction GUCs and enforce capability authorization (`availability.calendar.manage`).
     - Maps PostgreSQL RPC exceptions to clean `HttpProblemError` DTOs (`CAPABILITY_DENIED`, `RESOURCE_NOT_FOUND`, `STATE_CONFLICT`, `VALIDATION_FAILED`).
   - Registered routes in `apps/api/src/app.ts`.

3. **Real PostgreSQL Acceptance & Unit Verification**
   - Unit and acceptance test suite `apps/api/src/availability.test.ts` (9/9 subtests PASSED).
   - Disposable real PostgreSQL 16 container acceptance test:
     - Zero-to-head migration replay (19/19 applied).
     - Baseline seed (`seed-dec021.ts`).
     - DB availability core matrix acceptance (9/9 subtests PASSED).
     - API availability core acceptance (9/9 subtests PASSED).
     - Full disposable container cleanup executed.

4. **Repository Build Verification**
   - `npm run build` across workspace completed cleanly (0 errors).
