# Handoff: Stage 1 Block 1A Availability Core — Database Implementation & Acceptance

- **Date**: 2026-08-18
- **Feature Branch**: `feature/ws02-block1a-availability-calendar-core`
- **Target Branch**: `main`
- **Canonical Base**: `main@894ec746ff1431ead06c4d074b91bb87d88d5e07`

---

## 1. Summary of Changes

### Database Migration
Created `packages/database/prisma/migrations/20260818140000_block1a_availability_calendar_core/migration.sql`:
- **Domain Tables**:
  - `availability.resource_calendars`: Resource timezone, default status, slot duration, min/max advance notice, scheduling buffer minutes.
  - `availability.calendar_rules`: Rule pattern (`AVAILABLE`, `UNAVAILABLE`), day of week, start/end time, effective period.
  - `availability.calendar_blocks`: Manual and internal availability overrides with status (`UNAVAILABLE`, `MAINTENANCE`, `CUSTOM`), start/end timestamps, title, and private notes.
- **Capabilities Registered**:
  - `availability.calendar.read`: OWNER, ADMIN, OPERATIONS_STAFF, CONTENT_MANAGER
  - `availability.calendar.manage`: OWNER, ADMIN, OPERATIONS_STAFF
- **Security & RLS**:
  - `FORCE ROW LEVEL SECURITY` enabled on all 3 tables.
  - `vind_db_owner` set as table owner with full privileges.
  - Runtime SELECT/INSERT/UPDATE/DELETE granted to `vind_app_runtime` subject to RLS policy.
- **Public Reader (SECURITY DEFINER)**:
  - `availability.read_public_availability(p_resource_id, p_start_time, p_end_time, p_requesting_channel)`
  - Enforces `SET row_security = on`.
  - Verifies publication eligibility (`CHANNEL_PARTNER` or direct public channel active publication).
  - Returns `is_available`, `status`, slot range in ISO 8601, and resource IANA timezone.
  - Mode handling: `HIDDEN` (fails publication check), `STATUS_ONLY` (no detailed slots), `CALENDAR` (full slot windows).
  - **Zero Leakage**: Private block reason, private notes, and internal customer identities are NEVER returned in public output.
- **Authenticated Local Commands (SECURITY DEFINER)**:
  - `availability.configure_resource_calendar`
  - `availability.create_calendar_rule`
  - `availability.create_calendar_block`
  - `availability.release_calendar_block`
  - Row locking (`FOR UPDATE` on calendar boundary) prevents concurrent block/rule overlaps.
  - Supports all 4 local capability scopes (`PERSON`, `ORGANIZATION`, `WORKSPACE`, `PROVIDER`).
- **Audit & Outbox**:
  - Real-time side effects written to `audit.audit_events` and `integration.outbox_events`.
  - Idempotency support via `integration.idempotency_keys` SHA256 payload digest matching.

### Prisma Schema
Updated `packages/database/prisma/schema.prisma`:
- Added `"availability"` to datasource `schemas` list.
- Added models `resource_calendars`, `calendar_rules`, `calendar_blocks`.
- Added relation fields on `retention_classes`, `persons`, and `resources`.

---

## 2. Disposable Acceptance Test Results

- **Disposable Container**: `vind_acceptance_block1a_availability` on port `55433`
- **Foundation applied**: `001_database_foundation.sql`
- **Migrations applied**: All 19 migrations (including `20260818140000_block1a_availability_calendar_core`)
- **Seeds applied**: DEC-021 seed & SMK Slice 1/2 seed
- **Test Harness Matrix**:
  - `test-block1a-availability.ts`: **9/9 subtests PASSED (100%)**
    1. `STRUCTURAL`: Schema tables, columns, indexes, foreign keys exist
    2. `TIMEZONE`: Resource IANA timezone persistence & retrieval
    3. `RULE/BLOCK`: Rules and blocks creation, overlap validation, and status evaluation
    4. `RACE/CONFLICT`: Overlapping block conflicts rejected cleanly
    5. `PUBLIC`: Public reader eligibility check, mode enforcement, zero private data leakage
    6. `LOCAL SECURITY`: Scope checks & capability verification (`availability.calendar.manage`)
    7. `EVIDENCE`: Audit and outbox side effects recorded on calendar mutations
  - `test-s1-foundation-access-closure.ts`: **PASSED**
  - `test-dec021`: **65/65 tests PASSED (100%)**
  - `test-session-persistence.ts`: **202/202 assertions PASSED (100%)**

---

## 3. Handoff for STAGE C (API Implementation)

For WS03 (Availability API):
1. **Public Availability Endpoint**:
   - `GET /api/v1/public/resources/:resourceId/availability?start_time=...&end_time=...`
   - Use `availability.read_public_availability` RPC via database client.
2. **Authenticated Sahabat Management Endpoints**:
   - `PUT /api/v1/sahabat/resources/:resourceId/calendar` -> `availability.configure_resource_calendar`
   - `POST /api/v1/sahabat/calendars/:calendarId/rules` -> `availability.create_calendar_rule`
   - `POST /api/v1/sahabat/calendars/:calendarId/blocks` -> `availability.create_calendar_block`
   - `DELETE /api/v1/sahabat/blocks/:blockId` -> `availability.release_calendar_block`
   - Map authenticated session context to RPC parameters (`p_actor_account_id`, `p_actor_person_id`, `p_scope_type`, `p_scope_id`).
