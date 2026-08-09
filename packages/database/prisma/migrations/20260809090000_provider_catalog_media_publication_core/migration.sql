-- Migration: 20260809090000_provider_catalog_media_publication_core
-- DB-DEC-021 Physical Schema: Provider, Catalog, Media, Verification, Channel Publication Core, and PROVIDER Access Scope Activation

SET search_path = pg_catalog;

-- Ensure schemas exist
CREATE SCHEMA IF NOT EXISTS provider;
CREATE SCHEMA IF NOT EXISTS verification;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS media;
CREATE SCHEMA IF NOT EXISTS listing;

-- Grant schema usage
GRANT USAGE ON SCHEMA provider, verification, catalog, media, listing TO vind_app_runtime, vind_importer;

-- =========================================================
-- 1. Provider Core Schema (4 relations)
-- =========================================================

CREATE TABLE provider.provider_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    owning_organization_id uuid REFERENCES organization.organizations(id) ON DELETE RESTRICT,
    owning_person_id uuid REFERENCES party.persons(id) ON DELETE RESTRICT,
    provider_type text NOT NULL DEFAULT 'INDIVIDUAL',
    status text NOT NULL DEFAULT 'DRAFT',
    legal_name text NOT NULL,
    display_name text NOT NULL,
    retention_class_code text NOT NULL DEFAULT 'OPS' REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_provider_ownership_xor CHECK (
        (owning_organization_id IS NOT NULL AND owning_person_id IS NULL) OR
        (owning_organization_id IS NULL AND owning_person_id IS NOT NULL)
    ),
    CONSTRAINT chk_provider_type CHECK (provider_type IN ('COMPANY', 'INDIVIDUAL')),
    CONSTRAINT chk_provider_status CHECK (status IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'))
);

CREATE TABLE provider.provider_workspace_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    provider_profile_id uuid NOT NULL REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    managing_organization_id uuid NOT NULL REFERENCES organization.organizations(id) ON DELETE RESTRICT,
    workspace_id uuid REFERENCES organization.workspaces(id) ON DELETE RESTRICT,
    link_status text NOT NULL DEFAULT 'PENDING',
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_link_status CHECK (link_status IN ('PENDING', 'ACTIVE', 'REVOKED')),
    CONSTRAINT chk_provider_workspace_link_period CHECK (effective_to IS NULL OR effective_from <= effective_to)
);

CREATE TABLE provider.capability_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text UNIQUE NOT NULL,
    display_name text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE provider.provider_capabilities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_profile_id uuid NOT NULL REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    capability_definition_id uuid NOT NULL REFERENCES provider.capability_definitions(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT provider_capabilities_unique UNIQUE (provider_profile_id, capability_definition_id)
);

-- =========================================================
-- 2. Verification Core Schema (2 relations)
-- =========================================================

CREATE TABLE verification.verification_cases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    provider_profile_id uuid NOT NULL REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    case_type text NOT NULL,
    status text NOT NULL DEFAULT 'SUBMITTED',
    verified_at timestamptz,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_verification_case_status CHECK (status IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED')),
    CONSTRAINT chk_verification_case_period CHECK (expires_at IS NULL OR verified_at IS NULL OR verified_at <= expires_at)
);

CREATE TABLE verification.verification_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    verification_case_id uuid NOT NULL REFERENCES verification.verification_cases(id) ON DELETE CASCADE,
    evidence_type text NOT NULL,
    document_number_masked text NOT NULL,
    storage_path_encrypted text NOT NULL,
    checksum_sha256 text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    retention_class_code text NOT NULL DEFAULT 'PRIV' REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- =========================================================
-- 3. Catalog Core Schema (5 relations)
-- =========================================================

CREATE TABLE catalog.offerings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    provider_profile_id uuid NOT NULL REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    offering_code text NOT NULL,
    title text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE catalog.resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    provider_profile_id uuid NOT NULL REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    resource_code text NOT NULL,
    title text NOT NULL,
    resource_type text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE catalog.offering_resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    offering_id uuid NOT NULL REFERENCES catalog.offerings(id) ON DELETE CASCADE,
    resource_id uuid NOT NULL REFERENCES catalog.resources(id) ON DELETE CASCADE,
    quantity integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT offering_resources_unique UNIQUE (offering_id, resource_id)
);

CREATE TABLE catalog.packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    provider_profile_id uuid NOT NULL REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    package_code text NOT NULL,
    title text NOT NULL,
    anchor_offering_id uuid NOT NULL REFERENCES catalog.offerings(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE catalog.package_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id uuid NOT NULL REFERENCES catalog.packages(id) ON DELETE CASCADE,
    offering_id uuid NOT NULL REFERENCES catalog.offerings(id) ON DELETE CASCADE,
    quantity integer NOT NULL DEFAULT 1,
    is_optional boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT package_items_unique UNIQUE (package_id, offering_id)
);

-- =========================================================
-- 4. Media & Listing Core Schema (4 relations)
-- =========================================================

