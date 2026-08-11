-- Migration: 20260811233000_identity_auth_session_persistence
-- Scope: WS02 Identity Server-Side Opaque Session Persistence

-- 1. Create table identity.auth_sessions
CREATE TABLE IF NOT EXISTS identity.auth_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES identity.accounts(id) ON DELETE RESTRICT,
    identity_link_id uuid REFERENCES identity.identity_links(id) ON DELETE RESTRICT,
    authority_plane text NOT NULL,
    local_assignment_id uuid REFERENCES access.scoped_assignments(id) ON DELETE RESTRICT,
    platform_assignment_id uuid REFERENCES access.platform_assignments(id) ON DELETE RESTRICT,
    service_grant_id uuid REFERENCES access.service_principal_grants(id) ON DELETE RESTRICT,
    token_digest bytea NOT NULL UNIQUE,
    auth_assurance_level text NOT NULL,
    step_up_verified_at timestamptz,
    authenticated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    absolute_expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revocation_reason_code text,
    rotated_from_session_id uuid REFERENCES identity.auth_sessions(id) ON DELETE RESTRICT,
    retention_class_code text NOT NULL DEFAULT 'EPH' REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT chk_auth_sessions_token_digest_length CHECK (octet_length(token_digest) = 32),
    CONSTRAINT chk_auth_sessions_authority_plane CHECK (authority_plane IN ('RELATIONSHIP', 'LOCAL', 'PLATFORM', 'SERVICE')),
    CONSTRAINT chk_auth_sessions_absolute_expires CHECK (absolute_expires_at > authenticated_at),
    CONSTRAINT chk_auth_sessions_last_activity CHECK (last_activity_at >= authenticated_at),
    CONSTRAINT chk_auth_sessions_revocation_shape CHECK (
        (revoked_at IS NULL AND revocation_reason_code IS NULL) OR
        (revoked_at IS NOT NULL AND revocation_reason_code IS NOT NULL)
    ),
    CONSTRAINT chk_auth_sessions_authority_xor CHECK (
        (authority_plane = 'RELATIONSHIP' AND local_assignment_id IS NULL AND platform_assignment_id IS NULL AND service_grant_id IS NULL) OR
        (authority_plane = 'LOCAL' AND local_assignment_id IS NOT NULL AND platform_assignment_id IS NULL AND service_grant_id IS NULL) OR
        (authority_plane = 'PLATFORM' AND local_assignment_id IS NULL AND platform_assignment_id IS NOT NULL AND service_grant_id IS NULL) OR
        (authority_plane = 'SERVICE' AND local_assignment_id IS NULL AND platform_assignment_id IS NULL AND service_grant_id IS NOT NULL)
    )
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_auth_sessions_account_id ON identity.auth_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked ON identity.auth_sessions(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_active ON identity.auth_sessions(account_id) WHERE revoked_at IS NULL;

-- 3. Row Level Security & Privileges
ALTER TABLE identity.auth_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE identity.auth_sessions FROM PUBLIC;
REVOKE ALL ON TABLE identity.auth_sessions FROM vind_app_runtime;
REVOKE ALL ON TABLE identity.auth_sessions FROM vind_importer;

-- 4. Function: identity.create_auth_session
CREATE OR REPLACE FUNCTION identity.create_auth_session(
    p_account_id uuid,
    p_token_digest bytea,
    p_authority_plane text,
    p_local_assignment_id uuid DEFAULT NULL,
    p_platform_assignment_id uuid DEFAULT NULL,
    p_service_grant_id uuid DEFAULT NULL,
    p_auth_assurance_level text DEFAULT 'BASIC',
    p_step_up_verified boolean DEFAULT false,
    p_rotated_from_session_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity, public, access, party, security
AS $$
DECLARE
    v_account_type text;
    v_account_status text;
    v_identity_link_id uuid;
    v_identity_link_status text;
    v_person_id uuid;
    v_person_status text;
    v_absolute_ttl interval;
    v_absolute_expires_at timestamptz;
    v_step_up_verified_at timestamptz;
    v_session_id uuid;
BEGIN
    -- Validate digest length
    IF octet_length(p_token_digest) != 32 THEN
        RAISE EXCEPTION 'token_digest must be exactly 32 bytes' USING ERRCODE = '22023';
    END IF;

    -- Validate account
    SELECT account_type, status INTO v_account_type, v_account_status
    FROM identity.accounts
    WHERE id = p_account_id;

    IF v_account_status IS NULL OR v_account_status != 'ACTIVE' THEN
        RAISE EXCEPTION 'Account % is not ACTIVE', p_account_id USING ERRCODE = '28000';
    END IF;

    -- Validate actor kind & identity link
    IF v_account_type = 'HUMAN' THEN
        SELECT id, status, person_id INTO v_identity_link_id, v_identity_link_status, v_person_id
        FROM identity.identity_links
        WHERE account_id = p_account_id AND status = 'ACTIVE' AND is_primary = true;

        IF v_identity_link_id IS NULL THEN
            SELECT id, status, person_id INTO v_identity_link_id, v_identity_link_status, v_person_id
            FROM identity.identity_links
            WHERE account_id = p_account_id AND status = 'ACTIVE'
            LIMIT 1;
        END IF;

        IF v_identity_link_id IS NULL OR v_identity_link_status != 'ACTIVE' THEN
            RAISE EXCEPTION 'HUMAN account % has no ACTIVE identity link', p_account_id USING ERRCODE = '28000';
        END IF;

        SELECT status INTO v_person_status FROM party.persons WHERE id = v_person_id;
        IF v_person_status IS NULL OR v_person_status != 'ACTIVE' THEN
            RAISE EXCEPTION 'Associated person % is not ACTIVE', v_person_id USING ERRCODE = '28000';
        END IF;
    ELSIF v_account_type = 'SERVICE' THEN
        v_identity_link_id := NULL;
        IF p_authority_plane != 'SERVICE' THEN
            RAISE EXCEPTION 'SERVICE account must use SERVICE authority plane' USING ERRCODE = '28000';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unsupported account type: %', v_account_type USING ERRCODE = '28000';
    END IF;

    -- Validate authority plane selectors
    IF p_authority_plane = 'RELATIONSHIP' THEN
        IF p_local_assignment_id IS NOT NULL OR p_platform_assignment_id IS NOT NULL OR p_service_grant_id IS NOT NULL THEN
            RAISE EXCEPTION 'RELATIONSHIP plane must not have assignments' USING ERRCODE = '28000';
        END IF;
        v_absolute_ttl := INTERVAL '8 hours';
    ELSIF p_authority_plane = 'LOCAL' THEN
        IF p_local_assignment_id IS NULL OR p_platform_assignment_id IS NOT NULL OR p_service_grant_id IS NOT NULL THEN
            RAISE EXCEPTION 'LOCAL plane requires local_assignment_id only' USING ERRCODE = '28000';
        END IF;
        PERFORM 1 FROM access.scoped_assignments
        WHERE id = p_local_assignment_id AND subject_person_id = v_person_id AND status = 'ACTIVE';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid or inactive local_assignment_id %', p_local_assignment_id USING ERRCODE = '28000';
        END IF;
        v_absolute_ttl := INTERVAL '8 hours';
    ELSIF p_authority_plane = 'PLATFORM' THEN
        IF p_platform_assignment_id IS NULL OR p_local_assignment_id IS NOT NULL OR p_service_grant_id IS NOT NULL THEN
            RAISE EXCEPTION 'PLATFORM plane requires platform_assignment_id only' USING ERRCODE = '28000';
        END IF;
        PERFORM 1 FROM access.platform_assignments
        WHERE id = p_platform_assignment_id AND subject_person_id = v_person_id AND status = 'ACTIVE';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid or inactive platform_assignment_id %', p_platform_assignment_id USING ERRCODE = '28000';
        END IF;
        v_absolute_ttl := INTERVAL '4 hours';
    ELSIF p_authority_plane = 'SERVICE' THEN
        IF p_service_grant_id IS NULL OR p_local_assignment_id IS NOT NULL OR p_platform_assignment_id IS NOT NULL THEN
            RAISE EXCEPTION 'SERVICE plane requires service_grant_id only' USING ERRCODE = '28000';
        END IF;
        PERFORM 1 FROM access.service_principal_grants
        WHERE id = p_service_grant_id AND subject_account_id = p_account_id AND status = 'ACTIVE';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid or inactive service_grant_id %', p_service_grant_id USING ERRCODE = '28000';
        END IF;
        v_absolute_ttl := INTERVAL '4 hours';
    ELSE
        RAISE EXCEPTION 'Invalid authority_plane: %', p_authority_plane USING ERRCODE = '28000';
    END IF;

    v_absolute_expires_at := clock_timestamp() + v_absolute_ttl;

    IF p_step_up_verified IS TRUE THEN
        v_step_up_verified_at := clock_timestamp();
    ELSE
        v_step_up_verified_at := NULL;
    END IF;

    INSERT INTO identity.auth_sessions (
        account_id,
        identity_link_id,
        authority_plane,
        local_assignment_id,
        platform_assignment_id,
        service_grant_id,
        token_digest,
        auth_assurance_level,
        step_up_verified_at,
        authenticated_at,
        last_activity_at,
        absolute_expires_at,
        rotated_from_session_id,
        retention_class_code
    ) VALUES (
        p_account_id,
        v_identity_link_id,
        p_authority_plane,
        p_local_assignment_id,
        p_platform_assignment_id,
        p_service_grant_id,
        p_token_digest,
        p_auth_assurance_level,
        v_step_up_verified_at,
        clock_timestamp(),
        clock_timestamp(),
        v_absolute_expires_at,
        p_rotated_from_session_id,
        'EPH'
    )
    RETURNING id INTO v_session_id;

    -- Emit Security Lifecycle Event
    INSERT INTO security.security_events (
        event_type,
        severity,
        actor_account_key,
        subject_key,
        retention_class_code
    ) VALUES (
        'AUTH_SESSION_CREATED',
        'INFO',
        p_account_id::text,
        v_session_id::text,
        'SEC'
    );

    RETURN v_session_id;
END;
$$;

-- 5. Function: identity.resolve_auth_session
CREATE OR REPLACE FUNCTION identity.resolve_auth_session(
    p_token_digest bytea
)
RETURNS TABLE (
    session_id uuid,
    account_id uuid,
    person_id uuid,
    actor_kind text,
    authority_plane text,
    membership_id uuid,
    local_assignment_id uuid,
    platform_assignment_id uuid,
    service_grant_id uuid,
    organization_id uuid,
    workspace_id uuid,
    provider_id uuid,
    channel_id uuid,
    region_id uuid,
    auth_assurance_level text,
    step_up_verified boolean,
    absolute_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity, public, access, party, security, organization
AS $$
DECLARE
    v_rec RECORD;
    v_account_type text;
    v_account_status text;
    v_person_id uuid;
    v_person_status text;
    v_identity_link_status text;
    v_idle_ttl interval;
    v_step_up_verified boolean;
    v_membership_id uuid;
    v_org_id uuid;
    v_ws_id uuid;
    v_prov_id uuid;
    v_chan_id uuid;
    v_reg_id uuid;
    v_ass_status text;
    v_eff_to timestamptz;
BEGIN
    SELECT s.* INTO v_rec
    FROM identity.auth_sessions s
    WHERE s.token_digest = p_token_digest
    FOR UPDATE OF s;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF v_rec.revoked_at IS NOT NULL THEN
        RETURN;
    END IF;

    IF clock_timestamp() >= v_rec.absolute_expires_at THEN
        RETURN;
    END IF;

    -- Calculate idle timeout
    IF v_rec.authority_plane IN ('RELATIONSHIP', 'LOCAL') THEN
        v_idle_ttl := INTERVAL '30 minutes';
    ELSE
        v_idle_ttl := INTERVAL '15 minutes';
    END IF;

    IF clock_timestamp() >= (v_rec.last_activity_at + v_idle_ttl) THEN
        RETURN;
    END IF;

    -- Check account status
    SELECT acc.account_type, acc.status INTO v_account_type, v_account_status
    FROM identity.accounts acc
    WHERE acc.id = v_rec.account_id;

    IF v_account_status IS NULL OR v_account_status != 'ACTIVE' THEN
        RETURN;
    END IF;

    -- Resolve person & identity link for HUMAN
    IF v_account_type = 'HUMAN' THEN
        IF v_rec.identity_link_id IS NULL THEN
            RETURN;
        END IF;

        SELECT il.status, il.person_id INTO v_identity_link_status, v_person_id
        FROM identity.identity_links il
        WHERE il.id = v_rec.identity_link_id;

        IF v_identity_link_status IS NULL OR v_identity_link_status != 'ACTIVE' THEN
            RETURN;
        END IF;

        SELECT p.status INTO v_person_status FROM party.persons p WHERE p.id = v_person_id;
        IF v_person_status IS NULL OR v_person_status != 'ACTIVE' THEN
            RETURN;
        END IF;
    ELSE
        v_person_id := NULL;
    END IF;

    -- Validate assignment status and resolve context IDs
    IF v_rec.authority_plane = 'LOCAL' THEN
        SELECT sa.status, sa.membership_id, sa.organization_id, sa.workspace_id, sa.provider_id, sa.effective_to
        INTO v_ass_status, v_membership_id, v_org_id, v_ws_id, v_prov_id, v_eff_to
        FROM access.scoped_assignments sa
        WHERE sa.id = v_rec.local_assignment_id AND sa.subject_person_id = v_person_id;

        IF v_ass_status IS NULL OR v_ass_status != 'ACTIVE' THEN
            RETURN;
        END IF;
        IF v_eff_to IS NOT NULL AND clock_timestamp() > v_eff_to THEN
            RETURN;
        END IF;

        -- If membership_id present, verify membership ACTIVE
        IF v_membership_id IS NOT NULL THEN
            PERFORM 1 FROM access.memberships m WHERE m.id = v_membership_id AND m.status = 'ACTIVE';
            IF NOT FOUND THEN
                RETURN;
            END IF;
        END IF;
    ELSIF v_rec.authority_plane = 'PLATFORM' THEN
        SELECT pa.status, pa.channel_id, pa.region_id, pa.effective_to
        INTO v_ass_status, v_chan_id, v_reg_id, v_eff_to
        FROM access.platform_assignments pa
        WHERE pa.id = v_rec.platform_assignment_id AND pa.subject_person_id = v_person_id;

        IF v_ass_status IS NULL OR v_ass_status != 'ACTIVE' THEN
            RETURN;
        END IF;
        IF v_eff_to IS NOT NULL AND clock_timestamp() > v_eff_to THEN
            RETURN;
        END IF;
    ELSIF v_rec.authority_plane = 'SERVICE' THEN
        SELECT spg.status, spg.channel_id, spg.region_id, spg.effective_to
        INTO v_ass_status, v_chan_id, v_reg_id, v_eff_to
        FROM access.service_principal_grants spg
        WHERE spg.id = v_rec.service_grant_id AND spg.subject_account_id = v_rec.account_id;

        IF v_ass_status IS NULL OR v_ass_status != 'ACTIVE' THEN
            RETURN;
        END IF;
        IF v_eff_to IS NOT NULL AND clock_timestamp() > v_eff_to THEN
            RETURN;
        END IF;
    END IF;

    -- Evaluate Step-up Freshness (<= 15 minutes)
    IF v_rec.step_up_verified_at IS NOT NULL AND v_rec.step_up_verified_at > (clock_timestamp() - INTERVAL '15 minutes') THEN
        v_step_up_verified := true;
    ELSE
        v_step_up_verified := false;
    END IF;

    -- Atomically update last_activity_at
    UPDATE identity.auth_sessions
    SET last_activity_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = v_rec.id;

    RETURN QUERY
    SELECT
        v_rec.id,
        v_rec.account_id,
        v_person_id,
        v_account_type,
        v_rec.authority_plane,
        v_membership_id,
        v_rec.local_assignment_id,
        v_rec.platform_assignment_id,
        v_rec.service_grant_id,
        v_org_id,
        v_ws_id,
        v_prov_id,
        v_chan_id,
        v_reg_id,
        v_rec.auth_assurance_level,
        v_step_up_verified,
        v_rec.absolute_expires_at;
END;
$$;

-- 6. Function: identity.revoke_auth_session
CREATE OR REPLACE FUNCTION identity.revoke_auth_session(
    p_token_digest bytea,
    p_reason_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity, public, security
AS $$
DECLARE
    v_session_id uuid;
    v_account_id uuid;
    v_revoked_at timestamptz;
BEGIN
    SELECT id, account_id, revoked_at INTO v_session_id, v_account_id, v_revoked_at
    FROM identity.auth_sessions
    WHERE token_digest = p_token_digest
    FOR UPDATE;

    IF v_session_id IS NULL THEN
        RETURN false;
    END IF;

    IF v_revoked_at IS NOT NULL THEN
        RETURN true; -- Safe idempotent return
    END IF;

    UPDATE identity.auth_sessions
    SET revoked_at = clock_timestamp(),
        revocation_reason_code = p_reason_code,
        updated_at = clock_timestamp()
    WHERE id = v_session_id;

    INSERT INTO security.security_events (
        event_type,
        severity,
        actor_account_key,
        subject_key,
        retention_class_code
    ) VALUES (
        'AUTH_SESSION_REVOKED',
        'INFO',
        v_account_id::text,
        v_session_id::text,
        'SEC'
    );

    RETURN true;
END;
$$;

-- 7. Function: identity.revoke_account_sessions
CREATE OR REPLACE FUNCTION identity.revoke_account_sessions(
    p_current_token_digest bytea,
    p_reason_code text,
    p_keep_current boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity, public, security
AS $$
DECLARE
    v_current_session_id uuid;
    v_account_id uuid;
    v_count integer := 0;
BEGIN
    SELECT id, account_id INTO v_current_session_id, v_account_id
    FROM identity.auth_sessions
    WHERE token_digest = p_current_token_digest AND revoked_at IS NULL;

    IF v_account_id IS NULL THEN
        RAISE EXCEPTION 'Current session is invalid or revoked' USING ERRCODE = '28000';
    END IF;

    IF p_keep_current IS TRUE THEN
        WITH updated AS (
            UPDATE identity.auth_sessions
            SET revoked_at = clock_timestamp(),
                revocation_reason_code = p_reason_code,
                updated_at = clock_timestamp()
            WHERE account_id = v_account_id AND id != v_current_session_id AND revoked_at IS NULL
            RETURNING id
        )
        SELECT count(*)::integer INTO v_count FROM updated;
    ELSE
        WITH updated AS (
            UPDATE identity.auth_sessions
            SET revoked_at = clock_timestamp(),
                revocation_reason_code = p_reason_code,
                updated_at = clock_timestamp()
            WHERE account_id = v_account_id AND revoked_at IS NULL
            RETURNING id
        )
        SELECT count(*)::integer INTO v_count FROM updated;
    END IF;

    INSERT INTO security.security_events (
        event_type,
        severity,
        actor_account_key,
        subject_key,
        retention_class_code
    ) VALUES (
        'AUTH_ACCOUNT_SESSIONS_REVOKED',
        'INFO',
        v_account_id::text,
        v_account_id::text,
        'SEC'
    );

    RETURN v_count;
END;
$$;

-- 8. Function: identity.rotate_auth_session
CREATE OR REPLACE FUNCTION identity.rotate_auth_session(
    p_old_token_digest bytea,
    p_new_token_digest bytea,
    p_authority_plane text,
    p_local_assignment_id uuid DEFAULT NULL,
    p_platform_assignment_id uuid DEFAULT NULL,
    p_service_grant_id uuid DEFAULT NULL,
    p_auth_assurance_level text DEFAULT 'BASIC',
    p_step_up_verified boolean DEFAULT false,
    p_reason_code text DEFAULT 'SESSION_ROTATED'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity, public, access, party, security
AS $$
DECLARE
    v_old_session_id uuid;
    v_account_id uuid;
    v_new_session_id uuid;
BEGIN
    SELECT id, account_id INTO v_old_session_id, v_account_id
    FROM identity.auth_sessions
    WHERE token_digest = p_old_token_digest AND revoked_at IS NULL AND clock_timestamp() < absolute_expires_at
    FOR UPDATE;

    IF v_old_session_id IS NULL THEN
        RAISE EXCEPTION 'Old session is invalid, expired, or revoked' USING ERRCODE = '28000';
    END IF;

    -- Revoke old session
    UPDATE identity.auth_sessions
    SET revoked_at = clock_timestamp(),
        revocation_reason_code = p_reason_code,
        updated_at = clock_timestamp()
    WHERE id = v_old_session_id;

    -- Create new session linked via rotated_from_session_id
    v_new_session_id := identity.create_auth_session(
        v_account_id,
        p_new_token_digest,
        p_authority_plane,
        p_local_assignment_id,
        p_platform_assignment_id,
        p_service_grant_id,
        p_auth_assurance_level,
        p_step_up_verified,
        v_old_session_id
    );

    INSERT INTO security.security_events (
        event_type,
        severity,
        actor_account_key,
        subject_key,
        retention_class_code
    ) VALUES (
        'AUTH_SESSION_ROTATED',
        'INFO',
        v_account_id::text,
        v_new_session_id::text,
        'SEC'
    );

    RETURN v_new_session_id;
END;
$$;

-- 9. Function: identity.purge_auth_sessions
CREATE OR REPLACE FUNCTION identity.purge_auth_sessions(
    p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity, public
AS $$
DECLARE
    v_deleted_count integer;
BEGIN
    WITH deleted AS (
        DELETE FROM identity.auth_sessions
        WHERE COALESCE(
            revoked_at,
            LEAST(
                absolute_expires_at,
                last_activity_at + (CASE WHEN authority_plane IN ('RELATIONSHIP', 'LOCAL') THEN INTERVAL '30 minutes' ELSE INTERVAL '15 minutes' END)
            )
        ) < (p_at - INTERVAL '7 days')
        RETURNING id
    )
    SELECT count(*)::integer INTO v_deleted_count FROM deleted;

    RETURN v_deleted_count;
END;
$$;

-- 10. Function Grants
GRANT EXECUTE ON FUNCTION identity.create_auth_session TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.resolve_auth_session TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.revoke_auth_session TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.revoke_account_sessions TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.rotate_auth_session TO vind_app_runtime;

REVOKE EXECUTE ON FUNCTION identity.purge_auth_sessions FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.purge_auth_sessions FROM vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.purge_auth_sessions TO vind_db_owner;
