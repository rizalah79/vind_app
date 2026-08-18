-- Migration 20260818140000_block1a_availability_calendar_core
-- Stage 1 Block 1A Availability Core Tables, Security, and Functions

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';

-- ============================================================================
-- 1. AVAILABILITY DOMAIN TABLES
-- ============================================================================

CREATE TABLE availability.resource_calendars (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    resource_id uuid NOT NULL UNIQUE REFERENCES catalog.resources(id) ON DELETE RESTRICT,
    timezone text NOT NULL DEFAULT 'Asia/Jakarta',
    presentation_mode text NOT NULL DEFAULT 'CALENDAR',
    status text NOT NULL DEFAULT 'ACTIVE',
    retention_class_code text NOT NULL DEFAULT 'OPS' REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_calendar_presentation_mode CHECK (presentation_mode IN ('HIDDEN', 'STATUS_ONLY', 'CALENDAR')),
    CONSTRAINT chk_calendar_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED'))
);

CREATE TABLE availability.calendar_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    calendar_id uuid NOT NULL REFERENCES availability.resource_calendars(id) ON DELETE CASCADE,
    day_of_week integer NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    effective_from timestamptz,
    effective_to timestamptz,
    available_capacity integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_rule_dow CHECK (day_of_week BETWEEN 0 AND 6),
    CONSTRAINT chk_rule_time_range CHECK (start_time < end_time),
    CONSTRAINT chk_rule_capacity CHECK (available_capacity >= 1),
    CONSTRAINT chk_rule_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
    CONSTRAINT chk_rule_effective_period CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_from <= effective_to)
);

CREATE TABLE availability.calendar_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    calendar_id uuid NOT NULL REFERENCES availability.resource_calendars(id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    block_category text NOT NULL DEFAULT 'MAINTENANCE',
    internal_reason text,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_by_person_id uuid REFERENCES party.persons(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_block_time_range CHECK (starts_at < ends_at),
    CONSTRAINT chk_block_category CHECK (block_category IN ('MAINTENANCE', 'UNAVAILABLE', 'OTHER', 'PROVIDER_BLACKOUT')),
    CONSTRAINT chk_block_status CHECK (status IN ('ACTIVE', 'RELEASED', 'DEACTIVATED'))
);

-- Indices
CREATE INDEX idx_calendar_rules_calendar_dow ON availability.calendar_rules(calendar_id, day_of_week, status);
CREATE INDEX idx_calendar_blocks_calendar_range ON availability.calendar_blocks(calendar_id, starts_at, ends_at, status);

-- ============================================================================
-- 2. CAPABILITIES & ROLE MAPPINGS
-- ============================================================================

INSERT INTO access.capabilities (code, domain_code, action_code, description, is_sensitive, is_active)
VALUES
  ('availability.calendar.read', 'availability', 'calendar.read', 'Authority to view availability calendar', false, true),
  ('availability.calendar.manage', 'availability', 'calendar.manage', 'Authority to configure and manage availability calendar', true, true)
ON CONFLICT (code) DO UPDATE SET is_active = true;

INSERT INTO access.role_capabilities (role_code, capability_code, effect)
VALUES
  ('OWNER', 'availability.calendar.read', 'ALLOW'),
  ('OWNER', 'availability.calendar.manage', 'ALLOW'),
  ('ADMIN', 'availability.calendar.read', 'ALLOW'),
  ('ADMIN', 'availability.calendar.manage', 'ALLOW'),
  ('OPERATIONS_STAFF', 'availability.calendar.read', 'ALLOW'),
  ('OPERATIONS_STAFF', 'availability.calendar.manage', 'ALLOW'),
  ('CONTENT_MANAGER', 'availability.calendar.read', 'ALLOW')
ON CONFLICT (role_code, capability_code) DO UPDATE SET effect = 'ALLOW';

-- Delete any unauthorized capabilities from ACCOUNTING or other roles
DELETE FROM access.role_capabilities
WHERE role_code = 'ACCOUNTING' AND capability_code IN ('availability.calendar.read', 'availability.calendar.manage');
DELETE FROM access.role_capabilities
WHERE role_code = 'CONTENT_MANAGER' AND capability_code = 'availability.calendar.manage';

-- ============================================================================
-- 3. RLS & OWNER PRIVILEGES
-- ============================================================================

ALTER TABLE availability.resource_calendars OWNER TO vind_db_owner;
ALTER TABLE availability.calendar_rules OWNER TO vind_db_owner;
ALTER TABLE availability.calendar_blocks OWNER TO vind_db_owner;

ALTER TABLE availability.resource_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability.resource_calendars FORCE ROW LEVEL SECURITY;

ALTER TABLE availability.calendar_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability.calendar_rules FORCE ROW LEVEL SECURITY;

ALTER TABLE availability.calendar_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability.calendar_blocks FORCE ROW LEVEL SECURITY;

-- Owner Policies
CREATE POLICY owner_all_resource_calendars ON availability.resource_calendars FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_calendar_rules ON availability.calendar_rules FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_calendar_blocks ON availability.calendar_blocks FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);

