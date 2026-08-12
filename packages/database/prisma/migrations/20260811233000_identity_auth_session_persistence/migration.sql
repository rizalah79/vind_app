-- Migration: 20260811233000_identity_auth_session_persistence
-- Scope: WS02 Identity Server-Side Opaque Session Persistence (Hardened)

-- 1. Create table identity.auth_sessions
CREATE TABLE identity.auth_sessions (
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
CREATE INDEX idx_auth_sessions_account_id ON identity.auth_sessions(account_id);
CREATE INDEX idx_auth_sessions_revoked ON identity.auth_sessions(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX idx_auth_sessions_active ON identity.auth_sessions(account_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_auth_sessions_rotated_from_unique ON identity.auth_sessions(rotated_from_session_id) WHERE rotated_from_session_id IS NOT NULL;

-- 3. Immutability Guard Trigger
DROP FUNCTION IF EXISTS identity.trg_auth_sessions_immutable_guard() CASCADE;

CREATE OR REPLACE FUNCTION identity.trg_auth_sessions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity
SET row_security = off
AS $$
BEGIN
    -- Prevent modification of immutable fields after INSERT
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.account_id IS DISTINCT FROM OLD.account_id OR
       NEW.identity_link_id IS DISTINCT FROM OLD.identity_link_id OR
       NEW.authority_plane IS DISTINCT FROM OLD.authority_plane OR
       NEW.local_assignment_id IS DISTINCT FROM OLD.local_assignment_id OR
       NEW.platform_assignment_id IS DISTINCT FROM OLD.platform_assignment_id OR
       NEW.service_grant_id IS DISTINCT FROM OLD.service_grant_id OR
       NEW.token_digest IS DISTINCT FROM OLD.token_digest OR
       NEW.authenticated_at IS DISTINCT FROM OLD.authenticated_at OR
       NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at OR
       NEW.rotated_from_session_id IS DISTINCT FROM OLD.rotated_from_session_id OR
       NEW.retention_class_code IS DISTINCT FROM OLD.retention_class_code OR
       NEW.auth_assurance_level IS DISTINCT FROM OLD.auth_assurance_level OR
       NEW.step_up_verified_at IS DISTINCT FROM OLD.step_up_verified_at THEN
        RAISE EXCEPTION 'Session immutable identity fields cannot be modified after creation' USING ERRCODE = '27000';
    END IF;

    -- Prevent un-revoking or modifying revocation attributes once set
    IF OLD.revoked_at IS NOT NULL THEN
        IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revocation_reason_code IS DISTINCT FROM OLD.revocation_reason_code THEN
            RAISE EXCEPTION 'Revoked session status and reason cannot be modified' USING ERRCODE = '27000';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auth_sessions_immutable_guard
BEFORE UPDATE ON identity.auth_sessions
FOR EACH ROW
EXECUTE FUNCTION identity.trg_auth_sessions_immutable_guard();

-- 4. Row Level Security & Privileges
ALTER TABLE identity.auth_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE identity.auth_sessions FROM PUBLIC;
REVOKE ALL ON TABLE identity.auth_sessions FROM vind_app_runtime;
REVOKE ALL ON TABLE identity.auth_sessions FROM vind_importer;

-- 5. Helper function for internal session creation (supports rotation lineage)
DROP FUNCTION IF EXISTS identity.create_auth_session_internal CASCADE;
DROP FUNCTION IF EXISTS identity.create_auth_session CASCADE;
DROP FUNCTION IF EXISTS identity.resolve_auth_session CASCADE;
DROP FUNCTION IF EXISTS identity.revoke_auth_session CASCADE;
DROP FUNCTION IF EXISTS identity.revoke_account_sessions CASCADE;
DROP FUNCTION IF EXISTS identity.rotate_auth_session CASCADE;
DROP FUNCTION IF EXISTS identity.purge_auth_sessions CASCADE;

CREATE OR REPLACE FUNCTION identity.create_auth_session_internal(
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
SET search_path = pg_catalog, identity, access, party, security
SET row_security = off
AS $$
DECLARE
    v_account_type text;
    v_account_status text;
    v_account_key text;
    v_identity_link_id uuid;
    v_identity_link_status text;
    v_person_id uuid;
    v_person_status text;
    v_person_key text;
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
    SELECT acc.account_type, acc.status, acc.seed_key
    INTO v_account_type, v_account_status, v_account_key
    FROM identity.accounts acc
    WHERE acc.id = p_account_id;

    IF v_account_status IS NULL OR v_account_status != 'ACTIVE' THEN
        RAISE EXCEPTION 'Account % is not ACTIVE', p_account_id USING ERRCODE = '28000';
    END IF;

    -- Validate actor kind & identity link
    IF v_account_type = 'HUMAN' THEN
        SELECT il.id, il.status, il.person_id INTO v_identity_link_id, v_identity_link_status, v_person_id
        FROM identity.identity_links il
        WHERE il.account_id = p_account_id AND il.status = 'ACTIVE' AND il.is_primary = true;

        IF v_identity_link_id IS NULL THEN
            SELECT il.id, il.status, il.person_id INTO v_identity_link_id, v_identity_link_status, v_person_id
            FROM identity.identity_links il
            WHERE il.account_id = p_account_id AND il.status = 'ACTIVE'
            ORDER BY il.created_at ASC
            LIMIT 1;
        END IF;

        IF v_identity_link_id IS NULL OR v_identity_link_status != 'ACTIVE' THEN
            RAISE EXCEPTION 'HUMAN account % has no ACTIVE identity link', p_account_id USING ERRCODE = '28000';
        END IF;

        SELECT p.status, p.seed_key INTO v_person_status, v_person_key
        FROM party.persons p
        WHERE p.id = v_person_id;

        IF v_person_status IS NULL OR v_person_status != 'ACTIVE' THEN
            RAISE EXCEPTION 'Associated person % is not ACTIVE', v_person_id USING ERRCODE = '28000';
        END IF;
    ELSIF v_account_type = 'SERVICE' THEN
        v_identity_link_id := NULL;
        v_person_key := NULL;
        IF p_authority_plane != 'SERVICE' THEN
            RAISE EXCEPTION 'SERVICE account must use SERVICE authority plane' USING ERRCODE = '28000';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unsupported account type: %', v_account_type USING ERRCODE = '28000';
    END IF;

    -- Validate authority plane selectors and effective periods
    IF p_authority_plane = 'RELATIONSHIP' THEN
        IF p_local_assignment_id IS NOT NULL OR p_platform_assignment_id IS NOT NULL OR p_service_grant_id IS NOT NULL THEN
            RAISE EXCEPTION 'RELATIONSHIP plane must not have assignments' USING ERRCODE = '28000';
        END IF;
        v_absolute_ttl := INTERVAL '8 hours';
    ELSIF p_authority_plane = 'LOCAL' THEN
        IF p_local_assignment_id IS NULL OR p_platform_assignment_id IS NOT NULL OR p_service_grant_id IS NOT NULL THEN
            RAISE EXCEPTION 'LOCAL plane requires local_assignment_id only' USING ERRCODE = '28000';
        END IF;

        PERFORM 1 FROM access.scoped_assignments sa
        WHERE sa.id = p_local_assignment_id
          AND sa.subject_person_id = v_person_id
          AND sa.status = 'ACTIVE'
          AND sa.effective_from <= clock_timestamp()
          AND (sa.effective_to IS NULL OR sa.effective_to > clock_timestamp());

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid, inactive, or un-effective local_assignment_id %', p_local_assignment_id USING ERRCODE = '28000';
        END IF;

        v_absolute_ttl := INTERVAL '8 hours';
    ELSIF p_authority_plane = 'PLATFORM' THEN
        IF p_platform_assignment_id IS NULL OR p_local_assignment_id IS NOT NULL OR p_service_grant_id IS NOT NULL THEN
            RAISE EXCEPTION 'PLATFORM plane requires platform_assignment_id only' USING ERRCODE = '28000';
        END IF;

        PERFORM 1 FROM access.platform_assignments pa
        WHERE pa.id = p_platform_assignment_id
          AND pa.subject_person_id = v_person_id
          AND pa.status = 'ACTIVE'
          AND pa.effective_from <= clock_timestamp()
          AND (pa.effective_to IS NULL OR pa.effective_to > clock_timestamp());

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid, inactive, or un-effective platform_assignment_id %', p_platform_assignment_id USING ERRCODE = '28000';
        END IF;

        v_absolute_ttl := INTERVAL '4 hours';
    ELSIF p_authority_plane = 'SERVICE' THEN
        IF p_service_grant_id IS NULL OR p_local_assignment_id IS NOT NULL OR p_platform_assignment_id IS NOT NULL THEN
            RAISE EXCEPTION 'SERVICE plane requires service_grant_id only' USING ERRCODE = '28000';
        END IF;

        PERFORM 1 FROM access.service_principal_grants spg
        WHERE spg.id = p_service_grant_id
          AND spg.subject_account_id = p_account_id
          AND spg.status = 'ACTIVE'
          AND spg.effective_from <= clock_timestamp()
          AND (spg.effective_to IS NULL OR spg.effective_to > clock_timestamp());

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid, inactive, or un-effective service_grant_id %', p_service_grant_id USING ERRCODE = '28000';
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

    -- Emit Security Lifecycle Event with canonical actor keys
    INSERT INTO security.security_events (
        event_type,
        severity,
        actor_account_key,
        actor_person_key,
        subject_key,
        retention_class_code
    ) VALUES (
        'AUTH_SESSION_CREATED',
        'INFO',
        v_account_key,
        v_person_key,
        v_session_id::text,
        'SEC'
    );

    RETURN v_session_id;
END;
$$;

-- 6. Public runtime create_auth_session (does NOT expose rotation lineage parameter)
CREATE OR REPLACE FUNCTION identity.create_auth_session(
    p_account_id uuid,
    p_token_digest bytea,
    p_authority_plane text,
    p_local_assignment_id uuid DEFAULT NULL,
    p_platform_assignment_id uuid DEFAULT NULL,
    p_service_grant_id uuid DEFAULT NULL,
    p_auth_assurance_level text DEFAULT 'BASIC',
    p_step_up_verified boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, access, party, security
SET row_security = off
AS $$
BEGIN
    RETURN identity.create_auth_session_internal(
        p_account_id,
        p_token_digest,
        p_authority_plane,
        p_local_assignment_id,
        p_platform_assignment_id,
        p_service_grant_id,
        p_auth_assurance_level,
        p_step_up_verified,
        NULL
    );
END;
$$;

-- 7. Resolver Function returning CANONICAL KEYS
CREATE OR REPLACE FUNCTION identity.resolve_auth_session(
    p_token_digest bytea
)
RETURNS TABLE (
    session_id uuid,
    actor_account_key text,
    actor_person_key text,
    actor_kind text,
    authority_plane text,
    membership_key text,
    local_assignment_key text,
    platform_assignment_key text,
    service_grant_key text,
    organization_key text,
    workspace_key text,
    provider_key text,
    channel_code text,
    region_key text,
    auth_assurance_level text,
    step_up_verified boolean,
    absolute_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, access, party, security, organization, provider, listing, geo
SET row_security = off
AS $$
DECLARE
    v_rec RECORD;
    v_account_type text;
    v_account_status text;
    v_account_key text;
    v_person_id uuid;
    v_person_status text;
    v_person_key text;
    v_identity_link_status text;
    v_idle_ttl interval;
    v_step_up_verified boolean;
    v_membership_id uuid;
    v_membership_key text;
    v_local_assignment_key text;
    v_platform_assignment_key text;
    v_service_grant_key text;
    v_org_id uuid;
    v_org_key text;
    v_ws_id uuid;
    v_ws_key text;
    v_prov_id uuid;
    v_prov_key text;
    v_chan_code text;
    v_reg_id uuid;
    v_reg_key text;
    v_ass_status text;
    v_eff_from timestamptz;
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

    -- Calculate idle timeout based on authority plane
    IF v_rec.authority_plane IN ('RELATIONSHIP', 'LOCAL') THEN
        v_idle_ttl := INTERVAL '30 minutes';
    ELSE
        v_idle_ttl := INTERVAL '15 minutes';
    END IF;

    IF clock_timestamp() >= (v_rec.last_activity_at + v_idle_ttl) THEN
        RETURN;
    END IF;

    -- Check account status & key
    SELECT acc.account_type, acc.status, acc.seed_key
    INTO v_account_type, v_account_status, v_account_key
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

        SELECT p.status, p.seed_key INTO v_person_status, v_person_key
        FROM party.persons p
        WHERE p.id = v_person_id;

        IF v_person_status IS NULL OR v_person_status != 'ACTIVE' THEN
            RETURN;
        END IF;
    ELSE
        v_person_id := NULL;
        v_person_key := NULL;
    END IF;

    -- Validate assignment status and resolve context CANONICAL KEYS
    IF v_rec.authority_plane = 'LOCAL' THEN
        SELECT sa.status, sa.membership_id, sa.organization_id, sa.workspace_id, sa.provider_id, sa.seed_key, sa.effective_from, sa.effective_to
        INTO v_ass_status, v_membership_id, v_org_id, v_ws_id, v_prov_id, v_local_assignment_key, v_eff_from, v_eff_to
        FROM access.scoped_assignments sa
        WHERE sa.id = v_rec.local_assignment_id AND sa.subject_person_id = v_person_id;

        IF v_ass_status IS NULL OR v_ass_status != 'ACTIVE' THEN
            RETURN;
        END IF;

        -- Validate effective period
        IF clock_timestamp() < v_eff_from THEN
            RETURN;
        END IF;
        IF v_eff_to IS NOT NULL AND clock_timestamp() > v_eff_to THEN
            RETURN;
        END IF;

        -- Resolve Org key
        IF v_org_id IS NOT NULL THEN
            SELECT o.seed_key INTO v_org_key FROM organization.organizations o WHERE o.id = v_org_id;
        END IF;

        -- Resolve Workspace key
        IF v_ws_id IS NOT NULL THEN
            SELECT w.seed_key INTO v_ws_key FROM organization.workspaces w WHERE w.id = v_ws_id;
        END IF;

        -- Resolve Provider key
        IF v_prov_id IS NOT NULL THEN
            SELECT pp.seed_key INTO v_prov_key FROM provider.provider_profiles pp WHERE pp.id = v_prov_id;
        END IF;

        -- If membership_id present, verify membership ACTIVE and effective
        IF v_membership_id IS NOT NULL THEN
            SELECT m.status, m.seed_key, m.effective_from, m.effective_to
            INTO v_ass_status, v_membership_key, v_eff_from, v_eff_to
            FROM access.memberships m
            WHERE m.id = v_membership_id;

            IF v_ass_status IS NULL OR v_ass_status != 'ACTIVE' THEN
                RETURN;
            END IF;
            IF clock_timestamp() < v_eff_from THEN
                RETURN;
            END IF;
            IF v_eff_to IS NOT NULL AND clock_timestamp() > v_eff_to THEN
                RETURN;
            END IF;
        END IF;

    ELSIF v_rec.authority_plane = 'PLATFORM' THEN
        SELECT pa.status, pa.channel_id, pa.region_id, pa.assignment_key, pa.effective_from, pa.effective_to
        INTO v_ass_status, v_chan_code, v_reg_id, v_platform_assignment_key, v_eff_from, v_eff_to
        FROM access.platform_assignments pa
        WHERE pa.id = v_rec.platform_assignment_id AND pa.subject_person_id = v_person_id;

        IF v_ass_status IS NULL OR v_ass_status != 'ACTIVE' THEN
            RETURN;
        END IF;
        IF clock_timestamp() < v_eff_from THEN
            RETURN;
        END IF;
        IF v_eff_to IS NOT NULL AND clock_timestamp() > v_eff_to THEN
            RETURN;
        END IF;

        -- Resolve channel code if channel_id stored as UUID reference
        IF v_chan_code IS NOT NULL THEN
            SELECT c.code INTO v_chan_code FROM listing.channels c WHERE c.id::text = v_chan_code OR c.code = v_chan_code;
        END IF;

        IF v_reg_id IS NOT NULL THEN
            SELECT r.seed_key INTO v_reg_key FROM geo.regions r WHERE r.id = v_reg_id;
        END IF;

    ELSIF v_rec.authority_plane = 'SERVICE' THEN
        SELECT spg.status, spg.channel_id, spg.region_id, spg.grant_key, spg.effective_from, spg.effective_to
        INTO v_ass_status, v_chan_code, v_reg_id, v_service_grant_key, v_eff_from, v_eff_to
        FROM access.service_principal_grants spg
        WHERE spg.id = v_rec.service_grant_id AND spg.subject_account_id = v_rec.account_id;

        IF v_ass_status IS NULL OR v_ass_status != 'ACTIVE' THEN
            RETURN;
        END IF;
        IF clock_timestamp() < v_eff_from THEN
            RETURN;
        END IF;
        IF v_eff_to IS NOT NULL AND clock_timestamp() > v_eff_to THEN
            RETURN;
        END IF;

        IF v_chan_code IS NOT NULL THEN
            SELECT c.code INTO v_chan_code FROM listing.channels c WHERE c.id::text = v_chan_code OR c.code = v_chan_code;
        END IF;

        IF v_reg_id IS NOT NULL THEN
            SELECT r.seed_key INTO v_reg_key FROM geo.regions r WHERE r.id = v_reg_id;
        END IF;
    END IF;

    -- Evaluate Step-up Freshness (<= 15 minutes)
    IF v_rec.step_up_verified_at IS NOT NULL AND v_rec.step_up_verified_at > (clock_timestamp() - INTERVAL '15 minutes') THEN
        v_step_up_verified := true;
    ELSE
        v_step_up_verified := false;
    END IF;

    -- Atomically update last_activity_at (absolute_expires_at does NOT slide)
    UPDATE identity.auth_sessions
    SET last_activity_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = v_rec.id;

    RETURN QUERY
    SELECT
        v_rec.id,
        v_account_key,
        v_person_key,
        v_account_type,
        v_rec.authority_plane,
        v_membership_key,
        v_local_assignment_key,
        v_platform_assignment_key,
        v_service_grant_key,
        v_org_key,
        v_ws_key,
        v_prov_key,
        v_chan_code,
        v_reg_key,
        v_rec.auth_assurance_level,
        v_step_up_verified,
        v_rec.absolute_expires_at;
END;
$$;

-- 8. Revoke Session Function
CREATE OR REPLACE FUNCTION identity.revoke_auth_session(
    p_token_digest bytea,
    p_reason_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, access, party, security
SET row_security = off
AS $$
DECLARE
    v_session_id uuid;
    v_account_id uuid;
    v_account_key text;
    v_person_key text;
    v_revoked_at timestamptz;
BEGIN
    SELECT s.id, s.account_id, s.revoked_at INTO v_session_id, v_account_id, v_revoked_at
    FROM identity.auth_sessions s
    WHERE s.token_digest = p_token_digest
    FOR UPDATE OF s;

    IF v_session_id IS NULL THEN
        RETURN false;
    END IF;

    -- Idempotent check
    IF v_revoked_at IS NOT NULL THEN
        RETURN true;
    END IF;

    SELECT acc.seed_key INTO v_account_key FROM identity.accounts acc WHERE acc.id = v_account_id;

    SELECT p.seed_key INTO v_person_key
    FROM identity.identity_links il
    JOIN party.persons p ON p.id = il.person_id
    WHERE il.account_id = v_account_id AND il.status = 'ACTIVE'
    ORDER BY il.is_primary DESC, il.created_at ASC
    LIMIT 1;

    UPDATE identity.auth_sessions
    SET revoked_at = clock_timestamp(),
        revocation_reason_code = p_reason_code,
        updated_at = clock_timestamp()
    WHERE id = v_session_id;

    INSERT INTO security.security_events (
        event_type,
        severity,
        actor_account_key,
        actor_person_key,
        subject_key,
        retention_class_code
    ) VALUES (
        'AUTH_SESSION_REVOKED',
        'INFO',
        v_account_key,
        v_person_key,
        v_session_id::text,
        'SEC'
    );

    RETURN true;
END;
$$;

-- 9. Account-Wide Revocation Function
CREATE OR REPLACE FUNCTION identity.revoke_account_sessions(
    p_current_token_digest bytea,
    p_reason_code text,
    p_keep_current boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, access, party, security
SET row_security = off
AS $$
DECLARE
    v_current_session_id uuid;
    v_account_id uuid;
    v_account_key text;
    v_person_key text;
    v_count integer := 0;
BEGIN
    -- Validate current session using resolver contract
    SELECT r.session_id, r.actor_account_key, r.actor_person_key
    INTO v_current_session_id, v_account_key, v_person_key
    FROM identity.resolve_auth_session(p_current_token_digest) r;

    IF v_current_session_id IS NULL THEN
        RAISE EXCEPTION 'Current session is invalid or expired' USING ERRCODE = '28000';
    END IF;

    SELECT acc.id INTO v_account_id FROM identity.accounts acc WHERE acc.seed_key = v_account_key;

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
        actor_person_key,
        subject_key,
        retention_class_code
    ) VALUES (
        'AUTH_ACCOUNT_SESSIONS_REVOKED',
        'INFO',
        v_account_key,
        v_person_key,
        v_account_key,
        'SEC'
    );

    RETURN v_count;
END;
$$;

-- 10. Rotate Auth Session Function
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
SET search_path = pg_catalog, identity, access, party, security
SET row_security = off
AS $$
DECLARE
    v_old_session_id uuid;
    v_account_id uuid;
    v_account_key text;
    v_person_key text;
    v_new_session_id uuid;
BEGIN
    -- Validate old session using resolver contract
    SELECT r.session_id, r.actor_account_key, r.actor_person_key
    INTO v_old_session_id, v_account_key, v_person_key
    FROM identity.resolve_auth_session(p_old_token_digest) r;

    IF v_old_session_id IS NULL THEN
        RAISE EXCEPTION 'Old session is invalid or expired' USING ERRCODE = '28000';
    END IF;

    SELECT acc.id INTO v_account_id FROM identity.accounts acc WHERE acc.seed_key = v_account_key;

    -- Revoke old session
    UPDATE identity.auth_sessions
    SET revoked_at = clock_timestamp(),
        revocation_reason_code = p_reason_code,
        updated_at = clock_timestamp()
    WHERE id = v_old_session_id;

    -- Create new session linked via rotated_from_session_id
    v_new_session_id := identity.create_auth_session_internal(
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
        actor_person_key,
        subject_key,
        retention_class_code
    ) VALUES (
        'AUTH_SESSION_ROTATED',
        'INFO',
        v_account_key,
        v_person_key,
        v_new_session_id::text,
        'SEC'
    );

    RETURN v_new_session_id;
END;
$$;

-- 11. Bounded Purge Auth Sessions Function
CREATE OR REPLACE FUNCTION identity.purge_auth_sessions(
    p_at timestamptz DEFAULT clock_timestamp(),
    p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity
SET row_security = off
AS $$
DECLARE
    v_deleted_count integer;
BEGIN
    IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 10000 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 10000' USING ERRCODE = '22023';
    END IF;

    WITH eligible AS (
        SELECT s.id
        FROM identity.auth_sessions s
        WHERE COALESCE(
            s.revoked_at,
            LEAST(
                s.absolute_expires_at,
                s.last_activity_at + (CASE WHEN s.authority_plane IN ('RELATIONSHIP', 'LOCAL') THEN INTERVAL '30 minutes' ELSE INTERVAL '15 minutes' END)
            )
        ) < (p_at - INTERVAL '7 days')
        ORDER BY s.created_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    deleted AS (
        DELETE FROM identity.auth_sessions s
        WHERE s.id IN (SELECT id FROM eligible)
        RETURNING s.id
    )
    SELECT count(*)::integer INTO v_deleted_count FROM deleted;

    RETURN v_deleted_count;
END;
$$;

-- 12. Strict Revocation of Direct Table Access & Default EXECUTE from PUBLIC, vind_importer, vind_app_runtime
REVOKE ALL ON TABLE identity.auth_sessions FROM PUBLIC, vind_importer, vind_app_runtime;
REVOKE ALL ON FUNCTION identity.create_auth_session(uuid, bytea, text, uuid, uuid, uuid, text, boolean) FROM PUBLIC, vind_importer, vind_app_runtime;
REVOKE ALL ON FUNCTION identity.create_auth_session_internal(uuid, bytea, text, uuid, uuid, uuid, text, boolean, uuid) FROM PUBLIC, vind_importer, vind_app_runtime;
REVOKE ALL ON FUNCTION identity.resolve_auth_session(bytea) FROM PUBLIC, vind_importer, vind_app_runtime;
REVOKE ALL ON FUNCTION identity.revoke_auth_session(bytea, text) FROM PUBLIC, vind_importer, vind_app_runtime;
REVOKE ALL ON FUNCTION identity.revoke_account_sessions(bytea, text, boolean) FROM PUBLIC, vind_importer, vind_app_runtime;
REVOKE ALL ON FUNCTION identity.rotate_auth_session(bytea, bytea, text, uuid, uuid, uuid, text, boolean, text) FROM PUBLIC, vind_importer, vind_app_runtime;
REVOKE ALL ON FUNCTION identity.purge_auth_sessions(timestamptz, integer) FROM PUBLIC, vind_importer, vind_app_runtime;

-- 13. Grant Only Approved Runtime Functions to vind_app_runtime
GRANT EXECUTE ON FUNCTION identity.create_auth_session(uuid, bytea, text, uuid, uuid, uuid, text, boolean) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.resolve_auth_session(bytea) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.revoke_auth_session(bytea, text) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.revoke_account_sessions(bytea, text, boolean) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION identity.rotate_auth_session(bytea, bytea, text, uuid, uuid, uuid, text, boolean, text) TO vind_app_runtime;

-- 15. Forward-Fix for verification.read_evidence Data Access Log Array Type
CREATE OR REPLACE FUNCTION verification.read_evidence(p_evidence_id uuid, p_purpose_code text)
 RETURNS TABLE(id uuid, evidence_type text, document_number_masked text, storage_path_encrypted text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'verification', 'security', 'access'
 SET row_security TO 'off'
AS $function$
DECLARE
    v_actor_person_id uuid;
    v_actor_account_id uuid;
    v_acting_assignment_key text;
    v_correlation_id text;
    v_request_id text;
    v_authorized boolean := false;
BEGIN
    v_actor_person_id := security.current_actor_person_id();
    v_actor_account_id := security.current_actor_account_id();
    v_acting_assignment_key := security.context_value('platform_assignment_key');
    v_correlation_id := security.context_value('correlation_id');
    v_request_id := security.context_value('request_id');

    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM verification.verification_evidence ve WHERE ve.id = p_evidence_id
    ) THEN
        RAISE EXCEPTION 'Verification evidence not found.' USING ERRCODE = '23503';
    END IF;

    IF access.has_platform_capability('verification.evidence.read') THEN
        v_authorized := true;
    END IF;

    IF NOT v_authorized THEN
        RAISE EXCEPTION 'Unauthorized to read verification evidence.' USING ERRCODE = '42501';
    END IF;

    INSERT INTO security.data_access_logs (
        actor_account_key, actor_person_key, acting_assignment_key,
        purpose_code, access_type, target_schema, target_relation, target_key,
        fields_accessed, result_count, correlation_id, request_id
    ) VALUES (
        v_actor_account_id::text, v_actor_person_id::text, v_acting_assignment_key,
        p_purpose_code, 'READ', 'verification', 'verification_evidence', p_evidence_id::text,
        ARRAY['id', 'evidence_type', 'document_number_masked', 'storage_path_encrypted', 'status'],
        1, v_correlation_id, v_request_id
    );

    RETURN QUERY
    SELECT ve.id, ve.evidence_type, ve.document_number_masked, ve.storage_path_encrypted, ve.status
    FROM verification.verification_evidence ve
    WHERE ve.id = p_evidence_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION verification.read_evidence(uuid, text) TO vind_app_runtime;