CREATE TABLE media.media_assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    owner_provider_profile_id uuid NOT NULL REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    media_type text NOT NULL,
    file_name text NOT NULL,
    file_size_bytes bigint NOT NULL,
    mime_type text NOT NULL,
    checksum_sha256 text NOT NULL,
    storage_path text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_media_status CHECK (status IN ('ACTIVE', 'QUARANTINED', 'UNSAFE', 'INFECTED', 'UNRELEASED'))
);

CREATE TABLE media.media_rights (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    media_asset_id uuid NOT NULL REFERENCES media.media_assets(id) ON DELETE CASCADE,
    rights_type text NOT NULL DEFAULT 'OWNERSHIP',
    status text NOT NULL DEFAULT 'ACTIVE',
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_media_rights_status CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
    CONSTRAINT chk_media_rights_period CHECK (effective_to IS NULL OR effective_from <= effective_to)
);

CREATE TABLE listing.channel_publications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    provider_profile_id uuid NOT NULL REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    offering_id uuid REFERENCES catalog.offerings(id) ON DELETE CASCADE,
    package_id uuid REFERENCES catalog.packages(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES listing.channels(id) ON DELETE RESTRICT,
    channel_code text NOT NULL,
    publication_status text NOT NULL DEFAULT 'DRAFT',
    effective_from timestamptz,
    effective_to timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_pub_target_xor CHECK (
        num_nonnulls(offering_id, package_id) = 1
    ),
    CONSTRAINT chk_publication_status CHECK (
        publication_status IN ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'SUSPENDED')
    ),
    CONSTRAINT chk_channel_publication_period CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_from <= effective_to)
);

CREATE TABLE media.media_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text UNIQUE,
    media_asset_id uuid NOT NULL REFERENCES media.media_assets(id) ON DELETE CASCADE,
    provider_profile_id uuid REFERENCES provider.provider_profiles(id) ON DELETE CASCADE,
    offering_id uuid REFERENCES catalog.offerings(id) ON DELETE CASCADE,
    resource_id uuid REFERENCES catalog.resources(id) ON DELETE CASCADE,
    package_id uuid REFERENCES catalog.packages(id) ON DELETE CASCADE,
    channel_publication_id uuid REFERENCES listing.channel_publications(id) ON DELETE CASCADE,
    link_role text NOT NULL DEFAULT 'PUBLIC_LISTING',
    link_status text NOT NULL DEFAULT 'ACTIVE',
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_media_link_target_xor CHECK (
        num_nonnulls(provider_profile_id, offering_id, resource_id, package_id, channel_publication_id) = 1
    ),
    CONSTRAINT chk_link_role CHECK (link_role IN ('PUBLIC_LISTING', 'INTERNAL_REFERENCE')),
    CONSTRAINT chk_link_status CHECK (link_status IN ('ACTIVE', 'INACTIVE')),
    CONSTRAINT chk_media_link_period CHECK (effective_to IS NULL OR effective_from <= effective_to)
);

-- =========================================================
-- 5. Activate PROVIDER Scope in access.scoped_assignments
-- =========================================================

ALTER TABLE access.scoped_assignments
    ADD COLUMN provider_profile_id uuid REFERENCES provider.provider_profiles(id) ON DELETE RESTRICT;

ALTER TABLE access.scoped_assignments
    DROP CONSTRAINT scoped_assignments_scope_valid;

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_scope_valid
    CHECK (
        (
            scope_type = 'PERSON'
            AND subject_person_id IS NOT NULL
            AND scope_person_id = subject_person_id
            AND membership_id IS NULL
            AND organization_id IS NULL
            AND workspace_id IS NULL
            AND provider_profile_id IS NULL
        ) OR (
            scope_type = 'ORGANIZATION'
            AND subject_person_id IS NOT NULL
            AND scope_person_id IS NULL
            AND membership_id IS NOT NULL
            AND organization_id IS NOT NULL
            AND workspace_id IS NULL
            AND provider_profile_id IS NULL
        ) OR (
            scope_type = 'WORKSPACE'
            AND subject_person_id IS NOT NULL
            AND scope_person_id IS NULL
            AND membership_id IS NOT NULL
            AND organization_id IS NOT NULL
            AND workspace_id IS NOT NULL
            AND provider_profile_id IS NULL
        ) OR (
            scope_type = 'PROVIDER'
            AND subject_person_id IS NOT NULL
            AND scope_person_id IS NULL
            AND membership_id IS NOT NULL
            AND organization_id IS NOT NULL
            AND provider_profile_id IS NOT NULL
        )
    );

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_provider_no_overlap
    EXCLUDE USING gist (
        subject_person_id WITH =,
        role_code WITH =,
        provider_profile_id WITH =,
        tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz), '[)') WITH &&
    ) WHERE (status = 'ACTIVE' AND scope_type = 'PROVIDER');

CREATE INDEX scoped_assignments_provider_idx
    ON access.scoped_assignments(provider_profile_id, status)
    WHERE (provider_profile_id IS NOT NULL);

CREATE OR REPLACE FUNCTION access.validate_scoped_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, access, party, organization, provider
AS $function$
DECLARE
    v_person_status text;
    v_membership_person_id uuid;
    v_membership_organization_id uuid;
    v_membership_status text;
    v_workspace_organization_id uuid;
    v_provider_owning_org_id uuid;
