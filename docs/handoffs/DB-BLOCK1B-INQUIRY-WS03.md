# DB HANDOFF: STAGE 1 BLOCK 1B — INQUIRY CORE

**Status**: DB Stage B Completed & Acceptance Passed  
**Branch**: `feature/ws02-block1b-inquiry-core`  
**Migration**: `packages/database/prisma/migrations/20260818180000_block1b_inquiry_core/migration.sql`  
**DB Acceptance Test**: `packages/database/src/test-block1b-inquiry.ts`  

---

## 1. Summary of Database Implementation

### Schema & Tables (`engagement` schema)
1. **`engagement.inquiries`**
   - System of record for inquiries across Vindzam & Vindloka.
   - Primary key: `id` (UUID). `public_reference` (e.g. `INQ-20260818-XXXXXX`).
   - Fields: `requester_person_id`, `target_provider_profile_id`, `source_channel` (`VINDZAM` / `VINDLOKA`), `source_channel_publication_id`, `source_offering_id`, `source_resource_id`, `commercial_attribution_reference`, `status` (`NEW` | `ACTIVE` | `CANCELLED` | `CLOSED`), `consent_receipt_id`.
   - Security: RLS & `FORCE ROW LEVEL SECURITY` enabled. Table owner: `vind_db_owner`.
2. **`engagement.inquiry_requirements`**
   - Immutable snapshot of requirements captured at submission time.
   - Trigger `trg_inquiry_requirements_immutable` enforces immutability (rejects `UPDATE` and `DELETE` with `STATE_CONFLICT` error code `22023`).
   - Fields: `inquiry_id`, `requested_start_at`, `requested_end_at`, `requested_location_text`, `requested_geo_region_id`, `quantity`, `consumer_note`, `requirement_payload`, `schema_version`, `offering_snapshot_id`, `resource_snapshot_id`.
3. **`engagement.inquiry_participants`**
   - Explicit participant list governing consumer & provider participant access.
   - Participant types: `CONSUMER`, `PROVIDER`.
4. **`engagement.inquiry_assignments`**
   - Sahabat assignment tracking.
   - Statuses: `ACTIVE`, `REVOKED`.

### Security, Capabilities & RLS
- Capabilities added to `access.capabilities`:
  - `engagement.inquiry.read`: View inquiries.
  - `engagement.inquiry.manage`: Manage inquiry status (activate, cancel, close).
  - `engagement.inquiry.assign`: Assign inquiry to Sahabat PIC.
- Role mappings:
  - Mapped to `OWNER`, `ADMIN`, `OPERATIONS_STAFF`.
  - Excluded from `ACCOUNTING`, `CONTENT_MANAGER`.
- RLS Policies for `vind_app_runtime`:
  - Consumer participant: `requester_person_id = engagement.current_person_id()` or active `inquiry_participants` record.
  - Sahabat local authority: `access.has_local_capability('engagement.inquiry.read', ...)` or active `inquiry_assignments`.

### Security Definer RPC Surface
1. `engagement.submit_inquiry(...)`: Submit new inquiry with idempotency validation (`integration.idempotency_keys`), target eligibility validation (`listing.channel_publications`), participant creation, zero consumer-note audit logging (`audit.audit_events`), and outbox event emission (`integration.outbox_events`).
2. `engagement.activate_inquiry(p_inquiry_id)`: Transition `NEW` -> `ACTIVE` by authorized Sahabat staff.
3. `engagement.assign_inquiry(...)`: Assign/reassign inquiry to Sahabat person. Revokes active assignment.
4. `engagement.cancel_inquiry(...)`: Cancel inquiry (`NEW` or `ACTIVE` -> `CANCELLED`) by consumer or Sahabat.
5. `engagement.close_inquiry(...)`: Close inquiry (`NEW` or `ACTIVE` -> `CLOSED`) by Sahabat.
6. `engagement.read_consumer_inquiry(p_inquiry_id)` & `engagement.list_consumer_inquiries(...)`: Consumer read functions.
7. `engagement.read_sahabat_inquiry(p_inquiry_id)` & `engagement.list_sahabat_inquiries(...)`: Sahabat read functions.

---

## 2. DB Acceptance Results

Disposable acceptance container run (`scratch/run_stage_b_inquiry_acceptance.ts` on port 55433):
- **Migration Zero-to-Head**: 20 migrations applied cleanly.
- **DEC-021 Baseline Seed**: Applied successfully.
- **Inquiry Core Acceptance Matrix (`test-block1b-inquiry.ts`)**: 100% PASS (Structural RLS, Requirement Immutability, Submit & Read, Audit privacy, Activation, Assignment, Close, Terminal state rejection).
- **Regression Suites**: Block 1A Availability (`test-block1a-availability.ts`) & Hardened Session Persistence (`test-session-persistence.ts` 203/203 assertions) PASSED 100%.
- **`npm run db:check`**: Prisma schema validation, code generation, and TypeScript build PASSED cleanly.

---

## 3. WS03 API Implementation Guide (Stage C)

### Consumer Endpoints
- `POST /api/v1/inquiries`: Invoke `engagement.submit_inquiry(...)`. Validate `Idempotency-Key` header.
- `GET /api/v1/inquiries/:inquiryId`: Invoke `engagement.read_consumer_inquiry(...)`.
- `GET /api/v1/inquiries`: Invoke `engagement.list_consumer_inquiries(...)`.
- `POST /api/v1/inquiries/:inquiryId/cancel`: Invoke `engagement.cancel_inquiry(...)`.

### Sahabat Endpoints
- `GET /api/v1/sahabat/inquiries`: Invoke `engagement.list_sahabat_inquiries(...)`.
- `GET /api/v1/sahabat/inquiries/:inquiryId`: Invoke `engagement.read_sahabat_inquiry(...)`.
- `POST /api/v1/sahabat/inquiries/:inquiryId/activate`: Invoke `engagement.activate_inquiry(...)`.
- `POST /api/v1/sahabat/inquiries/:inquiryId/assign`: Invoke `engagement.assign_inquiry(...)`.
- `POST /api/v1/sahabat/inquiries/:inquiryId/close`: Invoke `engagement.close_inquiry(...)`.