-- Runtime Select Policies
CREATE POLICY runtime_resource_calendars_select ON availability.resource_calendars
FOR SELECT TO vind_app_runtime USING (
  EXISTS (
    SELECT 1 FROM catalog.resources r
    WHERE r.id = availability.resource_calendars.resource_id
      AND access.has_local_provider_catalog_read(r.provider_profile_id)
  )
);

CREATE POLICY runtime_calendar_rules_select ON availability.calendar_rules
FOR SELECT TO vind_app_runtime USING (
  EXISTS (
    SELECT 1 FROM availability.resource_calendars c
    JOIN catalog.resources r ON r.id = c.resource_id
    WHERE c.id = availability.calendar_rules.calendar_id
      AND access.has_local_provider_catalog_read(r.provider_profile_id)
  )
);

CREATE POLICY runtime_calendar_blocks_select ON availability.calendar_blocks
FOR SELECT TO vind_app_runtime USING (
  EXISTS (
    SELECT 1 FROM availability.resource_calendars c
    JOIN catalog.resources r ON r.id = c.resource_id
    WHERE c.id = availability.calendar_blocks.calendar_id
      AND access.has_local_provider_catalog_read(r.provider_profile_id)
  )
);

-- Grants
REVOKE ALL ON ALL TABLES IN SCHEMA availability FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA availability FROM vind_importer;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA availability TO vind_db_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA availability TO vind_app_runtime;

-- ============================================================================
-- 4. TIMEZONE VALIDATION HELPER
-- ============================================================================

CREATE OR REPLACE FUNCTION availability.is_valid_timezone(p_tz text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM pg_timezone_names WHERE name = p_tz
    );
$function$;

ALTER FUNCTION availability.is_valid_timezone(text) OWNER TO vind_db_owner;
REVOKE ALL ON FUNCTION availability.is_valid_timezone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION availability.is_valid_timezone(text) TO vind_app_runtime;