BEGIN
    SELECT status INTO v_person_status
    FROM party.persons
    WHERE id = NEW.subject_person_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Subject person does not exist' USING ERRCODE = '23503';
    END IF;

    IF v_person_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Subject person is not ACTIVE' USING ERRCODE = '23514';
    END IF;

    IF NEW.scope_type = 'PERSON' THEN
        RETURN NEW;
    END IF;

    SELECT person_id, organization_id, status
    INTO v_membership_person_id, v_membership_organization_id, v_membership_status
    FROM access.memberships
    WHERE id = NEW.membership_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membership does not exist' USING ERRCODE = '23503';
    END IF;

    IF v_membership_person_id <> NEW.subject_person_id THEN
        RAISE EXCEPTION 'Assignment subject differs from membership person' USING ERRCODE = '23514';
    END IF;

    IF v_membership_organization_id <> NEW.organization_id THEN
        RAISE EXCEPTION 'Assignment organization differs from membership organization' USING ERRCODE = '23514';
    END IF;

    IF NEW.scope_type = 'WORKSPACE' THEN
        SELECT organization_id INTO v_workspace_organization_id
        FROM organization.workspaces
        WHERE id = NEW.workspace_id;

        IF NOT FOUND OR v_workspace_organization_id <> NEW.organization_id THEN
            RAISE EXCEPTION 'Assignment workspace does not belong to organization' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.scope_type = 'PROVIDER' THEN
        SELECT owning_organization_id INTO v_provider_owning_org_id
        FROM provider.provider_profiles
        WHERE id = NEW.provider_profile_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Assignment provider profile does not exist' USING ERRCODE = '23503';
        END IF;

        IF v_provider_owning_org_id <> NEW.organization_id AND NOT EXISTS (
            SELECT 1 FROM provider.provider_workspace_links
            WHERE provider_profile_id = NEW.provider_profile_id
              AND managing_organization_id = NEW.organization_id
              AND link_status = 'ACTIVE'
        ) THEN
            RAISE EXCEPTION 'Assignment provider profile does not belong to organization or workspace link' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

-- =========================================================
-- Cross-Provider Constraint Triggers
-- =========================================================

CREATE OR REPLACE FUNCTION catalog.check_offering_resource_provider_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_offering_prov uuid;
    v_resource_prov uuid;
BEGIN
    SELECT provider_profile_id INTO v_offering_prov FROM catalog.offerings WHERE id = NEW.offering_id;
    SELECT provider_profile_id INTO v_resource_prov FROM catalog.resources WHERE id = NEW.resource_id;

    IF v_offering_prov <> v_resource_prov THEN
        RAISE EXCEPTION 'Cross-provider offering and resource linkage is prohibited.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_offering_resource_provider_consistency
    BEFORE INSERT OR UPDATE ON catalog.offering_resources
    FOR EACH ROW EXECUTE FUNCTION catalog.check_offering_resource_provider_consistency();

CREATE OR REPLACE FUNCTION catalog.check_package_provider_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_anchor_prov uuid;
BEGIN
    SELECT provider_profile_id INTO v_anchor_prov FROM catalog.offerings WHERE id = NEW.anchor_offering_id;

    IF NEW.provider_profile_id <> v_anchor_prov THEN
        RAISE EXCEPTION 'Package provider_profile_id must match anchor offering provider.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_package_provider_consistency
    BEFORE INSERT OR UPDATE ON catalog.packages
    FOR EACH ROW EXECUTE FUNCTION catalog.check_package_provider_consistency();

-- =========================================================
-- Direct Protected Update Denial Triggers (SQLSTATE 42501)
-- =========================================================

CREATE OR REPLACE FUNCTION provider.prevent_direct_provider_status_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = provider, security, pg_catalog
AS $function$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status
       AND current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Direct update on protected status column of provider.provider_profiles is denied. Must use provider.execute_provider_status_command.'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_prevent_direct_provider_status_update
    BEFORE UPDATE ON provider.provider_profiles
    FOR EACH ROW EXECUTE FUNCTION provider.prevent_direct_provider_status_update();

CREATE OR REPLACE FUNCTION provider.prevent_direct_workspace_link_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = provider, security, pg_catalog
AS $function$
BEGIN
    IF current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Direct modification of provider.provider_workspace_links is denied.'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_prevent_direct_workspace_link_update
    BEFORE UPDATE OR INSERT OR DELETE ON provider.provider_workspace_links
    FOR EACH ROW EXECUTE FUNCTION provider.prevent_direct_workspace_link_update();

CREATE OR REPLACE FUNCTION listing.prevent_direct_publication_status_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = listing, security, pg_catalog
AS $function$
BEGIN
    IF OLD.publication_status IS DISTINCT FROM NEW.publication_status
       AND current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Direct update on protected publication_status column of listing.channel_publications is denied. Must use listing.execute_publication_command.'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_prevent_direct_publication_status_update
    BEFORE UPDATE ON listing.channel_publications
    FOR EACH ROW EXECUTE FUNCTION listing.prevent_direct_publication_status_update();

-- =========================================================
-- Restricted Verification Evidence Access Function
-- =========================================================

DROP FUNCTION IF EXISTS verification.read_evidence CASCADE;

