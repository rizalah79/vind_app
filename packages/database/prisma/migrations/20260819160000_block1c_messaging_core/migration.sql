-- Stage 1 Block 1C — Messaging Core Schema & RPC Migration

CREATE SCHEMA IF NOT EXISTS messaging;

-- 1. messaging.conversations
CREATE TABLE messaging.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id UUID NOT NULL UNIQUE REFERENCES engagement.inquiries(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    abuse_status VARCHAR(32) NOT NULL DEFAULT 'NORMAL',
    moderation_status VARCHAR(32) NOT NULL DEFAULT 'UNMODERATED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_conversation_status CHECK (status IN ('ACTIVE', 'CLOSED', 'ARCHIVED')),
    CONSTRAINT chk_conversations_abuse_status CHECK (abuse_status IN ('NORMAL', 'FLAGGED', 'BLOCKED', 'UNDER_REVIEW')),
    CONSTRAINT chk_conversations_moderation_status CHECK (moderation_status IN ('UNMODERATED', 'PENDING', 'APPROVED', 'REJECTED'))
);

CREATE INDEX idx_conversations_inquiry ON messaging.conversations(inquiry_id);

-- 2. messaging.conversation_participants
CREATE TABLE messaging.conversation_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES messaging.conversations(id) ON DELETE CASCADE,
    participant_type VARCHAR(32) NOT NULL,
    person_id UUID REFERENCES party.persons(id),
    provider_profile_id UUID REFERENCES provider.provider_profiles(id),
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_messaging_participant_type CHECK (participant_type IN ('CONSUMER', 'PROVIDER', 'PLATFORM')),
    CONSTRAINT chk_messaging_participant_status CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE UNIQUE INDEX idx_messaging_participants_unique ON messaging.conversation_participants (
    conversation_id,
    participant_type,
    COALESCE(person_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(provider_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE INDEX idx_messaging_participants_conv ON messaging.conversation_participants(conversation_id, status);
CREATE INDEX idx_messaging_participants_person ON messaging.conversation_participants(person_id, status);
CREATE INDEX idx_messaging_participants_provider ON messaging.conversation_participants(provider_profile_id, status);

-- 3. messaging.messages
CREATE TABLE messaging.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES messaging.conversations(id) ON DELETE CASCADE,
    sender_participant_type VARCHAR(32) NOT NULL,
    sender_person_id UUID REFERENCES party.persons(id),
    body TEXT NOT NULL,
    message_type VARCHAR(32) NOT NULL DEFAULT 'TEXT',
    status VARCHAR(32) NOT NULL DEFAULT 'SENT',
    sequence_number BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_messages_sender_type CHECK (sender_participant_type IN ('CONSUMER', 'PROVIDER', 'PLATFORM')),
    CONSTRAINT chk_messages_message_type CHECK (message_type IN ('TEXT', 'SYSTEM', 'ATTACHMENT')),
    CONSTRAINT chk_messages_status CHECK (status IN ('SENT', 'DELIVERED', 'READ'))
);

CREATE UNIQUE INDEX uq_messages_conversation_sequence ON messaging.messages(conversation_id, sequence_number);
CREATE INDEX idx_messages_conv_created ON messaging.messages(conversation_id, created_at DESC, id);
CREATE INDEX idx_messages_conv_seq ON messaging.messages(conversation_id, sequence_number);

-- Immutability enforcement trigger for messaging.messages
CREATE OR REPLACE FUNCTION messaging.enforce_message_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'STATE_CONFLICT: message is immutable and cannot be updated.' USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF COALESCE(current_setting('messaging.allow_message_delete', true), 'off') <> 'on' THEN
            RAISE EXCEPTION 'STATE_CONFLICT: message is immutable and cannot be deleted.' USING ERRCODE = '22023';
        END IF;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_messages_immutable
BEFORE UPDATE OR DELETE ON messaging.messages
FOR EACH ROW EXECUTE FUNCTION messaging.enforce_message_immutability();

-- 4. messaging.message_attachments
CREATE TABLE messaging.message_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messaging.messages(id) ON DELETE CASCADE,
    media_asset_id UUID NOT NULL REFERENCES media.media_assets(id) ON DELETE RESTRICT,
    attachment_type VARCHAR(32) NOT NULL DEFAULT 'DOCUMENT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_message_attachments_msg ON messaging.message_attachments(message_id);
CREATE INDEX idx_message_attachments_asset ON messaging.message_attachments(media_asset_id);

-- 5. messaging.message_receipts
CREATE TABLE messaging.message_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES messaging.conversations(id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES messaging.messages(id) ON DELETE SET NULL,
    last_delivered_message_id UUID REFERENCES messaging.messages(id) ON DELETE SET NULL,
    reader_person_id UUID NOT NULL REFERENCES party.persons(id),
    receipt_type VARCHAR(32) NOT NULL DEFAULT 'READ',
    read_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    delivered_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_message_receipts_conv_reader UNIQUE (conversation_id, reader_person_id),
    CONSTRAINT chk_message_receipts_type CHECK (receipt_type IN ('DELIVERED', 'READ'))
);

CREATE INDEX idx_message_receipts_conv ON messaging.message_receipts(conversation_id, reader_person_id);

-- Capabilities & Role Mappings
INSERT INTO access.capabilities (code, domain_code, action_code, description, is_sensitive, is_active)
VALUES
  ('messaging.conversation.read', 'messaging', 'conversation.read', 'Authority to view messaging conversations', false, true),
  ('messaging.message.send', 'messaging', 'message.send', 'Authority to send messages in conversation', false, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO access.role_capabilities (role_code, capability_code)
VALUES
  ('OWNER', 'messaging.conversation.read'),
  ('OWNER', 'messaging.message.send'),
  ('ADMIN', 'messaging.conversation.read'),
  ('ADMIN', 'messaging.message.send'),
  ('OPERATIONS_STAFF', 'messaging.conversation.read'),
  ('OPERATIONS_STAFF', 'messaging.message.send')
ON CONFLICT (role_code, capability_code) DO NOTHING;

DELETE FROM access.role_capabilities
WHERE role_code IN ('ACCOUNTING', 'CONTENT_MANAGER')
  AND capability_code IN ('messaging.conversation.read', 'messaging.message.send');

-- Table Ownership
ALTER TABLE messaging.conversations OWNER TO vind_db_owner;
ALTER TABLE messaging.conversation_participants OWNER TO vind_db_owner;
ALTER TABLE messaging.messages OWNER TO vind_db_owner;
ALTER TABLE messaging.message_attachments OWNER TO vind_db_owner;
ALTER TABLE messaging.message_receipts OWNER TO vind_db_owner;

-- RLS & FORCE RLS
ALTER TABLE messaging.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.conversations FORCE ROW LEVEL SECURITY;

ALTER TABLE messaging.conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.conversation_participants FORCE ROW LEVEL SECURITY;

ALTER TABLE messaging.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.messages FORCE ROW LEVEL SECURITY;

ALTER TABLE messaging.message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.message_attachments FORCE ROW LEVEL SECURITY;

ALTER TABLE messaging.message_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.message_receipts FORCE ROW LEVEL SECURITY;

-- Owner Policies
CREATE POLICY owner_all_conversations ON messaging.conversations FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_conversation_participants ON messaging.conversation_participants FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_messages ON messaging.messages FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_message_attachments ON messaging.message_attachments FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_message_receipts ON messaging.message_receipts FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);

-- Helper to check actor authorization for an inquiry
CREATE OR REPLACE FUNCTION messaging.is_authorized_for_inquiry(p_inquiry_id UUID, p_is_sahabat BOOLEAN DEFAULT false)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_req_person_id UUID;
    v_prov_id UUID;
    v_org_id UUID;
    v_actor_person_id UUID;
BEGIN
    v_actor_person_id := engagement.current_person_id();
    IF v_actor_person_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT i.requester_person_id, i.target_provider_profile_id
    INTO v_req_person_id, v_prov_id
    FROM engagement.inquiries i
    WHERE i.id = p_inquiry_id;

    IF v_req_person_id IS NULL THEN
        RETURN false;
    END IF;

    IF NOT p_is_sahabat THEN
        -- Consumer check
        IF v_req_person_id = v_actor_person_id THEN
            RETURN true;
        END IF;

        IF EXISTS (
            SELECT 1 FROM engagement.inquiry_participants p
            WHERE p.inquiry_id = p_inquiry_id
              AND p.participant_type = 'CONSUMER'
              AND p.person_id = v_actor_person_id
              AND p.status = 'ACTIVE'
        ) THEN
            RETURN true;
        END IF;

        RETURN false;
    ELSE
        -- Sahabat check
        SELECT pr.owning_organization_id INTO v_org_id FROM provider.provider_profiles pr WHERE pr.id = v_prov_id;

        IF access.has_local_capability('messaging.conversation.read', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
           OR access.has_local_capability('messaging.conversation.read', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
           OR access.has_local_capability('messaging.conversation.read', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
           OR access.has_local_capability('engagement.inquiry.read', 'PROVIDER', NULL, v_org_id, NULL, v_prov_id)
           OR access.has_local_capability('engagement.inquiry.read', 'ORGANIZATION', NULL, v_org_id, NULL, NULL)
           OR access.has_local_capability('engagement.inquiry.read', 'WORKSPACE', NULL, v_org_id, NULL, NULL)
           OR EXISTS (
               SELECT 1
               FROM engagement.inquiry_assignments ia
               JOIN access.scoped_assignments sa ON (
                   (ia.assigned_scoped_assignment_id IS NOT NULL AND sa.id = ia.assigned_scoped_assignment_id)
                   OR
                   (ia.assigned_scoped_assignment_id IS NULL AND sa.subject_person_id = ia.assigned_person_id)
               )
               WHERE ia.inquiry_id = p_inquiry_id
                 AND ia.assigned_person_id = v_actor_person_id
                 AND ia.status = 'ACTIVE'
                 AND sa.subject_person_id = v_actor_person_id
                 AND sa.status = 'ACTIVE'
                 AND sa.effective_from <= clock_timestamp()
                 AND (sa.effective_to IS NULL OR sa.effective_to > clock_timestamp())
                 AND (
                     (sa.scope_type = 'PROVIDER' AND sa.provider_id = v_prov_id)
                     OR (sa.scope_type = 'ORGANIZATION' AND sa.organization_id = v_org_id)
                     OR (sa.scope_type = 'WORKSPACE' AND EXISTS (
                         SELECT 1 FROM provider.provider_workspace_links pwl
                         WHERE pwl.provider_profile_id = v_prov_id
                           AND pwl.workspace_id = sa.workspace_id
                           AND (pwl.link_status = 'ACTIVE' OR pwl.link_status = 'PUBLISHED')
                           AND pwl.effective_from <= clock_timestamp()
                           AND (pwl.effective_to IS NULL OR pwl.effective_to > clock_timestamp())
                     ))
                     OR (sa.scope_type = 'PERSON' AND sa.scope_person_id = v_actor_person_id)
                 )
                 AND (sa.membership_id IS NULL OR EXISTS (
                     SELECT 1 FROM access.memberships m
                     WHERE m.id = sa.membership_id
                       AND m.status = 'ACTIVE'
                       AND m.effective_from <= clock_timestamp()
                       AND (m.effective_to IS NULL OR m.effective_to > clock_timestamp())
                 ))
           )
        THEN
            RETURN true;
        END IF;

        RETURN false;
    END IF;
END;
$$;

-- Runtime SELECT Policies
CREATE POLICY runtime_conversations_select ON messaging.conversations
    FOR SELECT TO vind_app_runtime
    USING (
        messaging.is_authorized_for_inquiry(inquiry_id, false)
        OR messaging.is_authorized_for_inquiry(inquiry_id, true)
    );

CREATE POLICY runtime_conversation_participants_select ON messaging.conversation_participants
    FOR SELECT TO vind_app_runtime
    USING (
        EXISTS (
            SELECT 1 FROM messaging.conversations c
            WHERE c.id = messaging.conversation_participants.conversation_id
              AND (messaging.is_authorized_for_inquiry(c.inquiry_id, false) OR messaging.is_authorized_for_inquiry(c.inquiry_id, true))
        )
    );

CREATE POLICY runtime_messages_select ON messaging.messages
    FOR SELECT TO vind_app_runtime
    USING (
        EXISTS (
            SELECT 1 FROM messaging.conversations c
            WHERE c.id = messaging.messages.conversation_id
              AND (messaging.is_authorized_for_inquiry(c.inquiry_id, false) OR messaging.is_authorized_for_inquiry(c.inquiry_id, true))
        )
    );

CREATE POLICY runtime_message_attachments_select ON messaging.message_attachments
    FOR SELECT TO vind_app_runtime
    USING (
        EXISTS (
            SELECT 1 FROM messaging.messages m
            JOIN messaging.conversations c ON c.id = m.conversation_id
            WHERE m.id = messaging.message_attachments.message_id
              AND (messaging.is_authorized_for_inquiry(c.inquiry_id, false) OR messaging.is_authorized_for_inquiry(c.inquiry_id, true))
        )
    );

CREATE POLICY runtime_message_receipts_select ON messaging.message_receipts
    FOR SELECT TO vind_app_runtime
    USING (
        EXISTS (
            SELECT 1 FROM messaging.conversations c
            WHERE c.id = messaging.message_receipts.conversation_id
              AND (messaging.is_authorized_for_inquiry(c.inquiry_id, false) OR messaging.is_authorized_for_inquiry(c.inquiry_id, true))
        )
    );

-- RPC Surface Functions

-- 1. RESOLVE CANONICAL CONVERSATION (Internal helper, requires authorization check)
CREATE OR REPLACE FUNCTION messaging.resolve_canonical_conversation(p_inquiry_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_conv_id UUID;
    v_req_person_id UUID;
    v_prov_id UUID;
BEGIN
    IF NOT (messaging.is_authorized_for_inquiry(p_inquiry_id, false) OR messaging.is_authorized_for_inquiry(p_inquiry_id, true)) THEN
        RAISE EXCEPTION 'CAPABILITY_DENIED: Actor is not authorized for this inquiry.' USING ERRCODE = '42501';
    END IF;

    SELECT i.requester_person_id, i.target_provider_profile_id
    INTO v_req_person_id, v_prov_id
    FROM engagement.inquiries i
    WHERE i.id = p_inquiry_id;

    IF v_req_person_id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    SELECT id INTO v_conv_id
    FROM messaging.conversations
    WHERE inquiry_id = p_inquiry_id;

    IF v_conv_id IS NULL THEN
        INSERT INTO messaging.conversations (inquiry_id, status, abuse_status, moderation_status)
        VALUES (p_inquiry_id, 'ACTIVE', 'NORMAL', 'UNMODERATED')
        ON CONFLICT (inquiry_id) DO NOTHING
        RETURNING id INTO v_conv_id;

        IF v_conv_id IS NULL THEN
            SELECT id INTO v_conv_id FROM messaging.conversations WHERE inquiry_id = p_inquiry_id;
        END IF;

        -- Ensure participants exist
        INSERT INTO messaging.conversation_participants (conversation_id, participant_type, person_id, status)
        VALUES (v_conv_id, 'CONSUMER', v_req_person_id, 'ACTIVE')
        ON CONFLICT DO NOTHING;

        INSERT INTO messaging.conversation_participants (conversation_id, participant_type, provider_profile_id, status)
        VALUES (v_conv_id, 'PROVIDER', v_prov_id, 'ACTIVE')
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN v_conv_id;
END;
$$;

-- 2. LIST CONSUMER MESSAGES
CREATE OR REPLACE FUNCTION messaging.list_consumer_messages(
    p_inquiry_id UUID,
    p_limit INT DEFAULT 50,
    p_before_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_conv_id UUID;
    v_before_seq BIGINT;
    v_messages JSONB;
BEGIN
    IF NOT messaging.is_authorized_for_inquiry(p_inquiry_id, false) THEN
        RAISE EXCEPTION 'CAPABILITY_DENIED: Consumer is not authorized for this inquiry.' USING ERRCODE = '42501';
    END IF;

    v_conv_id := messaging.resolve_canonical_conversation(p_inquiry_id);

    IF p_before_id IS NOT NULL THEN
        SELECT sequence_number INTO v_before_seq FROM messaging.messages WHERE id = p_before_id AND conversation_id = v_conv_id;
    END IF;

    SELECT COALESCE(jsonb_agg(m_data ORDER BY m_data->>'sequence_number' ASC), '[]'::jsonb)
    INTO v_messages
    FROM (
        SELECT jsonb_build_object(
            'id', m.id,
            'conversation_id', m.conversation_id,
            'sender_participant_type', m.sender_participant_type,
            'sender_person_id', m.sender_person_id,
            'body', m.body,
            'message_type', m.message_type,
            'status', m.status,
            'sequence_number', m.sequence_number,
            'created_at', m.created_at,
            'attachments', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', a.id,
                    'media_asset_id', a.media_asset_id,
                    'attachment_type', a.attachment_type,
                    'created_at', a.created_at
                ))
                FROM messaging.message_attachments a
                WHERE a.message_id = m.id
            ), '[]'::jsonb)
        ) AS m_data
        FROM messaging.messages m
        WHERE m.conversation_id = v_conv_id
          AND (v_before_seq IS NULL OR m.sequence_number < v_before_seq)
        ORDER BY m.sequence_number DESC
        LIMIT LEAST(GREATEST(p_limit, 1), 100)
    ) sub;

    RETURN v_messages;
END;
$$;

-- 3. LIST SAHABAT MESSAGES
CREATE OR REPLACE FUNCTION messaging.list_sahabat_messages(
    p_inquiry_id UUID,
    p_limit INT DEFAULT 50,
    p_before_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_conv_id UUID;
    v_before_seq BIGINT;
    v_messages JSONB;
BEGIN
    IF NOT messaging.is_authorized_for_inquiry(p_inquiry_id, true) THEN
        RAISE EXCEPTION 'CAPABILITY_DENIED: Sahabat staff is not authorized for this inquiry.' USING ERRCODE = '42501';
    END IF;

    v_conv_id := messaging.resolve_canonical_conversation(p_inquiry_id);

    IF p_before_id IS NOT NULL THEN
        SELECT sequence_number INTO v_before_seq FROM messaging.messages WHERE id = p_before_id AND conversation_id = v_conv_id;
    END IF;

    SELECT COALESCE(jsonb_agg(m_data ORDER BY m_data->>'sequence_number' ASC), '[]'::jsonb)
    INTO v_messages
    FROM (
        SELECT jsonb_build_object(
            'id', m.id,
            'conversation_id', m.conversation_id,
            'sender_participant_type', m.sender_participant_type,
            'sender_person_id', m.sender_person_id,
            'body', m.body,
            'message_type', m.message_type,
            'status', m.status,
            'sequence_number', m.sequence_number,
            'created_at', m.created_at,
            'attachments', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', a.id,
                    'media_asset_id', a.media_asset_id,
                    'attachment_type', a.attachment_type,
                    'created_at', a.created_at
                ))
                FROM messaging.message_attachments a
                WHERE a.message_id = m.id
            ), '[]'::jsonb)
        ) AS m_data
        FROM messaging.messages m
        WHERE m.conversation_id = v_conv_id
          AND (v_before_seq IS NULL OR m.sequence_number < v_before_seq)
        ORDER BY m.sequence_number DESC
        LIMIT LEAST(GREATEST(p_limit, 1), 100)
    ) sub;

    RETURN v_messages;
