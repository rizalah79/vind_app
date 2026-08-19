-- Forward-fix migration for Block 1B Inquiry Core Hardening
-- Hardens engagement.submit_inquiry (mandatory consent, atomic idempotency pre-reservation)
-- and engagement.assign_inquiry (scoped assignment validation).

CREATE OR REPLACE FUNCTION engagement.submit_inquiry(
    p_target_id UUID,
    p_channel_code VARCHAR,
    p_consent_receipt_id UUID DEFAULT NULL,
    p_idempotency_key VARCHAR DEFAULT NULL,
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

    -- Mandatory consent validation
    IF p_consent_receipt_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Consent receipt is strictly required to submit inquiry.' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM privacy.consent_receipts cr
        WHERE cr.id = p_consent_receipt_id
          AND cr.person_id = v_actor_person_id
          AND cr.consent_action = 'GRANTED'
          AND (cr.grant_effective_from IS NULL OR cr.grant_effective_from <= v_at)
          AND (cr.grant_effective_until IS NULL OR cr.grant_effective_until > v_at)
          AND NOT EXISTS (
              SELECT 1 FROM privacy.consent_receipts w
              WHERE w.revokes_receipt_id = cr.id AND w.consent_action = 'WITHDRAWN'
          )
    ) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Invalid, expired, or withdrawn consent receipt for this user.' USING ERRCODE = '22023';
    END IF;

    -- Compute payload hash for idempotency validation
    v_payload_hash := encode(public.digest(
        concat_ws(':', v_actor_person_id, p_target_id, p_channel_code, p_consent_receipt_id,
                  COALESCE(p_requested_start_at::text, ''), COALESCE(p_requested_end_at::text, ''),
                  COALESCE(p_location_text, ''), COALESCE(p_geo_region_id::text, ''), COALESCE(p_quantity::text, ''),
                  COALESCE(p_consumer_note, ''), COALESCE(p_requirement_payload::text, '{}'), COALESCE(p_commercial_ref, '')),
        'sha256'
    ), 'hex');

    -- Atomic Idempotency reservation BEFORE case creation
    IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
        SELECT response_body, request_hash_sha256, status INTO v_idempotency_record
        FROM integration.idempotency_keys
        WHERE scope = 'engagement.submit_inquiry'
          AND idempotency_key = p_idempotency_key;

        IF v_idempotency_record.status IS NOT NULL THEN
            IF v_idempotency_record.status = 'SUCCEEDED' THEN
                IF v_idempotency_record.request_hash_sha256 = v_payload_hash THEN
                    RETURN v_idempotency_record.response_body;
                ELSE
                    RAISE EXCEPTION 'STATE_CONFLICT: Idempotency key reused with different request payload.' USING ERRCODE = '23505';
                END IF;
            ELSE
                RAISE EXCEPTION 'STATE_CONFLICT: Concurrent request with same idempotency key is processing.' USING ERRCODE = '23505';
            END IF;
        ELSE
            BEGIN
                INSERT INTO integration.idempotency_keys (
                    scope, idempotency_key, request_hash_sha256, actor_key, status, expires_at
                ) VALUES (
                    'engagement.submit_inquiry', p_idempotency_key, v_payload_hash, v_actor_person_id::text, 'PROCESSING', v_at + interval '24 hours'
                );
            EXCEPTION WHEN unique_violation THEN
                RAISE EXCEPTION 'STATE_CONFLICT: Concurrent request with same idempotency key is processing.' USING ERRCODE = '23505';
            END;
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
          AND (cp.effective_to IS NULL OR cp.effective_to > v_at);
    END IF;

    -- Case C: Target ID is resource_id
    IF v_provider_profile_id IS NULL THEN
        SELECT cp.id, cp.offering_id, r.id, cp.provider_profile_id
        INTO v_target_pub_id, v_target_offering_id, v_target_resource_id, v_provider_profile_id
        FROM catalog.resources r
        JOIN catalog.offerings o ON o.id = r.offering_id
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
          AND (cp.effective_to IS NULL OR cp.effective_to > v_at);
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

    -- Record Idempotency SUCCEEDED
    IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
        UPDATE integration.idempotency_keys
        SET status = 'SUCCEEDED',
            response_status_code = 201,
            response_body = v_result,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE scope = 'engagement.submit_inquiry'
          AND idempotency_key = p_idempotency_key;
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
        'inquiry.submitted.' || v_inquiry_id::text,
        'engagement',
        'inquiry',
        v_inquiry_id::text,
        1,
        'INQUIRY_SUBMITTED',
        jsonb_build_object(
            'inquiry_id', v_inquiry_id,
            'public_reference', v_public_ref,
            'requester_person_id', v_actor_person_id,
            'target_provider_profile_id', v_provider_profile_id,
            'source_channel', p_channel_code
        ),
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;

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

    -- Validate assigned_person_id (and optional scoped_assignment_id) against active scoped_assignments covering provider scope
    IF p_assigned_person_id IS NULL THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Assigned person ID is required.' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM access.scoped_assignments sa
        WHERE sa.subject_person_id = p_assigned_person_id
          AND sa.status = 'ACTIVE'
          AND (sa.effective_from IS NULL OR sa.effective_from <= v_at)
          AND (sa.effective_to IS NULL OR sa.effective_to > v_at)
          AND (
              (p_scoped_assignment_id IS NULL OR sa.id = p_scoped_assignment_id)
          )
          AND (
              (sa.scope_type = 'PROVIDER' AND sa.provider_id = v_prov_id)
              OR (sa.scope_type = 'ORGANIZATION' AND sa.organization_id = v_org_id)
              OR (sa.scope_type = 'WORKSPACE' AND sa.workspace_id IN (
                  SELECT pwl.workspace_id FROM provider.provider_workspace_links pwl
                  WHERE pwl.provider_profile_id = v_prov_id AND pwl.link_status = 'ACTIVE'
              ))
          )
    ) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Assigned person does not hold an active eligible assignment for this provider.' USING ERRCODE = '22023';
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
        'inquiry.assigned.' || v_assignment_id::text,
        'engagement',
        'inquiry',
        p_inquiry_id::text,
        1,
        'INQUIRY_ASSIGNED',
        v_result,
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;
