-- Stage 1 Block 1B — Engagement Inquiry Core Schema & RPC Migration

CREATE SCHEMA IF NOT EXISTS engagement;

-- 1. engagement.inquiries
CREATE TABLE engagement.inquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_reference VARCHAR(64) NOT NULL UNIQUE,
    requester_person_id UUID NOT NULL REFERENCES party.persons(id),
    target_provider_profile_id UUID NOT NULL REFERENCES provider.provider_profiles(id),
    source_channel VARCHAR(64) NOT NULL,
    source_channel_publication_id UUID REFERENCES listing.channel_publications(id),
    source_offering_id UUID REFERENCES catalog.offerings(id),
    source_resource_id UUID REFERENCES catalog.resources(id),
    commercial_attribution_reference VARCHAR(255),
    status VARCHAR(32) NOT NULL DEFAULT 'NEW',
    consent_receipt_id UUID REFERENCES privacy.consent_receipts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    activated_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    CONSTRAINT chk_inquiry_status CHECK (status IN ('NEW', 'ACTIVE', 'CANCELLED', 'CLOSED'))
);

CREATE INDEX idx_inquiries_requester ON engagement.inquiries(requester_person_id, status);
CREATE INDEX idx_inquiries_provider ON engagement.inquiries(target_provider_profile_id, status);
CREATE INDEX idx_inquiries_publication ON engagement.inquiries(source_channel_publication_id);
CREATE INDEX idx_inquiries_public_ref ON engagement.inquiries(public_reference);

-- 2. engagement.inquiry_requirements
CREATE TABLE engagement.inquiry_requirements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id UUID NOT NULL REFERENCES engagement.inquiries(id) ON DELETE CASCADE,
    requested_start_at TIMESTAMPTZ,
    requested_end_at TIMESTAMPTZ,
    requested_location_text TEXT,
    requested_geo_region_id UUID REFERENCES geo.regions(id),
    quantity INT,
    consumer_note TEXT,
    requirement_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    schema_version VARCHAR(32) NOT NULL DEFAULT 'v1',
    offering_snapshot_id UUID REFERENCES catalog.offerings(id),
    resource_snapshot_id UUID REFERENCES catalog.resources(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_inquiry_req_inquiry ON engagement.inquiry_requirements(inquiry_id);

-- Immutability enforcement trigger for inquiry_requirements
CREATE OR REPLACE FUNCTION engagement.enforce_inquiry_requirements_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'STATE_CONFLICT: inquiry_requirements snapshot is immutable.' USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF COALESCE(current_setting('engagement.allow_requirement_delete', true), 'off') <> 'on' THEN
            RAISE EXCEPTION 'STATE_CONFLICT: inquiry_requirements snapshot is immutable and cannot be deleted.' USING ERRCODE = '22023';
        END IF;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inquiry_requirements_immutable
BEFORE UPDATE OR DELETE ON engagement.inquiry_requirements
FOR EACH ROW EXECUTE FUNCTION engagement.enforce_inquiry_requirements_immutability();

-- Helper to resolve current actor person ID
CREATE OR REPLACE FUNCTION engagement.current_person_id()
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_val TEXT;
BEGIN
    v_id := security.current_actor_person_id();
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;
    
    v_val := security.context_value('actor_person_id');
    IF v_val IS NOT NULL AND v_val <> '' THEN
        BEGIN
            RETURN v_val::uuid;
        EXCEPTION WHEN OTHERS THEN
            RETURN NULL;
        END;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- 3. engagement.inquiry_participants
CREATE TABLE engagement.inquiry_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id UUID NOT NULL REFERENCES engagement.inquiries(id) ON DELETE CASCADE,
    participant_type VARCHAR(32) NOT NULL,
    person_id UUID REFERENCES party.persons(id),
    provider_profile_id UUID REFERENCES provider.provider_profiles(id),
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_participant_type CHECK (participant_type IN ('CONSUMER', 'PROVIDER', 'PLATFORM')),
    CONSTRAINT chk_participant_status CHECK (status IN ('ACTIVE', 'REMOVED'))
);