END;
$$;

-- 4. SEND CONSUMER MESSAGE
CREATE OR REPLACE FUNCTION messaging.send_consumer_message(
    p_inquiry_id UUID,
    p_body TEXT,
    p_attachment_media_asset_ids UUID[] DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_actor_person_id UUID;
    v_inq_status VARCHAR(32);
    v_target_prov_id UUID;
    v_conv_id UUID;
    v_seq BIGINT;
    v_msg_id UUID;
    v_at TIMESTAMPTZ := clock_timestamp();
    v_asset_id UUID;
    v_valid_asset_count INT;
    v_payload_hash TEXT;
    v_existing_status VARCHAR(32);
    v_existing_hash TEXT;
    v_existing_response JSONB;
    v_result JSONB;
    v_msg_type VARCHAR(32);
BEGIN
    -- Require non-null non-blank Idempotency-Key
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Idempotency-Key header is strictly required.' USING ERRCODE = '22023';
    END IF;

    v_actor_person_id := engagement.current_person_id();
    IF v_actor_person_id IS NULL OR NOT messaging.is_authorized_for_inquiry(p_inquiry_id, false) THEN
        RAISE EXCEPTION 'CAPABILITY_DENIED: Consumer is not authorized for this inquiry.' USING ERRCODE = '42501';
    END IF;

    SELECT status, target_provider_profile_id INTO v_inq_status, v_target_prov_id
    FROM engagement.inquiries WHERE id = p_inquiry_id;

    IF v_inq_status IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    IF v_inq_status IN ('CANCELLED', 'CLOSED') THEN
        RAISE EXCEPTION 'STATE_CONFLICT: Cannot send message to terminal inquiry state %.', v_inq_status USING ERRCODE = '22023';
    END IF;

    IF TRIM(COALESCE(p_body, '')) = '' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Message body cannot be empty.' USING ERRCODE = '22023';
    END IF;

    -- Concurrency-safe Idempotency reservation (using native sha256)
    v_payload_hash := encode(sha256(convert_to('send_consumer_message:' || p_inquiry_id::text || ':' || v_actor_person_id::text || ':' || p_body || ':' || COALESCE(array_to_string(p_attachment_media_asset_ids, ','), ''), 'UTF8')), 'hex');

    SELECT status, request_hash_sha256, response_body
    INTO v_existing_status, v_existing_hash, v_existing_response
    FROM integration.idempotency_keys
    WHERE scope = 'messaging.send_message' AND idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF v_existing_status IS NOT NULL THEN
        IF v_existing_status = 'SUCCEEDED' THEN
            IF v_existing_hash = v_payload_hash THEN
                RETURN v_existing_response;
            ELSE
                RAISE EXCEPTION 'STATE_CONFLICT: Idempotency key reused with different payload.' USING ERRCODE = '23505';
            END IF;
        ELSE
            RAISE EXCEPTION 'STATE_CONFLICT: Concurrent request with same idempotency key is processing.' USING ERRCODE = '23505';
        END IF;
    ELSE
        BEGIN
            INSERT INTO integration.idempotency_keys (
                scope, idempotency_key, request_hash_sha256, actor_key, status, expires_at
            ) VALUES (
                'messaging.send_message', p_idempotency_key, v_payload_hash, v_actor_person_id::text, 'PROCESSING', v_at + interval '24 hours'
            );
        EXCEPTION WHEN unique_violation THEN
            -- Wait for concurrent transaction to complete and inspect result
            SELECT status, request_hash_sha256, response_body
            INTO v_existing_status, v_existing_hash, v_existing_response
            FROM integration.idempotency_keys
            WHERE scope = 'messaging.send_message' AND idempotency_key = p_idempotency_key
            FOR UPDATE;

            IF v_existing_status = 'SUCCEEDED' AND v_existing_hash = v_payload_hash THEN
                RETURN v_existing_response;
            ELSIF v_existing_status = 'SUCCEEDED' AND v_existing_hash <> v_payload_hash THEN
                RAISE EXCEPTION 'STATE_CONFLICT: Idempotency key reused with different payload.' USING ERRCODE = '23505';
            ELSE
                RAISE EXCEPTION 'STATE_CONFLICT: Concurrent request with same idempotency key is processing.' USING ERRCODE = '23505';
            END IF;
        END;
    END IF;

    -- Validate media attachments against Media-owned state (active status, matching provider, active rights, safe derivative)
    IF p_attachment_media_asset_ids IS NOT NULL AND array_length(p_attachment_media_asset_ids, 1) > 0 THEN
        SELECT COUNT(DISTINCT ma.id) INTO v_valid_asset_count
        FROM media.media_assets ma
        JOIN media.media_rights mr ON mr.media_asset_id = ma.id
        JOIN media.media_derivatives md ON md.source_media_asset_id = ma.id
        WHERE ma.id = ANY(p_attachment_media_asset_ids)
          AND ma.status = 'ACTIVE'
          AND ma.owner_provider_profile_id = v_target_prov_id
          AND mr.status = 'ACTIVE'
          AND mr.effective_from <= v_at
          AND (mr.effective_to IS NULL OR mr.effective_to > v_at)
          AND md.is_canonical = true
          AND md.scan_status = 'CLEAN'
          AND md.moderation_status = 'APPROVED'
          AND md.delivery_status = 'DELIVERABLE'
          AND md.effective_from <= v_at
          AND (md.effective_to IS NULL OR md.effective_to > v_at);

        IF v_valid_asset_count <> array_length(p_attachment_media_asset_ids, 1) THEN
            RAISE EXCEPTION 'VALIDATION_FAILED: One or more attachment media assets do not exist, are inactive, lack active rights, lack clean/approved/deliverable canonical derivative, or belong to another provider.' USING ERRCODE = '22023';
        END IF;
        v_msg_type := 'ATTACHMENT';
    ELSE
        v_msg_type := 'TEXT';
    END IF;

    v_conv_id := messaging.resolve_canonical_conversation(p_inquiry_id);

    -- Concurrency-safe Sequence Allocation via deterministic row locking
    PERFORM 1 FROM messaging.conversations WHERE id = v_conv_id FOR UPDATE;

    SELECT COALESCE(MAX(sequence_number), 0) + 1 INTO v_seq
    FROM messaging.messages
    WHERE conversation_id = v_conv_id;

    INSERT INTO messaging.messages (
        conversation_id, sender_participant_type, sender_person_id, body, message_type, status, sequence_number, created_at
    ) VALUES (
        v_conv_id, 'CONSUMER', v_actor_person_id, p_body, v_msg_type, 'SENT', v_seq, v_at
    ) RETURNING id INTO v_msg_id;

    IF p_attachment_media_asset_ids IS NOT NULL THEN
        FOREACH v_asset_id IN ARRAY p_attachment_media_asset_ids LOOP
            INSERT INTO messaging.message_attachments (message_id, media_asset_id, attachment_type, created_at)
            VALUES (v_msg_id, v_asset_id, 'DOCUMENT', v_at);
        END LOOP;
    END IF;

    v_result := jsonb_build_object(
        'id', v_msg_id,
        'conversation_id', v_conv_id,
        'inquiry_id', p_inquiry_id,
        'sender_participant_type', 'CONSUMER',
        'sender_person_id', v_actor_person_id,
        'body', p_body,
        'message_type', v_msg_type,
        'status', 'SENT',
        'sequence_number', v_seq,
        'created_at', v_at,
        'attachments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', a.id,
                'media_asset_id', a.media_asset_id,
                'attachment_type', a.attachment_type,
                'created_at', a.created_at
            ))
            FROM messaging.message_attachments a
            WHERE a.message_id = v_msg_id
        ), '[]'::jsonb)
    );

    UPDATE integration.idempotency_keys SET
        status = 'SUCCEEDED',
        response_status_code = 201,
        response_body = v_result
    WHERE scope = 'messaging.send_message' AND idempotency_key = p_idempotency_key;

    -- Audit Event (Metadata only — ABSOLUTELY NO MESSAGE BODY)
    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'MESSAGE_SENT',
        'messaging.message.send',
        security.context_value('actor_account_key'),
        security.context_value('actor_person_key'),
        security.context_value('local_assignment_key'),
        'messaging',
        'messages',
        v_msg_id::text,
        security.context_value('correlation_id'),
        security.context_value('request_id'),
        jsonb_build_object(
            'inquiry_id', p_inquiry_id,
            'conversation_id', v_conv_id,
            'sender_participant_type', 'CONSUMER',
            'sequence_number', v_seq,
            'has_attachments', (p_attachment_media_asset_ids IS NOT NULL AND array_length(p_attachment_media_asset_ids, 1) > 0)
        ),
        'CONFIDENTIAL'
    );

    -- Outbox Event (Metadata only — ABSOLUTELY NO MESSAGE BODY)
    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'messaging:message:' || v_msg_id::text || ':send:' || extract(epoch from v_at)::text,
        'messaging',
        'conversations',
        v_conv_id::text,
        v_seq,
        'messaging.message_sent',
        jsonb_build_object(
            'message_id', v_msg_id,
            'conversation_id', v_conv_id,
            'inquiry_id', p_inquiry_id,
            'sender_participant_type', 'CONSUMER',
            'sender_person_id', v_actor_person_id,
            'sequence_number', v_seq,
            'created_at', v_at
        ),
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;