CREATE OR REPLACE FUNCTION verification.read_evidence(
    p_evidence_id uuid,
    p_purpose_code text DEFAULT 'VERIFICATION'
)
RETURNS TABLE (
    id uuid,
    evidence_type text,
    document_number_masked text,
    storage_path_encrypted text,
    status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = verification, provider, access, organization, security, pg_catalog
AS $function$
DECLARE
    v_actor_person_id uuid;
    v_prov_id uuid;
    v_owning_org_id uuid;
    v_authorized boolean := false;
BEGIN
    v_actor_person_id := security.current_actor_person_id();
    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
    END IF;

    SELECT vc.provider_profile_id, pr.owning_organization_id
    INTO v_prov_id, v_owning_org_id
    FROM verification.verification_evidence ve
    JOIN verification.verification_cases vc ON vc.id = ve.verification_case_id
    JOIN provider.provider_profiles pr ON pr.id = vc.provider_profile_id
    WHERE ve.id = p_evidence_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Verification evidence not found.' USING ERRCODE = '23503';
    END IF;

    IF access.has_local_capability('verification.evidence.read', 'PROVIDER', NULL, v_owning_org_id, NULL, v_prov_id)
       OR security.current_organization_id() = v_owning_org_id
       OR EXISTS (
           SELECT 1 FROM provider.provider_workspace_links
           WHERE provider_profile_id = v_prov_id
             AND managing_organization_id = security.current_organization_id()
             AND link_status = 'ACTIVE'
       )
       OR access.has_platform_capability('verification.evidence.read')
    THEN
        v_authorized := true;
    END IF;

    IF NOT v_authorized THEN
        RAISE EXCEPTION 'Unauthorized to read verification evidence.' USING ERRCODE = '42501';
    END IF;

    -- Record access log entry
    INSERT INTO security.data_access_logs (
        actor_person_key, purpose_code, access_type, target_schema, target_relation, target_key
    ) VALUES (
        v_actor_person_id::text, p_purpose_code, 'READ', 'verification', 'verification_evidence', p_evidence_id::text
    );

    RETURN QUERY
    SELECT ve.id, ve.evidence_type, ve.document_number_masked, ve.storage_path_encrypted, ve.status
    FROM verification.verification_evidence ve
    WHERE ve.id = p_evidence_id;
END;
$function$;

-- =========================================================
-- Command Stored Procedures (Idempotency + Audit + Outbox)
-- =========================================================

DROP FUNCTION IF EXISTS provider.execute_provider_status_command CASCADE;
DROP FUNCTION IF EXISTS listing.execute_publication_command CASCADE;

CREATE OR REPLACE FUNCTION provider.execute_provider_status_command(
    p_provider_profile_id uuid,
    p_target_status text,
    p_reason_code text DEFAULT NULL,
    p_idempotency_key text DEFAULT NULL,
    p_correlation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = provider, access, organization, verification, audit, integration, security, pg_catalog
AS $function$
DECLARE
    v_actor_person_id uuid;
    v_actor_account_id uuid;
    v_current_status text;
    v_owning_org_id uuid;
    v_response jsonb;
    v_scope text := 'provider:status_command';
    v_idempotency_record record;
    v_current_hash text;
    v_authorized boolean := false;
BEGIN
    v_actor_person_id := security.current_actor_person_id();
    v_actor_account_id := security.current_actor_account_id();

    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to execute provider status command.'
            USING ERRCODE = '42501';
    END IF;

    SELECT status, owning_organization_id INTO v_current_status, v_owning_org_id
    FROM provider.provider_profiles
    WHERE id = p_provider_profile_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Provider profile not found.' USING ERRCODE = '23503';
    END IF;

    -- Capability & tenant-boundary authorization check
    IF access.has_local_capability('provider.status.manage', 'PROVIDER', NULL, v_owning_org_id, NULL, p_provider_profile_id)
       OR security.current_organization_id() = v_owning_org_id
       OR EXISTS (
           SELECT 1 FROM provider.provider_workspace_links
           WHERE provider_profile_id = p_provider_profile_id
             AND managing_organization_id = security.current_organization_id()
             AND link_status = 'ACTIVE'
       )
       OR access.has_platform_capability('provider.status.manage')
    THEN
        v_authorized := true;
    END IF;

    IF NOT v_authorized THEN
        RAISE EXCEPTION 'Unauthorized to execute provider status command.' USING ERRCODE = '42501';
    END IF;

    v_current_hash := encode(sha256((p_provider_profile_id::text || ':' || p_target_status)::bytea), 'hex');

    IF p_idempotency_key IS NOT NULL THEN
        SELECT status, request_hash_sha256, response_body INTO v_idempotency_record
        FROM integration.idempotency_keys
        WHERE scope = v_scope AND idempotency_key = p_idempotency_key;

        IF FOUND THEN
            IF v_idempotency_record.request_hash_sha256 <> v_current_hash THEN
                RAISE EXCEPTION 'Idempotency key hash mismatch conflict.'
                    USING ERRCODE = '22023';
            END IF;
            IF v_idempotency_record.status = 'SUCCEEDED' THEN
                RETURN v_idempotency_record.response_body;
            END IF;
        END IF;

        INSERT INTO integration.idempotency_keys (
            scope, idempotency_key, request_hash_sha256, actor_key, correlation_id, status, expires_at
        ) VALUES (
            v_scope, p_idempotency_key, v_current_hash,
            v_actor_person_id::text, p_correlation_id, 'PROCESSING', clock_timestamp() + interval '24 hours'
        ) ON CONFLICT (scope, idempotency_key) DO NOTHING;
    END IF;

    PERFORM set_config('vind.command_execution_active', 'on', true);

    UPDATE provider.provider_profiles
    SET status = p_target_status, updated_at = clock_timestamp()
    WHERE id = p_provider_profile_id;

    IF p_target_status IN ('SUSPENDED', 'ARCHIVED') THEN
        UPDATE listing.channel_publications
        SET publication_status = 'SUSPENDED', updated_at = clock_timestamp()
        WHERE provider_profile_id = p_provider_profile_id;
    END IF;

    v_response := jsonb_build_object(
        'status', 'SUCCESS',
        'provider_profile_id', p_provider_profile_id,
        'previous_status', v_current_status,
        'new_status', p_target_status
    );

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_person_key, actor_account_key,
        target_schema, target_relation, target_key, reason_code, correlation_id, after_state, classification_code
    ) VALUES (
        'PROVIDER_STATUS_CHANGED', 'UPDATE_STATUS', v_actor_person_id::text, v_actor_account_id::text,
        'provider', 'provider_profiles', p_provider_profile_id::text, p_reason_code, p_correlation_id, v_response, 'INTERNAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version, event_type, payload, correlation_id, status
    ) VALUES (
        gen_random_uuid()::text, 'provider', 'provider_profiles', p_provider_profile_id::text, 1,
        'PROVIDER_STATUS_CHANGED', v_response, p_correlation_id, 'PENDING'
    );

    IF p_idempotency_key IS NOT NULL THEN
        UPDATE integration.idempotency_keys
        SET status = 'SUCCEEDED', response_body = v_response, updated_at = clock_timestamp()
        WHERE scope = v_scope AND idempotency_key = p_idempotency_key;
    END IF;

    RETURN v_response;
END;
$function$;

CREATE OR REPLACE FUNCTION listing.execute_publication_command(
    p_channel_publication_id uuid,
    p_target_publication_status text,
    p_reason_code text DEFAULT NULL,
    p_idempotency_key text DEFAULT NULL,
    p_correlation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = listing, catalog, provider, verification, media, access, organization, audit, integration, security, pg_catalog
AS $function$
DECLARE
    v_actor_person_id uuid;
    v_actor_account_id uuid;
    v_prov_id uuid;
    v_prov_status text;
    v_owning_org_id uuid;
    v_approved_verif_count integer;
    v_invalid_media_count integer;
    v_current_pub_status text;
    v_response jsonb;
    v_scope text := 'listing:publication_command';
    v_idempotency_record record;
    v_current_hash text;
    v_authorized boolean := false;
BEGIN
    v_actor_person_id := security.current_actor_person_id();
    v_actor_account_id := security.current_actor_account_id();

    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
    END IF;

    SELECT publication_status, provider_profile_id INTO v_current_pub_status, v_prov_id
    FROM listing.channel_publications WHERE id = p_channel_publication_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Channel publication not found.' USING ERRCODE = '23503';
    END IF;

    SELECT status, owning_organization_id INTO v_prov_status, v_owning_org_id
    FROM provider.provider_profiles WHERE id = v_prov_id;

    -- Capability & tenant-boundary authorization check
    IF access.has_local_capability('listing.publication.transition', 'PROVIDER', NULL, v_owning_org_id, NULL, v_prov_id)
       OR security.current_organization_id() = v_owning_org_id
       OR EXISTS (
           SELECT 1 FROM provider.provider_workspace_links
           WHERE provider_profile_id = v_prov_id
             AND managing_organization_id = security.current_organization_id()
             AND link_status = 'ACTIVE'
       )
       OR access.has_platform_capability('listing.publication.transition')
    THEN
        v_authorized := true;
    END IF;

    IF NOT v_authorized THEN
        RAISE EXCEPTION 'Unauthorized to execute publication command.' USING ERRCODE = '42501';
    END IF;

    v_current_hash := encode(sha256((p_channel_publication_id::text || ':' || p_target_publication_status)::bytea), 'hex');

    IF p_idempotency_key IS NOT NULL THEN
        SELECT status, request_hash_sha256, response_body INTO v_idempotency_record
        FROM integration.idempotency_keys
        WHERE scope = v_scope AND idempotency_key = p_idempotency_key;

        IF FOUND THEN
            IF v_idempotency_record.request_hash_sha256 <> v_current_hash THEN
                RAISE EXCEPTION 'Idempotency key hash mismatch conflict.'
                    USING ERRCODE = '22023';
            END IF;
            IF v_idempotency_record.status = 'SUCCEEDED' THEN
                RETURN v_idempotency_record.response_body;
            END IF;
        END IF;

        INSERT INTO integration.idempotency_keys (
            scope, idempotency_key, request_hash_sha256, actor_key, correlation_id, status, expires_at
        ) VALUES (
            v_scope, p_idempotency_key, v_current_hash,
            v_actor_person_id::text, p_correlation_id, 'PROCESSING', clock_timestamp() + interval '24 hours'
        ) ON CONFLICT (scope, idempotency_key) DO NOTHING;
    END IF;

    -- Gate 1: Provider ACTIVE check
    IF p_target_publication_status IN ('APPROVED', 'PUBLISHED') AND v_prov_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Cannot publish. Provider profile status must be ACTIVE.' USING ERRCODE = '23514';
    END IF;

    -- Gate 2: Verification APPROVED check
    IF p_target_publication_status IN ('APPROVED', 'PUBLISHED') THEN
        SELECT count(*)::integer INTO v_approved_verif_count
        FROM verification.verification_cases
        WHERE provider_profile_id = v_prov_id AND status = 'APPROVED'
          AND (expires_at IS NULL OR expires_at > clock_timestamp());

        IF v_approved_verif_count = 0 THEN
            RAISE EXCEPTION 'Cannot publish. Active APPROVED verification case required.' USING ERRCODE = '23514';
        END IF;
    END IF;

    -- Gate 3: Media safety and rights provenance check for direct PUBLIC_LISTING media
    IF p_target_publication_status IN ('APPROVED', 'PUBLISHED') THEN
        SELECT count(*)::integer INTO v_invalid_media_count
        FROM media.media_links ml
        JOIN media.media_assets ma ON ma.id = ml.media_asset_id
        LEFT JOIN media.media_rights mr ON mr.media_asset_id = ma.id AND mr.status = 'ACTIVE' AND (mr.effective_to IS NULL OR mr.effective_to > clock_timestamp())
        WHERE ml.channel_publication_id = p_channel_publication_id
          AND ml.link_role = 'PUBLIC_LISTING' AND ml.link_status = 'ACTIVE'
          AND (ml.effective_to IS NULL OR ml.effective_to > clock_timestamp())
          AND (ma.status <> 'ACTIVE' OR mr.id IS NULL);

        IF v_invalid_media_count > 0 THEN
            RAISE EXCEPTION 'Cannot publish. Unsafe media or missing rights provenance detected.' USING ERRCODE = '23514';
        END IF;
    END IF;

    PERFORM set_config('vind.command_execution_active', 'on', true);

    UPDATE listing.channel_publications
    SET publication_status = p_target_publication_status, updated_at = clock_timestamp()
    WHERE id = p_channel_publication_id;

    v_response := jsonb_build_object(
        'status', 'SUCCESS',
        'channel_publication_id', p_channel_publication_id,
        'previous_publication_status', v_current_pub_status,
        'new_publication_status', p_target_publication_status
    );

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_person_key, actor_account_key,
        target_schema, target_relation, target_key, reason_code, correlation_id, after_state, classification_code
    ) VALUES (
        'PUBLICATION_STATUS_CHANGED', 'UPDATE_PUBLICATION_STATUS', v_actor_person_id::text, v_actor_account_id::text,
        'listing', 'channel_publications', p_channel_publication_id::text, p_reason_code, p_correlation_id, v_response, 'INTERNAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version, event_type, payload, correlation_id, status
    ) VALUES (
        gen_random_uuid()::text, 'listing', 'channel_publications', p_channel_publication_id::text, 1,
        'PUBLICATION_STATUS_CHANGED', v_response, p_correlation_id, 'PENDING'
    );

    IF p_idempotency_key IS NOT NULL THEN
        UPDATE integration.idempotency_keys
        SET status = 'SUCCEEDED', response_body = v_response, updated_at = clock_timestamp()
        WHERE scope = v_scope AND idempotency_key = p_idempotency_key;
    END IF;

    RETURN v_response;
END;
$function$;

-- =========================================================
-- Update access.has_local_capability for PROVIDER Scope
-- =========================================================

CREATE OR REPLACE FUNCTION access.has_local_capability(
    p_capability_code text,
    p_scope_type text,
    p_scope_person_id uuid DEFAULT NULL,
    p_organization_id uuid DEFAULT NULL,
    p_workspace_id uuid DEFAULT NULL,
    p_provider_id uuid DEFAULT NULL,
    p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, access, security, party, organization, provider
SET row_security = off
AS $function$
    SELECT CASE
        WHEN security.context_value('context_initialized') <> 'true'
          OR security.context_value('context_version') <> '2'
          OR security.context_value('actor_kind') <> 'HUMAN'
          OR security.context_value('authority_plane') <> 'LOCAL'
        THEN false
        ELSE EXISTS (
            SELECT 1
            FROM access.scoped_assignments sa
            JOIN access.roles r
              ON r.code = sa.role_code
             AND r.authority_plane = 'SAHABAT'
             AND r.is_active = true
            JOIN access.role_capabilities rc
              ON rc.role_code = sa.role_code
             AND rc.capability_code = p_capability_code
             AND rc.effect = 'ALLOW'
            JOIN access.capabilities c
              ON c.code = rc.capability_code
             AND c.is_active = true
            WHERE sa.seed_key = security.context_value('local_assignment_key')
              AND sa.subject_person_id = security.current_actor_person_id()
              AND sa.status = 'ACTIVE'
              AND sa.effective_from <= p_at
              AND (sa.effective_to IS NULL OR sa.effective_to > p_at)
              AND (
                  (
                      p_scope_type = 'PERSON'
                      AND sa.scope_type = 'PERSON'
                      AND sa.scope_person_id = p_scope_person_id
                      AND sa.scope_person_id = security.current_actor_person_id()
                  )
                  OR
                  (
                      p_scope_type = 'ORGANIZATION'
                      AND sa.scope_type = 'ORGANIZATION'
                      AND sa.organization_id = p_organization_id
                      AND EXISTS (
                          SELECT 1
                          FROM access.memberships m
                          WHERE m.id = sa.membership_id
                            AND m.person_id = sa.subject_person_id
                            AND m.organization_id = sa.organization_id
                            AND m.status = 'ACTIVE'
                            AND m.effective_from <= p_at
                            AND (m.effective_to IS NULL OR m.effective_to > p_at)
                      )
                  )
                  OR
                  (
                      p_scope_type = 'WORKSPACE'
                      AND sa.scope_type = 'WORKSPACE'
                      AND sa.organization_id = p_organization_id
                      AND sa.workspace_id = p_workspace_id
                      AND EXISTS (
                          SELECT 1
                          FROM access.memberships m
                          WHERE m.id = sa.membership_id
                            AND m.person_id = sa.subject_person_id
                            AND m.organization_id = sa.organization_id
                            AND m.status = 'ACTIVE'
                            AND m.effective_from <= p_at
                            AND (m.effective_to IS NULL OR m.effective_to > p_at)
                      )
                      AND EXISTS (
                          SELECT 1
                          FROM organization.workspaces w
                          WHERE w.id = sa.workspace_id
                            AND w.organization_id = sa.organization_id
                            AND w.status = 'ACTIVE'
                      )
                  )
                  OR
                  (
                      p_scope_type = 'PROVIDER'
                      AND sa.scope_type = 'PROVIDER'
                      AND sa.provider_profile_id = p_provider_id
                      AND sa.organization_id = p_organization_id
                      AND EXISTS (
                          SELECT 1
                          FROM access.memberships m
                          WHERE m.id = sa.membership_id
                            AND m.person_id = sa.subject_person_id
                            AND m.organization_id = sa.organization_id
                            AND m.status = 'ACTIVE'
                            AND m.effective_from <= p_at
                            AND (m.effective_to IS NULL OR m.effective_to > p_at)
                      )
                      AND EXISTS (
                          SELECT 1
                          FROM provider.provider_profiles pr
                          WHERE pr.id = sa.provider_profile_id
                            AND (
                                pr.owning_organization_id = sa.organization_id
                                OR EXISTS (
                                    SELECT 1
                                    FROM provider.provider_workspace_links pwl
                                    WHERE pwl.provider_profile_id = pr.id
                                      AND pwl.managing_organization_id = sa.organization_id
                                      AND pwl.link_status = 'ACTIVE'
                                )
                            )
                      )
                  )
              )
        )
    END;
$function$;

-- =========================================================
-- Row-Level Security (RLS) Policies (15 tables)
-- =========================================================

ALTER TABLE provider.provider_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_profiles FORCE ROW LEVEL SECURITY;

ALTER TABLE provider.provider_workspace_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_workspace_links FORCE ROW LEVEL SECURITY;

ALTER TABLE provider.capability_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.capability_definitions FORCE ROW LEVEL SECURITY;

ALTER TABLE provider.provider_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider.provider_capabilities FORCE ROW LEVEL SECURITY;

ALTER TABLE verification.verification_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification.verification_cases FORCE ROW LEVEL SECURITY;

ALTER TABLE verification.verification_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification.verification_evidence FORCE ROW LEVEL SECURITY;

ALTER TABLE catalog.offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.offerings FORCE ROW LEVEL SECURITY;

ALTER TABLE catalog.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.resources FORCE ROW LEVEL SECURITY;

ALTER TABLE catalog.offering_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.offering_resources FORCE ROW LEVEL SECURITY;

ALTER TABLE catalog.packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.packages FORCE ROW LEVEL SECURITY;

ALTER TABLE catalog.package_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.package_items FORCE ROW LEVEL SECURITY;

ALTER TABLE media.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.media_assets FORCE ROW LEVEL SECURITY;

ALTER TABLE media.media_rights ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.media_rights FORCE ROW LEVEL SECURITY;

ALTER TABLE media.media_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.media_links FORCE ROW LEVEL SECURITY;

ALTER TABLE listing.channel_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing.channel_publications FORCE ROW LEVEL SECURITY;

-- Importer role bypass policies
CREATE POLICY importer_all_provider_profiles ON provider.provider_profiles FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_provider_workspace_links ON provider.provider_workspace_links FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_capability_definitions ON provider.capability_definitions FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_provider_capabilities ON provider.provider_capabilities FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_verification_cases ON verification.verification_cases FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_verification_evidence ON verification.verification_evidence FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_offerings ON catalog.offerings FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_resources ON catalog.resources FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_offering_resources ON catalog.offering_resources FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_packages ON catalog.packages FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_package_items ON catalog.package_items FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_media_assets ON media.media_assets FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_media_rights ON media.media_rights FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_media_links ON media.media_links FOR ALL TO vind_importer USING (true) WITH CHECK (true);
CREATE POLICY importer_all_channel_publications ON listing.channel_publications FOR ALL TO vind_importer USING (true) WITH CHECK (true);

-- Runtime tenant isolation policies
CREATE POLICY runtime_provider_profiles ON provider.provider_profiles FOR SELECT TO vind_app_runtime USING (
    owning_organization_id = security.current_organization_id() OR
    id IN (SELECT provider_profile_id FROM provider.provider_workspace_links WHERE managing_organization_id = security.current_organization_id() AND link_status = 'ACTIVE')
);

CREATE POLICY runtime_provider_workspace_links ON provider.provider_workspace_links FOR SELECT TO vind_app_runtime USING (
    managing_organization_id = security.current_organization_id()
);

CREATE POLICY runtime_capability_definitions ON provider.capability_definitions FOR SELECT TO vind_app_runtime USING (
    status = 'ACTIVE'
);

CREATE POLICY runtime_provider_capabilities ON provider.provider_capabilities FOR SELECT TO vind_app_runtime USING (
    provider_profile_id IN (SELECT id FROM provider.provider_profiles)
);

CREATE POLICY runtime_verification_cases ON verification.verification_cases FOR SELECT TO vind_app_runtime USING (
    provider_profile_id IN (SELECT id FROM provider.provider_profiles)
);

CREATE POLICY runtime_offerings ON catalog.offerings FOR SELECT TO vind_app_runtime USING (
    provider_profile_id IN (SELECT id FROM provider.provider_profiles)
);

CREATE POLICY runtime_resources ON catalog.resources FOR SELECT TO vind_app_runtime USING (
    provider_profile_id IN (SELECT id FROM provider.provider_profiles)
);

CREATE POLICY runtime_offering_resources ON catalog.offering_resources FOR SELECT TO vind_app_runtime USING (
    offering_id IN (SELECT id FROM catalog.offerings)
);

CREATE POLICY runtime_packages ON catalog.packages FOR SELECT TO vind_app_runtime USING (
    provider_profile_id IN (SELECT id FROM provider.provider_profiles)
);

CREATE POLICY runtime_package_items ON catalog.package_items FOR SELECT TO vind_app_runtime USING (
    package_id IN (SELECT id FROM catalog.packages)
);

CREATE POLICY runtime_media_assets ON media.media_assets FOR SELECT TO vind_app_runtime USING (
    owner_provider_profile_id IN (SELECT id FROM provider.provider_profiles)
);

CREATE POLICY runtime_media_rights ON media.media_rights FOR SELECT TO vind_app_runtime USING (
    media_asset_id IN (SELECT id FROM media.media_assets)
);

CREATE POLICY runtime_media_links ON media.media_links FOR SELECT TO vind_app_runtime USING (
    media_asset_id IN (SELECT id FROM media.media_assets)
);

CREATE POLICY runtime_channel_publications ON listing.channel_publications FOR SELECT TO vind_app_runtime USING (
    provider_profile_id IN (SELECT id FROM provider.provider_profiles)
);

-- Deny direct SELECT on verification_evidence for runtime role (must use function)
CREATE POLICY runtime_deny_verification_evidence ON verification.verification_evidence FOR SELECT TO vind_app_runtime USING (false);

-- Owner bypass policies for SECURITY DEFINER functions and DB owner administration
CREATE POLICY owner_all_provider_profiles ON provider.provider_profiles FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_provider_workspace_links ON provider.provider_workspace_links FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_capability_definitions ON provider.capability_definitions FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_provider_capabilities ON provider.provider_capabilities FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_verification_cases ON verification.verification_cases FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_verification_evidence ON verification.verification_evidence FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_offerings ON catalog.offerings FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_resources ON catalog.resources FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_offering_resources ON catalog.offering_resources FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_packages ON catalog.packages FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_package_items ON catalog.package_items FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_media_assets ON media.media_assets FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_media_rights ON media.media_rights FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_media_links ON media.media_links FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all_channel_publications ON listing.channel_publications FOR ALL TO vind_db_owner USING (true) WITH CHECK (true);
CREATE POLICY platform_assignments_importer_all ON access.platform_assignments FOR ALL TO vind_importer USING (true) WITH CHECK (true);

-- Grant privileges
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA provider, verification, catalog, media, listing, access, organization, party, identity, geo TO vind_importer;
GRANT SELECT ON ALL TABLES IN SCHEMA provider, verification, catalog, media, listing TO vind_app_runtime;

REVOKE SELECT ON TABLE verification.verification_evidence FROM vind_app_runtime;
REVOKE UPDATE (status) ON TABLE provider.provider_profiles FROM vind_app_runtime;
REVOKE UPDATE (publication_status) ON TABLE listing.channel_publications FROM vind_app_runtime;

-- Revoke PUBLIC execute on SECURITY DEFINER functions
REVOKE ALL ON FUNCTION provider.execute_provider_status_command(uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION listing.execute_publication_command(uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION verification.read_evidence(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION provider.prevent_direct_provider_status_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION provider.prevent_direct_workspace_link_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION listing.prevent_direct_publication_status_update() FROM PUBLIC;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA provider, verification, catalog, media, listing TO vind_app_runtime, vind_importer;