CREATE UNIQUE INDEX idx_inquiry_participants_unique ON engagement.inquiry_participants (
    inquiry_id,
    participant_type,
    COALESCE(person_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(provider_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE INDEX idx_inquiry_participants_person ON engagement.inquiry_participants(person_id, status);
CREATE INDEX idx_inquiry_participants_provider ON engagement.inquiry_participants(provider_profile_id, status);

-- 4. engagement.inquiry_assignments
CREATE TABLE engagement.inquiry_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id UUID NOT NULL REFERENCES engagement.inquiries(id) ON DELETE CASCADE,
    assigned_scoped_assignment_id UUID REFERENCES access.scoped_assignments(id),
    assigned_person_id UUID REFERENCES party.persons(id),
    provider_profile_id UUID NOT NULL REFERENCES provider.provider_profiles(id),
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    revoked_at TIMESTAMPTZ,
    assigned_by_person_id UUID REFERENCES party.persons(id),
    assignment_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_assignment_status CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED'))
);

CREATE INDEX idx_inquiry_assignments_inquiry ON engagement.inquiry_assignments(inquiry_id, status);
CREATE INDEX idx_inquiry_assignments_person ON engagement.inquiry_assignments(assigned_person_id, status);

-- Capabilities and Role Mappings
INSERT INTO access.capabilities (code, domain_code, action_code, description, is_sensitive, is_active)
VALUES
  ('engagement.inquiry.read', 'engagement', 'inquiry.read', 'Authority to view inquiry cases', false, true),
  ('engagement.inquiry.manage', 'engagement', 'inquiry.manage', 'Authority to manage inquiry cases and state transitions', true, true),
  ('engagement.inquiry.assign', 'engagement', 'inquiry.assign', 'Authority to assign inquiry cases', true, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO access.role_capabilities (role_code, capability_code)
VALUES
  ('OWNER', 'engagement.inquiry.read'),
  ('OWNER', 'engagement.inquiry.manage'),
  ('OWNER', 'engagement.inquiry.assign'),
  ('ADMIN', 'engagement.inquiry.read'),
  ('ADMIN', 'engagement.inquiry.manage'),
  ('ADMIN', 'engagement.inquiry.assign'),
  ('OPERATIONS_STAFF', 'engagement.inquiry.read'),
  ('OPERATIONS_STAFF', 'engagement.inquiry.manage'),
  ('OPERATIONS_STAFF', 'engagement.inquiry.assign')
ON CONFLICT (role_code, capability_code) DO NOTHING;

DELETE FROM access.role_capabilities
WHERE role_code IN ('ACCOUNTING', 'CONTENT_MANAGER') 
  AND capability_code IN ('engagement.inquiry.read', 'engagement.inquiry.manage', 'engagement.inquiry.assign');

-- Table Ownership
ALTER TABLE engagement.inquiries OWNER TO vind_db_owner;
ALTER TABLE engagement.inquiry_requirements OWNER TO vind_db_owner;
ALTER TABLE engagement.inquiry_participants OWNER TO vind_db_owner;
ALTER TABLE engagement.inquiry_assignments OWNER TO vind_db_owner;

-- RLS & FORCE RLS
ALTER TABLE engagement.inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.inquiries FORCE ROW LEVEL SECURITY;

ALTER TABLE engagement.inquiry_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.inquiry_requirements FORCE ROW LEVEL SECURITY;

ALTER TABLE engagement.inquiry_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.inquiry_participants FORCE ROW LEVEL SECURITY;

ALTER TABLE engagement.inquiry_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.inquiry_assignments FORCE ROW LEVEL SECURITY;

-- Owner Policies
CREATE POLICY owner_all_inquiries ON engagement.inquiries FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_inquiry_requirements ON engagement.inquiry_requirements FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_inquiry_participants ON engagement.inquiry_participants FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_inquiry_assignments ON engagement.inquiry_assignments FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);

-- Runtime SELECT Policies
CREATE POLICY runtime_inquiries_select ON engagement.inquiries
    FOR SELECT TO vind_app_runtime
    USING (
        -- Consumer participant
        requester_person_id = engagement.current_person_id()
        OR EXISTS (
            SELECT 1 FROM engagement.inquiry_participants p
            WHERE p.inquiry_id = engagement.inquiries.id
              AND p.participant_type = 'CONSUMER'
              AND p.person_id = engagement.current_person_id()
              AND p.status = 'ACTIVE'
        )
        -- Sahabat provider access
        OR access.has_local_capability('engagement.inquiry.read', 'PROVIDER', NULL, target_provider_profile_id, NULL, target_provider_profile_id)
        OR access.has_local_capability('engagement.inquiry.read', 'ORGANIZATION', NULL, 
            (SELECT pr.owning_organization_id FROM provider.provider_profiles pr WHERE pr.id = target_provider_profile_id), NULL, NULL)
        OR EXISTS (
            SELECT 1 FROM engagement.inquiry_assignments a
            WHERE a.inquiry_id = engagement.inquiries.id
              AND a.assigned_person_id = engagement.current_person_id()
              AND a.status = 'ACTIVE'
        )
    );

CREATE POLICY runtime_inquiry_requirements_select ON engagement.inquiry_requirements
    FOR SELECT TO vind_app_runtime
    USING (
        EXISTS (
            SELECT 1 FROM engagement.inquiries i
            WHERE i.id = engagement.inquiry_requirements.inquiry_id
        )
    );

CREATE POLICY runtime_inquiry_participants_select ON engagement.inquiry_participants
    FOR SELECT TO vind_app_runtime
    USING (
        EXISTS (
            SELECT 1 FROM engagement.inquiries i
            WHERE i.id = engagement.inquiry_participants.inquiry_id
        )
    );

CREATE POLICY runtime_inquiry_assignments_select ON engagement.inquiry_assignments
    FOR SELECT TO vind_app_runtime
    USING (
        EXISTS (
            SELECT 1 FROM engagement.inquiries i
            WHERE i.id = engagement.inquiry_assignments.inquiry_id
        )
    );

-- Schema Grants
GRANT USAGE ON SCHEMA engagement TO vind_app_runtime, vind_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA engagement TO vind_app_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA engagement TO vind_readonly;

-- ============================================================================
-- SECURITY DEFINER COMMAND RPCs
-- ============================================================================

-- 1. SUBMIT_INQUIRY
CREATE OR REPLACE FUNCTION engagement.submit_inquiry(
    p_target_id UUID,
    p_channel_code VARCHAR,
    p_consent_receipt_id UUID,
    p_idempotency_key VARCHAR,
    p_requested_start_at TIMESTAMPTZ DEFAULT NULL,
    p_requested_end_at TIMESTAMPTZ DEFAULT NULL,
    p_location_text TEXT DEFAULT NULL,
    p_geo_region_id UUID DEFAULT NULL,
    p_quantity INT DEFAULT NULL,
    p_consumer_note TEXT DEFAULT NULL,
    p_requirement_payload JSONB DEFAULT '{}'::jsonb,
    p_commercial_ref VARCHAR DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_actor_person_id UUID;
    v_target_pub_id UUID;
    v_target_offering_id UUID;
    v_target_resource_id UUID;
    v_provider_profile_id UUID;
    v_channel_id UUID;
    v_inquiry_id UUID;
    v_public_ref VARCHAR(64);
    v_payload_hash VARCHAR(64);
    v_idempotency_record RECORD;
    v_result JSONB;
    v_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    v_actor_person_id := engagement.current_person_id();
    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: Valid authenticated consumer required to submit inquiry.' USING ERRCODE = '42501';
    END IF;

    -- Validate channel
    SELECT c.id INTO v_channel_id
    FROM listing.channels c
    WHERE c.code = p_channel_code AND c.status = 'ACTIVE';

    IF v_channel_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Channel code % is invalid or inactive.', p_channel_code USING ERRCODE = '22023';
    END IF;

    -- Compute payload hash for idempotency validation
    v_payload_hash := encode(digest(
        concat_ws(':', v_actor_person_id, p_target_id, p_channel_code, p_consent_receipt_id,
                  COALESCE(p_requested_start_at::text, ''), COALESCE(p_requested_end_at::text, ''),
                  COALESCE(p_consumer_note, ''), COALESCE(p_requirement_payload::text, '{}')),
        'sha256'
    ), 'hex');

    -- Idempotency check
    IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
        SELECT response_body, request_hash_sha256 INTO v_idempotency_record
        FROM integration.idempotency_keys
        WHERE scope = 'engagement.submit_inquiry'
          AND idempotency_key = p_idempotency_key
          AND status = 'SUCCEEDED';

        IF v_idempotency_record.response_body IS NOT NULL THEN
            IF v_idempotency_record.request_hash_sha256 = v_payload_hash THEN
                RETURN v_idempotency_record.response_body;
            ELSE
                RAISE EXCEPTION 'STATE_CONFLICT: Idempotency key reused with different request payload.' USING ERRCODE = '23505';
            END IF;
        END IF;
    END IF;

    -- Consent receipt validation if provided
    IF p_consent_receipt_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM privacy.consent_receipts cr
            WHERE cr.id = p_consent_receipt_id
              AND cr.person_id = v_actor_person_id
              AND cr.status = 'ACTIVE'
        ) THEN
            RAISE EXCEPTION 'VALIDATION_FAILED: Invalid or inactive consent receipt.' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- Resolve target publication / offering / resource and provider
    -- Case A: Target ID is channel_publication_id
    SELECT cp.id, cp.offering_id, cp.provider_profile_id
    INTO v_target_pub_id, v_target_offering_id, v_provider_profile_id
    FROM listing.channel_publications cp
    JOIN listing.channels ch ON ch.id = cp.channel_id
    JOIN provider.provider_profiles pr ON pr.id = cp.provider_profile_id
    WHERE cp.id = p_target_id
      AND cp.channel_code = p_channel_code
      AND ch.status = 'ACTIVE'
      AND cp.publication_status = 'PUBLISHED'
      AND pr.status = 'ACTIVE'
      AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
      AND (cp.effective_to IS NULL OR cp.effective_to > v_at);

    -- Case B: Target ID is offering_id
    IF v_provider_profile_id IS NULL THEN
        SELECT cp.id, o.id, cp.provider_profile_id
        INTO v_target_pub_id, v_target_offering_id, v_provider_profile_id
        FROM catalog.offerings o
        JOIN listing.channel_publications cp ON cp.offering_id = o.id
        JOIN listing.channels ch ON ch.id = cp.channel_id
        JOIN provider.provider_profiles pr ON pr.id = cp.provider_profile_id
        WHERE o.id = p_target_id
          AND cp.channel_code = p_channel_code
          AND o.status = 'ACTIVE'
          AND ch.status = 'ACTIVE'
          AND cp.publication_status = 'PUBLISHED'
          AND pr.status = 'ACTIVE'
          AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
          AND (cp.effective_to IS NULL OR cp.effective_to > v_at)
        LIMIT 1;
    END IF;

    -- Case C: Target ID is resource_id
    IF v_provider_profile_id IS NULL THEN
        SELECT cp.id, o.id, r.id, cp.provider_profile_id
        INTO v_target_pub_id, v_target_offering_id, v_target_resource_id, v_provider_profile_id
        FROM catalog.resources r
        JOIN catalog.offering_resources os ON os.resource_id = r.id
        JOIN catalog.offerings o ON o.id = os.offering_id
        JOIN listing.channel_publications cp ON cp.offering_id = o.id
        JOIN listing.channels ch ON ch.id = cp.channel_id
        JOIN provider.provider_profiles pr ON pr.id = cp.provider_profile_id
        WHERE r.id = p_target_id
          AND cp.channel_code = p_channel_code
          AND r.status = 'ACTIVE'
          AND o.status = 'ACTIVE'
          AND ch.status = 'ACTIVE'
          AND cp.publication_status = 'PUBLISHED'
          AND pr.status = 'ACTIVE'
          AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
          AND (cp.effective_to IS NULL OR cp.effective_to > v_at)
        LIMIT 1;
    END IF;

    IF v_provider_profile_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Target publication/offering/resource is not published or eligible for channel %.', p_channel_code USING ERRCODE = '22023';
    END IF;

    -- Generate public reference
    v_public_ref := 'INQ-' || to_char(v_at, 'YYYYMMDD') || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));

    -- Create Inquiry
    INSERT INTO engagement.inquiries (
        public_reference, requester_person_id, target_provider_profile_id,
        source_channel, source_channel_publication_id, source_offering_id, source_resource_id,
        commercial_attribution_reference, status, consent_receipt_id
    ) VALUES (
        v_public_ref, v_actor_person_id, v_provider_profile_id,
        p_channel_code, v_target_pub_id, v_target_offering_id, v_target_resource_id,
        p_commercial_ref, 'NEW', p_consent_receipt_id
    )
    RETURNING id INTO v_inquiry_id;

    -- Snapshot Requirements
    INSERT INTO engagement.inquiry_requirements (
        inquiry_id, requested_start_at, requested_end_at, requested_location_text,
        requested_geo_region_id, quantity, consumer_note, requirement_payload,
        schema_version, offering_snapshot_id, resource_snapshot_id
    ) VALUES (
        v_inquiry_id, p_requested_start_at, p_requested_end_at, p_location_text,
        p_geo_region_id, p_quantity, p_consumer_note, COALESCE(p_requirement_payload, '{}'::jsonb),
        'v1', v_target_offering_id, v_target_resource_id
    );

    -- Create Participants
    INSERT INTO engagement.inquiry_participants (inquiry_id, participant_type, person_id, status)
    VALUES (v_inquiry_id, 'CONSUMER', v_actor_person_id, 'ACTIVE');

    INSERT INTO engagement.inquiry_participants (inquiry_id, participant_type, provider_profile_id, status)
    VALUES (v_inquiry_id, 'PROVIDER', v_provider_profile_id, 'ACTIVE');

    -- Build response DTO
    v_result := jsonb_build_object(
        'id', v_inquiry_id,
        'public_reference', v_public_ref,
        'requester_person_id', v_actor_person_id,
        'target_provider_profile_id', v_provider_profile_id,
        'source_channel', p_channel_code,
        'status', 'NEW',
        'created_at', v_at
    );

    -- Record Idempotency
    IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
        INSERT INTO integration.idempotency_keys (
            scope, idempotency_key, request_hash_sha256, status, response_status_code, response_body, expires_at
        ) VALUES (
            'engagement.submit_inquiry', p_idempotency_key, v_payload_hash, 'SUCCEEDED', 201, v_result, clock_timestamp() + interval '24 hours'
        ) ON CONFLICT (scope, idempotency_key) DO NOTHING;
    END IF;

    -- Audit Event (Safe metadata - NO consumer_note or full requirement payload in audit log)
    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'INQUIRY_SUBMITTED',
        'inquiry.submit',
        security.context_value('actor_account_key'),
        security.context_value('actor_person_key'),
        security.context_value('local_assignment_key'),
        'engagement',
        'inquiries',
        v_inquiry_id::text,
        security.context_value('correlation_id'),
        security.context_value('request_id'),
        jsonb_build_object(
            'public_reference', v_public_ref,
            'target_provider_profile_id', v_provider_profile_id,
            'source_channel', p_channel_code
        ),
        'CONFIDENTIAL'
    );

    -- Outbox Event
    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'engagement:inquiry:' || v_inquiry_id::text || ':submit:' || extract(epoch from v_at)::text,
        'engagement',
        'inquiries',
        v_inquiry_id::text,
        1,
        'inquiry.submitted',
        jsonb_build_object(
            'inquiry_id', v_inquiry_id,
            'public_reference', v_public_ref,
            'target_provider_profile_id', v_provider_profile_id,
            'source_channel', p_channel_code,
            'status', 'NEW',
            'submitted_at', v_at
        ),
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;