-- 5. SEND SAHABAT MESSAGE
CREATE OR REPLACE FUNCTION messaging.send_sahabat_message(
    p_inquiry_id UUID,
    p_body TEXT,
    p_attachment_media_asset_ids UUID[] DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_actor_person_id UUID;
    v_inq_status VARCHAR(32);
    v_target_prov_id UUID;
    v_conv_id UUID;
    v_seq BIGINT;
    v_msg_id UUID;
    v_at TIMESTAMPTZ := clock_timestamp();
    v_asset_id UUID;
    v_valid_asset_count INT;
    v_payload_hash TEXT;
    v_existing_status VARCHAR(32);
    v_existing_hash TEXT;
    v_existing_response JSONB;
    v_result JSONB;
    v_msg_type VARCHAR(32);
BEGIN
    -- Require non-null non-blank Idempotency-Key
    IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Idempotency-Key header is strictly required.' USING ERRCODE = '22023';
    END IF;

    v_actor_person_id := engagement.current_person_id();
    IF v_actor_person_id IS NULL OR NOT messaging.is_authorized_for_inquiry(p_inquiry_id, true) THEN
        RAISE EXCEPTION 'CAPABILITY_DENIED: Sahabat staff is not authorized for this inquiry.' USING ERRCODE = '42501';
    END IF;

    SELECT status, target_provider_profile_id INTO v_inq_status, v_target_prov_id
    FROM engagement.inquiries WHERE id = p_inquiry_id;

    IF v_inq_status IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Inquiry % not found.', p_inquiry_id USING ERRCODE = '22023';
    END IF;

    IF v_inq_status IN ('CANCELLED', 'CLOSED') THEN
        RAISE EXCEPTION 'STATE_CONFLICT: Cannot send message to terminal inquiry state %.', v_inq_status USING ERRCODE = '22023';
    END IF;

    IF TRIM(COALESCE(p_body, '')) = '' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: Message body cannot be empty.' USING ERRCODE = '22023';
    END IF;

    -- Concurrency-safe Idempotency reservation (using native sha256)
    v_payload_hash := encode(sha256(convert_to('send_sahabat_message:' || p_inquiry_id::text || ':' || v_actor_person_id::text || ':' || p_body || ':' || COALESCE(array_to_string(p_attachment_media_asset_ids, ','), ''), 'UTF8')), 'hex');

    SELECT status, request_hash_sha256, response_body
    INTO v_existing_status, v_existing_hash, v_existing_response
    FROM integration.idempotency_keys
    WHERE scope = 'messaging.send_message' AND idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF v_existing_status IS NOT NULL THEN
        IF v_existing_status = 'SUCCEEDED' THEN
            IF v_existing_hash = v_payload_hash THEN
                RETURN v_existing_response;
            ELSE
                RAISE EXCEPTION 'STATE_CONFLICT: Idempotency key reused with different payload.' USING ERRCODE = '23505';
            END IF;
        ELSE
            RAISE EXCEPTION 'STATE_CONFLICT: Concurrent request with same idempotency key is processing.' USING ERRCODE = '23505';
        END IF;
    ELSE
        BEGIN
            INSERT INTO integration.idempotency_keys (
                scope, idempotency_key, request_hash_sha256, actor_key, status, expires_at
            ) VALUES (
                'messaging.send_message', p_idempotency_key, v_payload_hash, v_actor_person_id::text, 'PROCESSING', v_at + interval '24 hours'
            );
        EXCEPTION WHEN unique_violation THEN
            -- Wait for concurrent transaction to complete and inspect result
            SELECT status, request_hash_sha256, response_body
            INTO v_existing_status, v_existing_hash, v_existing_response
            FROM integration.idempotency_keys
            WHERE scope = 'messaging.send_message' AND idempotency_key = p_idempotency_key
            FOR UPDATE;

            IF v_existing_status = 'SUCCEEDED' AND v_existing_hash = v_payload_hash THEN
                RETURN v_existing_response;
            ELSIF v_existing_status = 'SUCCEEDED' AND v_existing_hash <> v_payload_hash THEN
                RAISE EXCEPTION 'STATE_CONFLICT: Idempotency key reused with different payload.' USING ERRCODE = '23505';
            ELSE
                RAISE EXCEPTION 'STATE_CONFLICT: Concurrent request with same idempotency key is processing.' USING ERRCODE = '23505';
            END IF;
        END;
    END IF;

    -- Validate media attachments against Media-owned state (active status, matching provider, active rights, safe derivative)
    IF p_attachment_media_asset_ids IS NOT NULL AND array_length(p_attachment_media_asset_ids, 1) > 0 THEN
        SELECT COUNT(DISTINCT ma.id) INTO v_valid_asset_count
        FROM media.media_assets ma
        JOIN media.media_rights mr ON mr.media_asset_id = ma.id
        JOIN media.media_derivatives md ON md.source_media_asset_id = ma.id
        WHERE ma.id = ANY(p_attachment_media_asset_ids)
          AND ma.status = 'ACTIVE'
          AND ma.owner_provider_profile_id = v_target_prov_id
          AND mr.status = 'ACTIVE'
          AND mr.effective_from <= v_at
          AND (mr.effective_to IS NULL OR mr.effective_to > v_at)
          AND md.is_canonical = true
          AND md.scan_status = 'CLEAN'
          AND md.moderation_status = 'APPROVED'
          AND md.delivery_status = 'DELIVERABLE'
          AND md.effective_from <= v_at
          AND (md.effective_to IS NULL OR md.effective_to > v_at);

        IF v_valid_asset_count <> array_length(p_attachment_media_asset_ids, 1) THEN
            RAISE EXCEPTION 'VALIDATION_FAILED: One or more attachment media assets do not exist, are inactive, lack active rights, lack clean/approved/deliverable canonical derivative, or belong to another provider.' USING ERRCODE = '22023';
        END IF;
        v_msg_type := 'ATTACHMENT';
    ELSE
        v_msg_type := 'TEXT';
    END IF;

    v_conv_id := messaging.resolve_canonical_conversation(p_inquiry_id);

    -- Concurrency-safe Sequence Allocation via deterministic row locking
    PERFORM 1 FROM messaging.conversations WHERE id = v_conv_id FOR UPDATE;

    SELECT COALESCE(MAX(sequence_number), 0) + 1 INTO v_seq
    FROM messaging.messages
    WHERE conversation_id = v_conv_id;

    INSERT INTO messaging.messages (
        conversation_id, sender_participant_type, sender_person_id, body, message_type, status, sequence_number, created_at
    ) VALUES (
        v_conv_id, 'PROVIDER', v_actor_person_id, p_body, v_msg_type, 'SENT', v_seq, v_at
    ) RETURNING id INTO v_msg_id;

    IF p_attachment_media_asset_ids IS NOT NULL THEN
        FOREACH v_asset_id IN ARRAY p_attachment_media_asset_ids LOOP
            INSERT INTO messaging.message_attachments (message_id, media_asset_id, attachment_type, created_at)
            VALUES (v_msg_id, v_asset_id, 'DOCUMENT', v_at);
        END LOOP;
    END IF;

    v_result := jsonb_build_object(
        'id', v_msg_id,
        'conversation_id', v_conv_id,
        'inquiry_id', p_inquiry_id,
        'sender_participant_type', 'PROVIDER',
        'sender_person_id', v_actor_person_id,
        'body', p_body,
        'message_type', v_msg_type,
        'status', 'SENT',
        'sequence_number', v_seq,
        'created_at', v_at,
        'attachments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', a.id,
                'media_asset_id', a.media_asset_id,
                'attachment_type', a.attachment_type,
                'created_at', a.created_at
            ))
            FROM messaging.message_attachments a
            WHERE a.message_id = v_msg_id
        ), '[]'::jsonb)
    );

    UPDATE integration.idempotency_keys SET
        status = 'SUCCEEDED',
        response_status_code = 201,
        response_body = v_result
    WHERE scope = 'messaging.send_message' AND idempotency_key = p_idempotency_key;

    -- Audit Event (Metadata only — ABSOLUTELY NO MESSAGE BODY)
    INSERT INTO audit.audit_events (
        event_type, action_code, actor_account_key, actor_person_key, acting_assignment_key,
        target_schema, target_relation, target_key, correlation_id, request_id, metadata, classification_code
    ) VALUES (
        'MESSAGE_SENT',
        'messaging.message.send',
        security.context_value('actor_account_key'),
        security.context_value('actor_person_key'),
        security.context_value('local_assignment_key'),
        'messaging',
        'messages',
        v_msg_id::text,
        security.context_value('correlation_id'),
        security.context_value('request_id'),
        jsonb_build_object(
            'inquiry_id', p_inquiry_id,
            'conversation_id', v_conv_id,
            'sender_participant_type', 'PROVIDER',
            'sequence_number', v_seq,
            'has_attachments', (p_attachment_media_asset_ids IS NOT NULL AND array_length(p_attachment_media_asset_ids, 1) > 0)
        ),
        'CONFIDENTIAL'
    );

    -- Outbox Event (Metadata only — ABSOLUTELY NO MESSAGE BODY)
    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version,
        event_type, payload, correlation_id
    ) VALUES (
        'messaging:message:' || v_msg_id::text || ':send:' || extract(epoch from v_at)::text,
        'messaging',
        'conversations',
        v_conv_id::text,
        v_seq,
        'messaging.message_sent',
        jsonb_build_object(
            'message_id', v_msg_id,
            'conversation_id', v_conv_id,
            'inquiry_id', p_inquiry_id,
            'sender_participant_type', 'PROVIDER',
            'sender_person_id', v_actor_person_id,
            'sequence_number', v_seq,
            'created_at', v_at
        ),
        security.context_value('correlation_id')
    );

    RETURN v_result;