-- ============================================================================
-- 5. PUBLIC AVAILABILITY READ FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION availability.read_public_availability(
    p_target_id uuid,
    p_channel_code text,
    p_from timestamptz,
    p_to timestamptz
)
RETURNS TABLE (
    target_id uuid,
    presentation_mode text,
    timezone text,
    range_start timestamptz,
    range_end timestamptz,
    status text,
    generated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
    v_at timestamptz := statement_timestamp();
    v_channel_id uuid;
    v_resource_id uuid;
    v_calendar_id uuid;
    v_tz text;
    v_pres_mode text;
    v_cal_status text;
    v_has_rules boolean := false;
    v_has_blocks boolean := false;
    v_rule_rec RECORD;
    v_curr_day date;
    v_start_day date;
    v_end_day date;
    v_rule_start timestamptz;
    v_rule_end timestamptz;
    v_is_blocked boolean;
BEGIN
    -- Validate inputs
    IF p_channel_code IS NULL OR btrim(p_channel_code) = '' THEN
        RAISE EXCEPTION 'Canonical channel code is required.' USING ERRCODE = '22023';
    END IF;
    IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
        RAISE EXCEPTION 'Valid range_start < range_end is required.' USING ERRCODE = '22023';
    END IF;
    IF p_to - p_from > INTERVAL '90 days' THEN
        RAISE EXCEPTION 'Requested range cannot exceed 90 days.' USING ERRCODE = '22023';
    END IF;

    -- Confirm active channel
    SELECT ch.id INTO v_channel_id
    FROM listing.channels ch
    WHERE ch.code = p_channel_code AND ch.status = 'ACTIVE';

    IF v_channel_id IS NULL THEN
        RETURN;
    END IF;

    -- Resolve canonical resource ID and verify publication eligibility
    -- Case A: p_target_id is a publication_id
    SELECT r.id INTO v_resource_id
    FROM listing.channel_publications cp
    JOIN listing.channels ch ON ch.id = cp.channel_id
    JOIN provider.provider_profiles pr ON pr.id = cp.provider_profile_id
    JOIN catalog.offerings o ON o.id = cp.offering_id
    JOIN catalog.offering_resources os ON os.offering_id = o.id
    JOIN catalog.resources r ON r.id = os.resource_id
    WHERE cp.id = p_target_id
      AND cp.channel_id = v_channel_id
      AND cp.channel_code = p_channel_code
      AND ch.status = 'ACTIVE'
      AND cp.publication_status = 'PUBLISHED'
      AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
      AND (cp.effective_to IS NULL OR cp.effective_to > v_at)
      AND pr.status = 'ACTIVE'
      AND o.status = 'ACTIVE'
      AND r.status = 'ACTIVE'
    LIMIT 1;

    -- Case B: p_target_id is direct resource_id
    IF v_resource_id IS NULL THEN
        SELECT r.id INTO v_resource_id
        FROM catalog.resources r
        JOIN catalog.offering_resources os ON os.resource_id = r.id
        JOIN catalog.offerings o ON o.id = os.offering_id
        JOIN listing.channel_publications cp ON cp.offering_id = o.id
        JOIN listing.channels ch ON ch.id = cp.channel_id
        JOIN provider.provider_profiles pr ON pr.id = cp.provider_profile_id
        WHERE r.id = p_target_id
          AND cp.channel_id = v_channel_id
          AND cp.channel_code = p_channel_code
          AND ch.status = 'ACTIVE'
          AND cp.publication_status = 'PUBLISHED'
          AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
          AND (cp.effective_to IS NULL OR cp.effective_to > v_at)
          AND pr.status = 'ACTIVE'
          AND o.status = 'ACTIVE'
          AND r.status = 'ACTIVE'
        LIMIT 1;
    END IF;

    -- Fail closed if resource is not publication-eligible for the channel
    IF v_resource_id IS NULL THEN
        RETURN;
    END IF;

    -- Resolve resource calendar
    SELECT c.id, c.timezone, c.presentation_mode, c.status
    INTO v_calendar_id, v_tz, v_pres_mode, v_cal_status
    FROM availability.resource_calendars c
    WHERE c.resource_id = v_resource_id;

    -- If no calendar or inactive calendar or HIDDEN mode
    IF v_calendar_id IS NULL OR v_cal_status <> 'ACTIVE' OR v_pres_mode = 'HIDDEN' THEN
        IF v_pres_mode = 'STATUS_ONLY' THEN
            target_id := p_target_id;
            presentation_mode := v_pres_mode;
            timezone := COALESCE(v_tz, 'UTC');
            range_start := p_from;
            range_end := p_to;
            status := 'UNAVAILABLE';
            generated_at := v_at;
            RETURN NEXT;
        END IF;
        RETURN;
    END IF;

    -- STATUS_ONLY mode
    IF v_pres_mode = 'STATUS_ONLY' THEN
        SELECT EXISTS (
            SELECT 1 FROM availability.calendar_blocks b
            WHERE b.calendar_id = v_calendar_id
              AND b.status = 'ACTIVE'
              AND b.starts_at <= p_from
              AND b.ends_at >= p_to
        ) INTO v_has_blocks;

        target_id := p_target_id;
        presentation_mode := v_pres_mode;
        timezone := v_tz;
        range_start := p_from;
        range_end := p_to;
        status := CASE WHEN v_has_blocks THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END;
        generated_at := v_at;
        RETURN NEXT;
        RETURN;
    END IF;

    -- CALENDAR mode: Evaluate rules and blocks
    v_start_day := (p_from AT TIME ZONE v_tz)::date;
    v_end_day := (p_to AT TIME ZONE v_tz)::date;

    FOR v_curr_day IN SELECT d::date FROM generate_series(v_start_day, v_end_day, '1 day'::interval) d LOOP
        FOR v_rule_rec IN
            SELECT cr.day_of_week, cr.start_time, cr.end_time, cr.available_capacity
            FROM availability.calendar_rules cr
            WHERE cr.calendar_id = v_calendar_id
              AND cr.status = 'ACTIVE'
              AND cr.day_of_week = EXTRACT(DOW FROM v_curr_day)::integer
              AND (cr.effective_from IS NULL OR cr.effective_from <= (v_curr_day + cr.end_time) AT TIME ZONE v_tz)
              AND (cr.effective_to IS NULL OR cr.effective_to > (v_curr_day + cr.start_time) AT TIME ZONE v_tz)
        LOOP
            v_has_rules := true;
            v_rule_start := (v_curr_day + v_rule_rec.start_time) AT TIME ZONE v_tz;
            v_rule_end := (v_curr_day + v_rule_rec.end_time) AT TIME ZONE v_tz;

            -- Bound by requested query range
            IF v_rule_start < p_from THEN v_rule_start := p_from; END IF;
            IF v_rule_end > p_to THEN v_rule_end := p_to; END IF;

            IF v_rule_start < v_rule_end THEN
                SELECT EXISTS (
                    SELECT 1 FROM availability.calendar_blocks b
                    WHERE b.calendar_id = v_calendar_id
                      AND b.status = 'ACTIVE'
                      AND b.starts_at < v_rule_end
                      AND b.ends_at > v_rule_start
                ) INTO v_is_blocked;

                target_id := p_target_id;
                presentation_mode := v_pres_mode;
                timezone := v_tz;
                range_start := v_rule_start;
                range_end := v_rule_end;
                status := CASE WHEN v_is_blocked THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END;
                generated_at := v_at;
                RETURN NEXT;
            END IF;
        END LOOP;
    END LOOP;

    -- Default fail closed: if no rules exist in range, return UNAVAILABLE for full range
    IF NOT v_has_rules THEN
        target_id := p_target_id;
        presentation_mode := v_pres_mode;
        timezone := v_tz;
        range_start := p_from;
        range_end := p_to;
        status := 'UNAVAILABLE';
        generated_at := v_at;
        RETURN NEXT;
    END IF;

    RETURN;
END;
$function$;

ALTER FUNCTION availability.read_public_availability(uuid, text, timestamptz, timestamptz) OWNER TO vind_db_owner;
REVOKE ALL ON FUNCTION availability.read_public_availability(uuid, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION availability.read_public_availability(uuid, text, timestamptz, timestamptz) FROM vind_importer;
GRANT EXECUTE ON FUNCTION availability.read_public_availability(uuid, text, timestamptz, timestamptz) TO vind_app_runtime;
ALTER FUNCTION availability.read_public_availability(uuid, text, timestamptz, timestamptz) SET row_security = on;

-- ============================================================================
-- 6. AUTHENTICATED LOCAL MANAGEMENT COMMANDS
-- ============================================================================

-- 6a. Configure Resource Calendar
CREATE OR REPLACE FUNCTION availability.configure_resource_calendar(
    p_resource_id uuid,
    p_timezone text DEFAULT 'Asia/Jakarta',
    p_presentation_mode text DEFAULT 'CALENDAR',
    p_status text DEFAULT 'ACTIVE'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
    v_prov_id uuid;
    v_org_id uuid;
    v_calendar_id uuid;
    v_op text;
    v_auth boolean := false;
BEGIN
    IF security.context_value('context_initialized') <> 'true'
       OR security.context_value('context_version') <> '2'
       OR security.context_value('authority_plane') <> 'LOCAL'
    THEN
        RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: Valid Request Context V2 required.' USING ERRCODE = '28000';
    END IF;

    SELECT r.provider_profile_id INTO v_prov_id
    FROM catalog.resources r
    WHERE r.id = p_resource_id;

    IF v_prov_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Resource does not exist.' USING ERRCODE = '22023';
    END IF;

    SELECT pr.owning_organization_id INTO v_org_id
    FROM provider.provider_profiles pr
    WHERE pr.id = v_prov_id;

    IF access.has_local_capability('availability.calendar.manage', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
       OR access.has_local_capability('availability.calendar.manage', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('availability.calendar.manage', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('availability.calendar.manage', 'PERSON', security.current_actor_person_id(), NULL, NULL, NULL)
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient capability availability.calendar.manage.' USING ERRCODE = '42501';
    END IF;

    IF NOT availability.is_valid_timezone(p_timezone) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Invalid IANA timezone.' USING ERRCODE = '22023';
    END IF;

    PERFORM r.id FROM catalog.resources r WHERE r.id = p_resource_id FOR UPDATE;

    SELECT id INTO v_calendar_id FROM availability.resource_calendars WHERE resource_id = p_resource_id;

    IF v_calendar_id IS NULL THEN
        v_op := 'CREATE';
        INSERT INTO availability.resource_calendars (resource_id, timezone, presentation_mode, status)
        VALUES (p_resource_id, p_timezone, p_presentation_mode, p_status)
        RETURNING id INTO v_calendar_id;
    ELSE
        v_op := 'UPDATE';
        UPDATE availability.resource_calendars
        SET timezone = p_timezone,
            presentation_mode = p_presentation_mode,
            status = p_status,
            updated_at = clock_timestamp()
        WHERE id = v_calendar_id;
    END IF;

    -- Audit Event
    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'AVAILABILITY_CALENDAR_CONFIGURED',
        'calendar.configure',
        security.context_value('actor_account_key'),
        security.context_value('actor_person_key'),
        security.context_value('local_assignment_key'),
        'availability',
        'resource_calendars',
        v_calendar_id::text,
        security.context_value('correlation_id'),
        security.context_value('request_id'),
        jsonb_build_object('calendar_id', v_calendar_id, 'operation', v_op, 'timezone', p_timezone, 'presentation_mode', p_presentation_mode),
        'OPERATIONAL'
    );

    -- Outbox Event
    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'availability:calendar:' || v_calendar_id::text || ':' || extract(epoch from clock_timestamp())::text,
        'availability',
        'resource_calendars',
        v_calendar_id::text,
        1,
        'availability.calendar.configured',
        jsonb_build_object('calendar_id', v_calendar_id, 'resource_id', p_resource_id, 'timezone', p_timezone, 'presentation_mode', p_presentation_mode),
        security.context_value('correlation_id')
    );

    RETURN v_calendar_id;
END;
$function$;

ALTER FUNCTION availability.configure_resource_calendar(uuid, text, text, text) OWNER TO vind_db_owner;
REVOKE ALL ON FUNCTION availability.configure_resource_calendar(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION availability.configure_resource_calendar(uuid, text, text, text) FROM vind_importer;
GRANT EXECUTE ON FUNCTION availability.configure_resource_calendar(uuid, text, text, text) TO vind_app_runtime;
ALTER FUNCTION availability.configure_resource_calendar(uuid, text, text, text) SET row_security = on;

-- 6b. Create Calendar Rule
CREATE OR REPLACE FUNCTION availability.create_calendar_rule(
    p_calendar_id uuid,
    p_day_of_week integer,
    p_start_time time,
    p_end_time time,
    p_available_capacity integer DEFAULT 1,
    p_effective_from timestamptz DEFAULT NULL,
    p_effective_to timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
    v_res_id uuid;
    v_prov_id uuid;
    v_org_id uuid;
    v_rule_id uuid;
    v_auth boolean := false;
BEGIN
    IF security.context_value('context_initialized') <> 'true'
       OR security.context_value('context_version') <> '2'
       OR security.context_value('authority_plane') <> 'LOCAL'
    THEN
        RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: Valid Request Context V2 required.' USING ERRCODE = '28000';
    END IF;

    SELECT c.resource_id INTO v_res_id FROM availability.resource_calendars c WHERE c.id = p_calendar_id;
    IF v_res_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Calendar does not exist.' USING ERRCODE = '22023';
    END IF;

    SELECT r.provider_profile_id INTO v_prov_id FROM catalog.resources r WHERE r.id = v_res_id;
    SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;

    IF access.has_local_capability('availability.calendar.manage', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
       OR access.has_local_capability('availability.calendar.manage', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('availability.calendar.manage', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('availability.calendar.manage', 'PERSON', security.current_actor_person_id(), NULL, NULL, NULL)
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient capability availability.calendar.manage.' USING ERRCODE = '42501';
    END IF;

    IF p_start_time >= p_end_time THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: start_time must be less than end_time.' USING ERRCODE = '22023';
    END IF;

    PERFORM c.id FROM availability.resource_calendars c WHERE c.id = p_calendar_id FOR UPDATE;

    INSERT INTO availability.calendar_rules (
        calendar_id, day_of_week, start_time, end_time, available_capacity, effective_from, effective_to, status
    ) VALUES (
        p_calendar_id, p_day_of_week, p_start_time, p_end_time, p_available_capacity, p_effective_from, p_effective_to, 'ACTIVE'
    ) RETURNING id INTO v_rule_id;

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'AVAILABILITY_RULE_CREATED',
        'rule.create',
        security.context_value('actor_account_key'),
        security.context_value('actor_person_key'),
        security.context_value('local_assignment_key'),
        'availability',
        'calendar_rules',
        v_rule_id::text,
        security.context_value('correlation_id'),
        security.context_value('request_id'),
        jsonb_build_object('rule_id', v_rule_id, 'calendar_id', p_calendar_id, 'day_of_week', p_day_of_week, 'start_time', p_start_time, 'end_time', p_end_time),
        'OPERATIONAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'availability:rule:' || v_rule_id::text || ':' || extract(epoch from clock_timestamp())::text,
        'availability',
        'calendar_rules',
        v_rule_id::text,
        1,
        'availability.rule.created',
        jsonb_build_object('rule_id', v_rule_id, 'calendar_id', p_calendar_id, 'day_of_week', p_day_of_week),
        security.context_value('correlation_id')
    );

    RETURN v_rule_id;
END;
$function$;

ALTER FUNCTION availability.create_calendar_rule(uuid, integer, time, time, integer, timestamptz, timestamptz) OWNER TO vind_db_owner;
REVOKE ALL ON FUNCTION availability.create_calendar_rule(uuid, integer, time, time, integer, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION availability.create_calendar_rule(uuid, integer, time, time, integer, timestamptz, timestamptz) FROM vind_importer;
GRANT EXECUTE ON FUNCTION availability.create_calendar_rule(uuid, integer, time, time, integer, timestamptz, timestamptz) TO vind_app_runtime;
ALTER FUNCTION availability.create_calendar_rule(uuid, integer, time, time, integer, timestamptz, timestamptz) SET row_security = on;

-- 6c. Create Calendar Block (Concurrency-Safe Conflict Prevention)
CREATE OR REPLACE FUNCTION availability.create_calendar_block(
    p_calendar_id uuid,
    p_starts_at timestamptz,
    p_ends_at timestamptz,
    p_block_category text DEFAULT 'MAINTENANCE',
    p_internal_reason text DEFAULT NULL,
    p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
    v_res_id uuid;
    v_prov_id uuid;
    v_org_id uuid;
    v_block_id uuid;
    v_conflict_count integer;
    v_actor_person_id uuid;
    v_existing_idempotency_payload jsonb;
    v_auth boolean := false;
BEGIN
    IF security.context_value('context_initialized') <> 'true'
       OR security.context_value('context_version') <> '2'
       OR security.context_value('authority_plane') <> 'LOCAL'
    THEN
        RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: Valid Request Context V2 required.' USING ERRCODE = '28000';
    END IF;

    SELECT c.resource_id INTO v_res_id FROM availability.resource_calendars c WHERE c.id = p_calendar_id;
    IF v_res_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Calendar does not exist.' USING ERRCODE = '22023';
    END IF;

    SELECT r.provider_profile_id INTO v_prov_id FROM catalog.resources r WHERE r.id = v_res_id;
    SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;

    IF access.has_local_capability('availability.calendar.manage', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
       OR access.has_local_capability('availability.calendar.manage', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('availability.calendar.manage', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('availability.calendar.manage', 'PERSON', security.current_actor_person_id(), NULL, NULL, NULL)
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient capability availability.calendar.manage.' USING ERRCODE = '42501';
    END IF;

    IF p_starts_at >= p_ends_at THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: starts_at must be less than ends_at.' USING ERRCODE = '22023';
    END IF;

    -- Check Idempotency Key
    IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
        SELECT response_body INTO v_existing_idempotency_payload
        FROM integration.idempotency_keys
        WHERE scope = 'availability.create_calendar_block' AND idempotency_key = p_idempotency_key AND status = 'SUCCEEDED';

        IF v_existing_idempotency_payload IS NOT NULL THEN
            RETURN (v_existing_idempotency_payload->>'block_id')::uuid;
        END IF;
    END IF;

    -- Lock resource calendar boundary to guarantee atomic conflict check
    PERFORM c.id FROM availability.resource_calendars c WHERE c.id = p_calendar_id FOR UPDATE;

    -- Conflict check: overlapping active blocks [starts_at, ends_at)
    -- Half-open intervals: adjacent intervals (e.g. 10:00-11:00 and 11:00-12:00) do NOT conflict.
    SELECT COUNT(*) INTO v_conflict_count
    FROM availability.calendar_blocks b
    WHERE b.calendar_id = p_calendar_id
      AND b.status = 'ACTIVE'
      AND b.starts_at < p_ends_at
      AND b.ends_at > p_starts_at;

    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION 'AVAILABILITY_CONFLICT: Requested block conflicts with existing active block.' USING ERRCODE = '23505';
    END IF;

    v_actor_person_id := security.current_actor_person_id();

    INSERT INTO availability.calendar_blocks (
        calendar_id, starts_at, ends_at, block_category, internal_reason, status, created_by_person_id
    ) VALUES (
        p_calendar_id, p_starts_at, p_ends_at, p_block_category, p_internal_reason, 'ACTIVE', v_actor_person_id
    ) RETURNING id INTO v_block_id;

    -- Record idempotency
    IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
        INSERT INTO integration.idempotency_keys (
            scope, idempotency_key, request_hash_sha256, status, response_status_code, response_body, expires_at
        ) VALUES (
            'availability.create_calendar_block',
            p_idempotency_key,
            encode(sha256((p_calendar_id::text || p_starts_at::text || p_ends_at::text)::bytea), 'hex'),
            'SUCCEEDED',
            201,
            jsonb_build_object('block_id', v_block_id),
            clock_timestamp() + interval '24 hours'
        ) ON CONFLICT (scope, idempotency_key) DO NOTHING;
    END IF;

    -- Audit Event
    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'AVAILABILITY_BLOCK_CREATED',
        'block.create',
        security.context_value('actor_account_key'),
        security.context_value('actor_person_key'),
        security.context_value('local_assignment_key'),
        'availability',
        'calendar_blocks',
        v_block_id::text,
        security.context_value('correlation_id'),
        security.context_value('request_id'),
        jsonb_build_object('block_id', v_block_id, 'calendar_id', p_calendar_id, 'starts_at', p_starts_at, 'ends_at', p_ends_at, 'category', p_block_category),
        'OPERATIONAL'
    );

    -- Outbox Event
    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'availability:block:' || v_block_id::text || ':' || extract(epoch from clock_timestamp())::text,
        'availability',
        'calendar_blocks',
        v_block_id::text,
        1,
        'availability.block.created',
        jsonb_build_object('block_id', v_block_id, 'calendar_id', p_calendar_id, 'starts_at', p_starts_at, 'ends_at', p_ends_at),
        security.context_value('correlation_id')
    );

    RETURN v_block_id;
END;
$function$;

ALTER FUNCTION availability.create_calendar_block(uuid, timestamptz, timestamptz, text, text, text) OWNER TO vind_db_owner;
REVOKE ALL ON FUNCTION availability.create_calendar_block(uuid, timestamptz, timestamptz, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION availability.create_calendar_block(uuid, timestamptz, timestamptz, text, text, text) FROM vind_importer;
GRANT EXECUTE ON FUNCTION availability.create_calendar_block(uuid, timestamptz, timestamptz, text, text, text) TO vind_app_runtime;
ALTER FUNCTION availability.create_calendar_block(uuid, timestamptz, timestamptz, text, text, text) SET row_security = on;

-- 6d. Release/Deactivate Calendar Block
CREATE OR REPLACE FUNCTION availability.release_calendar_block(
    p_block_id uuid,
    p_release_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
    v_cal_id uuid;
    v_res_id uuid;
    v_prov_id uuid;
    v_org_id uuid;
    v_auth boolean := false;
BEGIN
    IF security.context_value('context_initialized') <> 'true'
       OR security.context_value('context_version') <> '2'
       OR security.context_value('authority_plane') <> 'LOCAL'
    THEN
        RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: Valid Request Context V2 required.' USING ERRCODE = '28000';
    END IF;

    SELECT b.calendar_id INTO v_cal_id FROM availability.calendar_blocks b WHERE b.id = p_block_id;
    IF v_cal_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Block does not exist.' USING ERRCODE = '22023';
    END IF;

    SELECT c.resource_id INTO v_res_id FROM availability.resource_calendars c WHERE c.id = v_cal_id;
    SELECT r.provider_profile_id INTO v_prov_id FROM catalog.resources r WHERE r.id = v_res_id;
    SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;

    IF access.has_local_capability('availability.calendar.manage', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
       OR access.has_local_capability('availability.calendar.manage', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('availability.calendar.manage', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('availability.calendar.manage', 'PERSON', security.current_actor_person_id(), NULL, NULL, NULL)
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient capability availability.calendar.manage.' USING ERRCODE = '42501';
    END IF;

    UPDATE availability.calendar_blocks
    SET status = 'RELEASED',
        updated_at = clock_timestamp()
    WHERE id = p_block_id;

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'AVAILABILITY_BLOCK_RELEASED',
        'block.release',
        security.context_value('actor_account_key'),
        security.context_value('actor_person_key'),
        security.context_value('local_assignment_key'),
        'availability',
        'calendar_blocks',
        p_block_id::text,
        security.context_value('correlation_id'),
        security.context_value('request_id'),
        jsonb_build_object('block_id', p_block_id, 'calendar_id', v_cal_id, 'reason', p_release_reason),
        'OPERATIONAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'availability:block:' || p_block_id::text || ':released:' || extract(epoch from clock_timestamp())::text,
        'availability',
        'calendar_blocks',
        p_block_id::text,
        1,
        'availability.block.released',
        jsonb_build_object('block_id', p_block_id, 'calendar_id', v_cal_id),
        security.context_value('correlation_id')
    );

    RETURN true;
END;
$function$;

ALTER FUNCTION availability.release_calendar_block(uuid, text) OWNER TO vind_db_owner;
REVOKE ALL ON FUNCTION availability.release_calendar_block(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION availability.release_calendar_block(uuid, text) FROM vind_importer;
GRANT EXECUTE ON FUNCTION availability.release_calendar_block(uuid, text) TO vind_app_runtime;
ALTER FUNCTION availability.release_calendar_block(uuid, text) SET row_security = on;

-- Schema & Table Grants for Runtime & Readonly roles
GRANT USAGE ON SCHEMA availability TO vind_app_runtime;
GRANT USAGE ON SCHEMA availability TO vind_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA availability TO vind_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA availability TO vind_app_runtime;