-- 2. ACTIVATE_INQUIRY
CREATE OR REPLACE FUNCTION engagement.activate_inquiry(p_inquiry_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_prov_id UUID;
    v_org_id UUID;
    v_status VARCHAR(32);
    v_auth BOOLEAN := false;
    v_at TIMESTAMPTZ := clock_timestamp();
    v_result JSONB;
BEGIN
    SELECT i.target_provider_profile_id, i.status INTO v_prov_id, v_status
    FROM engagement.inquiries i WHERE i.id = p_inquiry_id;

    IF v_prov_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    IF v_status <> 'NEW' THEN
        RAISE EXCEPTION 'STATE_CONFLICT: Inquiry is in state %, cannot activate.', v_status USING ERRCODE = '22023';
    END IF;

    SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;

    IF access.has_local_capability('engagement.inquiry.manage', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
       OR access.has_local_capability('engagement.inquiry.manage', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('engagement.inquiry.manage', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
       OR EXISTS (
           SELECT 1 FROM engagement.inquiry_assignments a
           WHERE a.inquiry_id = p_inquiry_id AND a.assigned_person_id = security.current_actor_person_id() AND a.status = 'ACTIVE'
       )
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient authority to activate inquiry.' USING ERRCODE = '42501';
    END IF;

    UPDATE engagement.inquiries
    SET status = 'ACTIVE', activated_at = v_at, updated_at = v_at
    WHERE id = p_inquiry_id;

    v_result := jsonb_build_object('id', p_inquiry_id, 'status', 'ACTIVE', 'activated_at', v_at);

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'INQUIRY_ACTIVATED', 'inquiry.activate',
        security.context_value('actor_account_key'), security.context_value('actor_person_key'), security.context_value('local_assignment_key'),
        'engagement', 'inquiries', p_inquiry_id::text,
        security.context_value('correlation_id'), security.context_value('request_id'),
        jsonb_build_object('status', 'ACTIVE'), 'CONFIDENTIAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'engagement:inquiry:' || p_inquiry_id::text || ':activate:' || extract(epoch from v_at)::text,
        'engagement',
        'inquiries',
        p_inquiry_id::text,
        1,
        'inquiry.activated',
        v_result,
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;

-- 3. ASSIGN_INQUIRY
CREATE OR REPLACE FUNCTION engagement.assign_inquiry(
    p_inquiry_id UUID,
    p_assigned_person_id UUID,
    p_scoped_assignment_id UUID DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_prov_id UUID;
    v_org_id UUID;
    v_auth BOOLEAN := false;
    v_at TIMESTAMPTZ := clock_timestamp();
    v_assignment_id UUID;
    v_result JSONB;
BEGIN
    SELECT i.target_provider_profile_id INTO v_prov_id
    FROM engagement.inquiries i WHERE i.id = p_inquiry_id;

    IF v_prov_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;

    IF access.has_local_capability('engagement.inquiry.assign', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
       OR access.has_local_capability('engagement.inquiry.assign', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('engagement.inquiry.assign', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient capability engagement.inquiry.assign.' USING ERRCODE = '42501';
    END IF;

    -- Revoke existing active assignments
    UPDATE engagement.inquiry_assignments
    SET status = 'REVOKED', revoked_at = v_at, updated_at = v_at
    WHERE inquiry_id = p_inquiry_id AND status = 'ACTIVE';

    -- Create new active assignment
    INSERT INTO engagement.inquiry_assignments (
        inquiry_id, assigned_scoped_assignment_id, assigned_person_id, provider_profile_id,
        status, assigned_at, assigned_by_person_id, assignment_reason
    ) VALUES (
        p_inquiry_id, p_scoped_assignment_id, p_assigned_person_id, v_prov_id,
        'ACTIVE', v_at, engagement.current_person_id(), p_reason
    ) RETURNING id INTO v_assignment_id;

    v_result := jsonb_build_object(
        'id', v_assignment_id,
        'inquiry_id', p_inquiry_id,
        'assigned_person_id', p_assigned_person_id,
        'status', 'ACTIVE',
        'assigned_at', v_at
    );

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'INQUIRY_ASSIGNED', 'inquiry.assign',
        security.context_value('actor_account_key'), security.context_value('actor_person_key'), security.context_value('local_assignment_key'),
        'engagement', 'inquiry_assignments', v_assignment_id::text,
        security.context_value('correlation_id'), security.context_value('request_id'),
        jsonb_build_object('inquiry_id', p_inquiry_id, 'assigned_person_id', p_assigned_person_id), 'CONFIDENTIAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'engagement:inquiry:' || p_inquiry_id::text || ':assign:' || extract(epoch from v_at)::text,
        'engagement',
        'inquiries',
        p_inquiry_id::text,
        1,
        'inquiry.assigned',
        v_result,
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;

-- 4. CANCEL_INQUIRY
CREATE OR REPLACE FUNCTION engagement.cancel_inquiry(p_inquiry_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_requester_id UUID;
    v_status VARCHAR(32);
    v_prov_id UUID;
    v_org_id UUID;
    v_auth BOOLEAN := false;
    v_at TIMESTAMPTZ := clock_timestamp();
    v_result JSONB;
BEGIN
    SELECT i.requester_person_id, i.status, i.target_provider_profile_id
    INTO v_requester_id, v_status, v_prov_id
    FROM engagement.inquiries i WHERE i.id = p_inquiry_id;

    IF v_requester_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    IF v_status IN ('CANCELLED', 'CLOSED') THEN
        RAISE EXCEPTION 'STATE_CONFLICT: Inquiry is already terminal (%).', v_status USING ERRCODE = '22023';
    END IF;

    -- Consumer participant can cancel own inquiry
    IF engagement.current_person_id() = v_requester_id THEN
        v_auth := true;
    ELSE
        SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;
        IF access.has_local_capability('engagement.inquiry.manage', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
           OR access.has_local_capability('engagement.inquiry.manage', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
        THEN
            v_auth := true;
        END IF;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient authority to cancel inquiry.' USING ERRCODE = '42501';
    END IF;

    UPDATE engagement.inquiries
    SET status = 'CANCELLED', cancelled_at = v_at, updated_at = v_at
    WHERE id = p_inquiry_id;

    v_result := jsonb_build_object('id', p_inquiry_id, 'status', 'CANCELLED', 'cancelled_at', v_at);

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'INQUIRY_CANCELLED', 'inquiry.cancel',
        security.context_value('actor_account_key'), security.context_value('actor_person_key'), security.context_value('local_assignment_key'),
        'engagement', 'inquiries', p_inquiry_id::text,
        security.context_value('correlation_id'), security.context_value('request_id'),
        jsonb_build_object('status', 'CANCELLED', 'reason', p_reason), 'CONFIDENTIAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'engagement:inquiry:' || p_inquiry_id::text || ':cancel:' || extract(epoch from v_at)::text,
        'engagement',
        'inquiries',
        p_inquiry_id::text,
        1,
        'inquiry.cancelled',
        v_result,
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;

-- 5. CLOSE_INQUIRY
CREATE OR REPLACE FUNCTION engagement.close_inquiry(p_inquiry_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_prov_id UUID;
    v_org_id UUID;
    v_status VARCHAR(32);
    v_auth BOOLEAN := false;
    v_at TIMESTAMPTZ := clock_timestamp();
    v_result JSONB;
BEGIN
    SELECT i.target_provider_profile_id, i.status INTO v_prov_id, v_status
    FROM engagement.inquiries i WHERE i.id = p_inquiry_id;

    IF v_prov_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    IF v_status IN ('CANCELLED', 'CLOSED') THEN
        RAISE EXCEPTION 'STATE_CONFLICT: Inquiry is already terminal (%).', v_status USING ERRCODE = '22023';
    END IF;

    SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;

    IF access.has_local_capability('engagement.inquiry.manage', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
       OR access.has_local_capability('engagement.inquiry.manage', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('engagement.inquiry.manage', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient authority to close inquiry.' USING ERRCODE = '42501';
    END IF;

    UPDATE engagement.inquiries
    SET status = 'CLOSED', closed_at = v_at, updated_at = v_at
    WHERE id = p_inquiry_id;

    v_result := jsonb_build_object('id', p_inquiry_id, 'status', 'CLOSED', 'closed_at', v_at);

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'INQUIRY_CLOSED', 'inquiry.close',
        security.context_value('actor_account_key'), security.context_value('actor_person_key'), security.context_value('local_assignment_key'),
        'engagement', 'inquiries', p_inquiry_id::text,
        security.context_value('correlation_id'), security.context_value('request_id'),
        jsonb_build_object('status', 'CLOSED', 'reason', p_reason), 'CONFIDENTIAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'engagement:inquiry:' || p_inquiry_id::text || ':close:' || extract(epoch from v_at)::text,
        'engagement',
        'inquiries',
        p_inquiry_id::text,
        1,
        'inquiry.closed',
        v_result,
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;

-- ============================================================================
-- QUERY RPCs
-- ============================================================================

-- Read Consumer Inquiry
CREATE OR REPLACE FUNCTION engagement.read_consumer_inquiry(p_inquiry_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_actor_person_id UUID;
    v_result JSONB;
BEGIN
    v_actor_person_id := engagement.current_person_id();
    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: Valid authenticated consumer required.' USING ERRCODE = '42501';
    END IF;

    SELECT jsonb_build_object(
        'id', i.id,
        'public_reference', i.public_reference,
        'source_channel', i.source_channel,
        'status', i.status,
        'target_provider_profile_id', i.target_provider_profile_id,
        'created_at', i.created_at,
        'updated_at', i.updated_at,
        'requirement', jsonb_build_object(
            'requested_start_at', r.requested_start_at,
            'requested_end_at', r.requested_end_at,
            'requested_location_text', r.requested_location_text,
            'quantity', r.quantity,
            'consumer_note', r.consumer_note,
            'requirement_payload', r.requirement_payload
        )
    ) INTO v_result
    FROM engagement.inquiries i
    JOIN engagement.inquiry_requirements r ON r.inquiry_id = i.id
    WHERE i.id = p_inquiry_id
      AND (
        i.requester_person_id = v_actor_person_id
        OR EXISTS (
            SELECT 1 FROM engagement.inquiry_participants p
            WHERE p.inquiry_id = i.id AND p.participant_type = 'CONSUMER' AND p.person_id = v_actor_person_id AND p.status = 'ACTIVE'
        )
      );

    IF v_result IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found or unauthorized.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    RETURN v_result;
END;
$$;

-- List Consumer Inquiries
CREATE OR REPLACE FUNCTION engagement.list_consumer_inquiries(
    p_limit INT DEFAULT 20,
    p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_actor_person_id UUID;
    v_items JSONB;
BEGIN
    v_actor_person_id := engagement.current_person_id();
    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: Valid authenticated consumer required.' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', i.id,
            'public_reference', i.public_reference,
            'source_channel', i.source_channel,
            'status', i.status,
            'target_provider_profile_id', i.target_provider_profile_id,
            'created_at', i.created_at,
            'updated_at', i.updated_at
        )
    ), '[]'::jsonb) INTO v_items
    FROM (
        SELECT i.* FROM engagement.inquiries i
        WHERE i.requester_person_id = v_actor_person_id
           OR EXISTS (
               SELECT 1 FROM engagement.inquiry_participants p
               WHERE p.inquiry_id = i.id AND p.participant_type = 'CONSUMER' AND p.person_id = v_actor_person_id AND p.status = 'ACTIVE'
           )
        ORDER BY i.created_at DESC
        LIMIT LEAST(p_limit, 100) OFFSET GREATEST(p_offset, 0)
    ) i;

    RETURN jsonb_build_object('items', v_items, 'limit', p_limit, 'offset', p_offset);
END;
$$;

-- Read Sahabat Inquiry
CREATE OR REPLACE FUNCTION engagement.read_sahabat_inquiry(p_inquiry_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_prov_id UUID;
    v_org_id UUID;
    v_auth BOOLEAN := false;
    v_result JSONB;
BEGIN
    SELECT i.target_provider_profile_id INTO v_prov_id
    FROM engagement.inquiries i WHERE i.id = p_inquiry_id;

    IF v_prov_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;

    IF access.has_local_capability('engagement.inquiry.read', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
       OR access.has_local_capability('engagement.inquiry.read', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('engagement.inquiry.read', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
       OR EXISTS (
           SELECT 1 FROM engagement.inquiry_assignments a
           WHERE a.inquiry_id = p_inquiry_id AND a.assigned_person_id = engagement.current_person_id() AND a.status = 'ACTIVE'
       )
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient authority to view inquiry.' USING ERRCODE = '42501';
    END IF;

    SELECT jsonb_build_object(
        'id', i.id,
        'public_reference', i.public_reference,
        'source_channel', i.source_channel,
        'status', i.status,
        'requester_person_id', i.requester_person_id,
        'target_provider_profile_id', i.target_provider_profile_id,
        'created_at', i.created_at,
        'updated_at', i.updated_at,
        'requirement', jsonb_build_object(
            'requested_start_at', r.requested_start_at,
            'requested_end_at', r.requested_end_at,
            'requested_location_text', r.requested_location_text,
            'quantity', r.quantity,
            'consumer_note', r.consumer_note,
            'requirement_payload', r.requirement_payload
        ),
        'assignments', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', a.id,
                'assigned_person_id', a.assigned_person_id,
                'status', a.status,
                'assigned_at', a.assigned_at
            )), '[]'::jsonb)
            FROM engagement.inquiry_assignments a
            WHERE a.inquiry_id = i.id
        )
    ) INTO v_result
    FROM engagement.inquiries i
    JOIN engagement.inquiry_requirements r ON r.inquiry_id = i.id
    WHERE i.id = p_inquiry_id;

    RETURN v_result;
END;
$$;

-- List Sahabat Inquiries
CREATE OR REPLACE FUNCTION engagement.list_sahabat_inquiries(
    p_provider_profile_id UUID,
    p_status_filter VARCHAR DEFAULT NULL,
    p_limit INT DEFAULT 20,
    p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_org_id UUID;
    v_auth BOOLEAN := false;
    v_items JSONB;
BEGIN
    SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = p_provider_profile_id;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Provider profile % not found.', p_provider_profile_id USING ERRCODE = '22023';
    END IF;

    IF access.has_local_capability('engagement.inquiry.read', 'PROVIDER', NULL, v_org_id, NULL, p_provider_profile_id)
       OR access.has_local_capability('engagement.inquiry.read', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
       OR access.has_local_capability('engagement.inquiry.read', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
    THEN
        v_auth := true;
    END IF;

    IF NOT v_auth THEN
        RAISE EXCEPTION 'FORBIDDEN: Insufficient authority to view provider inquiries.' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', i.id,
            'public_reference', i.public_reference,
            'source_channel', i.source_channel,
            'status', i.status,
            'requester_person_id', i.requester_person_id,
            'created_at', i.created_at,
            'updated_at', i.updated_at
        )
    ), '[]'::jsonb) INTO v_items
    FROM (
        SELECT i.* FROM engagement.inquiries i
        WHERE i.target_provider_profile_id = p_provider_profile_id
          AND (p_status_filter IS NULL OR i.status = p_status_filter)
        ORDER BY i.created_at DESC
        LIMIT LEAST(p_limit, 100) OFFSET GREATEST(p_offset, 0)
    ) i;

    RETURN jsonb_build_object('items', v_items, 'limit', p_limit, 'offset', p_offset);
END;
$$;