END;
$$;

-- 6. MARK READ (Hardened cross-conversation check & monotonic read progression)
CREATE OR REPLACE FUNCTION messaging.mark_read(
    p_inquiry_id UUID,
    p_last_read_message_id UUID DEFAULT NULL,
    p_is_sahabat BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = on
AS $$
DECLARE
    v_actor_person_id UUID;
    v_conv_id UUID;
    v_target_msg_id UUID := p_last_read_message_id;
    v_target_seq BIGINT;
    v_current_seq BIGINT;
    v_current_msg_id UUID;
    v_at TIMESTAMPTZ := clock_timestamp();
    v_result JSONB;
BEGIN
    v_actor_person_id := engagement.current_person_id();
    IF v_actor_person_id IS NULL OR NOT messaging.is_authorized_for_inquiry(p_inquiry_id, p_is_sahabat) THEN
        RAISE EXCEPTION 'CAPABILITY_DENIED: Actor is not authorized for this inquiry.' USING ERRCODE = '42501';
    END IF;

    v_conv_id := messaging.resolve_canonical_conversation(p_inquiry_id);

    IF v_target_msg_id IS NOT NULL THEN
        -- Verify supplied last_read_message_id belongs strictly to THIS conversation
        SELECT sequence_number INTO v_target_seq
        FROM messaging.messages
        WHERE id = v_target_msg_id AND conversation_id = v_conv_id;

        IF v_target_seq IS NULL THEN
            RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Message % does not exist in conversation for inquiry %.', v_target_msg_id, p_inquiry_id USING ERRCODE = '22023';
        END IF;
    ELSE
        SELECT id, sequence_number INTO v_target_msg_id, v_target_seq
        FROM messaging.messages
        WHERE conversation_id = v_conv_id
        ORDER BY sequence_number DESC
        LIMIT 1;
    END IF;

    -- Monotonic read check: ensure we do not move read receipt backwards
    SELECT r.last_read_message_id, m.sequence_number
    INTO v_current_msg_id, v_current_seq
    FROM messaging.message_receipts r
    JOIN messaging.messages m ON m.id = r.last_read_message_id
    WHERE r.conversation_id = v_conv_id AND r.reader_person_id = v_actor_person_id;

    IF v_current_seq IS NOT NULL AND v_target_seq < v_current_seq THEN
        v_target_msg_id := v_current_msg_id;
    END IF;

    INSERT INTO messaging.message_receipts (
        conversation_id, last_read_message_id, reader_person_id, receipt_type, read_at, updated_at
    ) VALUES (
        v_conv_id, v_target_msg_id, v_actor_person_id, 'READ', v_at, v_at
    )
    ON CONFLICT (conversation_id, reader_person_id) DO UPDATE SET
        last_read_message_id = COALESCE(EXCLUDED.last_read_message_id, messaging.message_receipts.last_read_message_id),
        read_at = CASE WHEN EXCLUDED.last_read_message_id = messaging.message_receipts.last_read_message_id THEN messaging.message_receipts.read_at ELSE EXCLUDED.read_at END,
        updated_at = EXCLUDED.updated_at;

    v_result := jsonb_build_object(
        'conversation_id', v_conv_id,
        'inquiry_id', p_inquiry_id,
        'reader_person_id', v_actor_person_id,
        'last_read_message_id', v_target_msg_id,
        'read_at', v_at
    );

    RETURN v_result;
END;
$$;

-- Schema Grants & Least Privilege Surface
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA messaging FROM PUBLIC;

GRANT USAGE ON SCHEMA messaging TO vind_db_owner, vind_migrator, vind_app_runtime;
GRANT ALL ON ALL TABLES IN SCHEMA messaging TO vind_db_owner, vind_migrator;
GRANT SELECT ON ALL TABLES IN SCHEMA messaging TO vind_app_runtime;

-- Explicit RPC Grants for Runtime: Expose ONLY intended API surface
GRANT EXECUTE ON FUNCTION messaging.list_consumer_messages(UUID, INT, UUID) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION messaging.list_sahabat_messages(UUID, INT, UUID) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION messaging.send_consumer_message(UUID, TEXT, UUID[], TEXT) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION messaging.send_sahabat_message(UUID, TEXT, UUID[], TEXT) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION messaging.mark_read(UUID, UUID, BOOLEAN) TO vind_app_runtime;

-- Explicitly revoke runtime execution from internal helpers
REVOKE EXECUTE ON FUNCTION messaging.resolve_canonical_conversation(UUID) FROM vind_app_runtime;
REVOKE EXECUTE ON FUNCTION messaging.is_authorized_for_inquiry(UUID, BOOLEAN) FROM vind_app_runtime;
