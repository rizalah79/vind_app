-- Forward-fix Migration: 20260809180000_provider_catalog_media_remediation
-- Purpose: Remediation of DB-TO-DUMMY access contract, capabilities, provenance, management authority, evidence security, and importer least-privilege.

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';

-- ============================================================================
-- 1. Provider Access Contract Correction (access.scoped_assignments)
-- ============================================================================

-- Rename column provider_profile_id to provider_id in access.scoped_assignments if exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'access'
          AND table_name = 'scoped_assignments'
          AND column_name = 'provider_profile_id'
    ) THEN
        ALTER TABLE access.scoped_assignments RENAME COLUMN provider_profile_id TO provider_id;
    END IF;
END $$;

-- Drop legacy scope constraints and FKs FIRST
ALTER TABLE access.scoped_assignments
  DROP CONSTRAINT IF EXISTS scoped_assignments_scope_valid,
  DROP CONSTRAINT IF EXISTS scoped_assignments_scope_shape_xor,
  DROP CONSTRAINT IF EXISTS scoped_assignments_provider_no_overlap,
  DROP CONSTRAINT IF EXISTS scoped_assignments_provider_profile_id_fkey,
  DROP CONSTRAINT IF EXISTS scoped_assignments_provider_id_fkey;

-- Rebuild Scoped Assignment Validator Function FIRST
CREATE OR REPLACE FUNCTION access.validate_scoped_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_person_status text;
    v_membership_person_id uuid;
    v_membership_organization_id uuid;
    v_membership_status text;
    v_workspace_organization_id uuid;
    v_prov_owning_org_id uuid;
    v_prov_owning_person_id uuid;
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
        IF NEW.membership_id IS NOT NULL THEN
            RAISE EXCEPTION 'PERSON scope assignment must not have membership' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.scope_type IN ('ORGANIZATION', 'WORKSPACE') THEN
        IF NEW.membership_id IS NULL THEN
            RAISE EXCEPTION 'Membership is required for ORGANIZATION or WORKSPACE scope' USING ERRCODE = '23502';
        END IF;

        SELECT person_id, organization_id, status
        INTO v_membership_person_id, v_membership_organization_id, v_membership_status
        FROM access.memberships
        WHERE id = NEW.membership_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Membership does not exist' USING ERRCODE = '23503';
        END IF;

        IF v_membership_status <> 'ACTIVE' THEN
            RAISE EXCEPTION 'Membership is not ACTIVE' USING ERRCODE = '23514';
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
        RETURN NEW;
    END IF;

    IF NEW.scope_type = 'PROVIDER' THEN
        IF NEW.provider_id IS NULL THEN
            RAISE EXCEPTION 'PROVIDER scope assignment requires provider_id' USING ERRCODE = '23502';
        END IF;
        IF NEW.organization_id IS NOT NULL OR NEW.workspace_id IS NOT NULL OR NEW.scope_person_id IS NOT NULL THEN
            RAISE EXCEPTION 'PROVIDER scope assignment must have NULL organization_id, workspace_id, and scope_person_id' USING ERRCODE = '23514';
        END IF;

        SELECT owning_organization_id, owning_person_id
        INTO v_prov_owning_org_id, v_prov_owning_person_id
        FROM provider.provider_profiles
        WHERE id = NEW.provider_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Assignment provider profile does not exist' USING ERRCODE = '23503';
        END IF;

        IF v_prov_owning_person_id IS NOT NULL AND v_prov_owning_org_id IS NULL THEN
            -- Independent person-owned provider
            IF NEW.membership_id IS NOT NULL THEN
                RAISE EXCEPTION 'Independent person provider assignment must have NULL membership_id' USING ERRCODE = '23514';
            END IF;
            IF v_prov_owning_person_id <> NEW.subject_person_id THEN
                RAISE EXCEPTION 'Independent provider subject does not match provider owner' USING ERRCODE = '23514';
            END IF;
        ELSE
            -- Organization-owned or managed provider
            IF NEW.membership_id IS NULL THEN
                RAISE EXCEPTION 'Organization provider assignment requires active membership_id' USING ERRCODE = '23502';
            END IF;

            SELECT person_id, organization_id, status
            INTO v_membership_person_id, v_membership_organization_id, v_membership_status
            FROM access.memberships
            WHERE id = NEW.membership_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Membership does not exist' USING ERRCODE = '23503';
            END IF;

            IF v_membership_status <> 'ACTIVE' THEN
                RAISE EXCEPTION 'Membership is not ACTIVE' USING ERRCODE = '23514';
            END IF;

            IF v_membership_person_id <> NEW.subject_person_id THEN
                RAISE EXCEPTION 'Assignment subject differs from membership person' USING ERRCODE = '23514';
            END IF;

            IF v_membership_organization_id <> v_prov_owning_org_id AND NOT EXISTS (
                SELECT 1 FROM provider.provider_workspace_links
                WHERE provider_profile_id = NEW.provider_id
                  AND managing_organization_id = v_membership_organization_id
                  AND link_status = 'ACTIVE'
            ) THEN
                RAISE EXCEPTION 'Membership organization does not own or manage provider' USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$function$;

-- Clean legacy PROVIDER assignments to match locked contract
UPDATE access.scoped_assignments
SET organization_id = NULL, workspace_id = NULL
WHERE scope_type = 'PROVIDER';

-- Re-add FK and scope constraints
ALTER TABLE access.scoped_assignments
  ADD CONSTRAINT scoped_assignments_provider_id_fkey
  FOREIGN KEY (provider_id) REFERENCES provider.provider_profiles(id) ON DELETE RESTRICT;

ALTER TABLE access.scoped_assignments
  ADD CONSTRAINT scoped_assignments_scope_valid
  CHECK (
    ((scope_type = 'PERSON')       AND (subject_person_id IS NOT NULL) AND (scope_person_id = subject_person_id) AND (membership_id IS NULL)     AND (organization_id IS NULL)     AND (workspace_id IS NULL)     AND (provider_id IS NULL)) OR
    ((scope_type = 'ORGANIZATION') AND (subject_person_id IS NOT NULL) AND (scope_person_id IS NULL)             AND (membership_id IS NOT NULL) AND (organization_id IS NOT NULL) AND (workspace_id IS NULL)     AND (provider_id IS NULL)) OR
    ((scope_type = 'WORKSPACE')    AND (subject_person_id IS NOT NULL) AND (scope_person_id IS NULL)             AND (membership_id IS NOT NULL) AND (organization_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (provider_id IS NULL)) OR
    ((scope_type = 'PROVIDER')     AND (subject_person_id IS NOT NULL) AND (scope_person_id IS NULL)                                             AND (organization_id IS NULL)     AND (workspace_id IS NULL)     AND (provider_id IS NOT NULL))
  );

ALTER TABLE access.scoped_assignments
  ADD CONSTRAINT scoped_assignments_provider_no_overlap
  EXCLUDE USING gist (
    subject_person_id WITH =,
    role_code WITH =,
    provider_id WITH =,
    tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamp with time zone), '[)'::text) WITH &&
  ) WHERE (status = 'ACTIVE' AND scope_type = 'PROVIDER');

-- Rebuild has_local_capability Function
CREATE OR REPLACE FUNCTION access.has_local_capability(
    p_capability_code text,
    p_scope_type text,
    p_scope_person_id uuid DEFAULT NULL::uuid,
    p_organization_id uuid DEFAULT NULL::uuid,
    p_workspace_id uuid DEFAULT NULL::uuid,
    p_provider_id uuid DEFAULT NULL::uuid,
    p_at timestamp with time zone DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog
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
                      AND sa.provider_id = p_provider_id
                      AND (
                          (
                              sa.membership_id IS NULL
                              AND EXISTS (
                                  SELECT 1 FROM provider.provider_profiles pr
                                  WHERE pr.id = sa.provider_id
                                    AND pr.owning_person_id = sa.subject_person_id
                                    AND pr.status <> 'ARCHIVED'
                              )
                          )
                          OR
                          (
                              sa.membership_id IS NOT NULL
                              AND EXISTS (
                                  SELECT 1 FROM access.memberships m
                                  WHERE m.id = sa.membership_id
                                    AND m.person_id = sa.subject_person_id
                                    AND m.status = 'ACTIVE'
                                    AND m.effective_from <= p_at
                                    AND (m.effective_to IS NULL OR m.effective_to > p_at)
                                    AND EXISTS (
                                        SELECT 1 FROM provider.provider_profiles pr
                                        WHERE pr.id = sa.provider_id
                                          AND pr.status <> 'ARCHIVED'
                                          AND (
                                              pr.owning_organization_id = m.organization_id
                                              OR EXISTS (
                                                  SELECT 1 FROM provider.provider_workspace_links pwl
                                                  WHERE pwl.provider_profile_id = pr.id
                                                    AND pwl.managing_organization_id = m.organization_id
                                                    AND pwl.link_status = 'ACTIVE'
                                              )
                                          )
                                    )
                              )
                          )
                      )
                  )
              )
        )
    END;
$function$;

-- ============================================================================
-- 2. Exact Locked Capabilities Cleanup
-- ============================================================================

-- Remove provider.status.manage if present
DELETE FROM access.role_capabilities WHERE capability_code = 'provider.status.manage';
DELETE FROM access.capabilities WHERE code = 'provider.status.manage';

-- Ensure exact sensitive capabilities exist
INSERT INTO access.capabilities (code, domain_code, action_code, description, is_sensitive, is_active)
VALUES
  ('provider.status.transition', 'provider', 'status.transition', 'Authority to transition provider status', true, true),
  ('provider.management_authority.manage', 'provider', 'management_authority.manage', 'Authority to manage provider workspace/management links', true, true),
  ('listing.publication.transition', 'listing', 'publication.transition', 'Authority to transition listing publication status', true, true),
  ('verification.evidence.read', 'verification', 'evidence.read', 'Platform authority to read sensitive verification evidence', true, true)
ON CONFLICT (code) DO UPDATE SET is_active = true;

-- Ensure exact role mappings
-- OWNER: provider.status.transition, provider.management_authority.manage, listing.publication.transition
INSERT INTO access.role_capabilities (role_code, capability_code, effect)
VALUES
  ('OWNER', 'provider.status.transition', 'ALLOW'),
  ('OWNER', 'provider.management_authority.manage', 'ALLOW'),
  ('OWNER', 'listing.publication.transition', 'ALLOW'),
  ('ADMIN', 'provider.status.transition', 'ALLOW'),
  ('ADMIN', 'listing.publication.transition', 'ALLOW'),
  ('CONTENT_MANAGER', 'listing.publication.transition', 'ALLOW'),
  ('MODERATOR', 'verification.evidence.read', 'ALLOW'),
  ('OPERATIONS_ADMIN', 'provider.status.transition', 'ALLOW'),
  ('OPERATIONS_ADMIN', 'verification.evidence.read', 'ALLOW')
ON CONFLICT (role_code, capability_code) DO UPDATE SET effect = 'ALLOW';

-- Remove any incorrect verification.evidence.read mappings from OWNER or ADMIN
DELETE FROM access.role_capabilities WHERE role_code IN ('OWNER', 'ADMIN', 'CONTENT_MANAGER') AND capability_code = 'verification.evidence.read';

-- ============================================================================
-- 3. Provider Provenance Contract
-- ============================================================================

ALTER TABLE provider.provider_profiles
  ADD COLUMN IF NOT EXISTS data_origin_code text NOT NULL DEFAULT 'SYNTHETIC_DEMO',
  ADD COLUMN IF NOT EXISTS source_import_batch_id bigint NULL REFERENCES staging.import_batches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_reference text NULL;

ALTER TABLE provider.provider_profiles
  DROP CONSTRAINT IF EXISTS provider_profiles_data_origin_valid;

ALTER TABLE provider.provider_profiles
  ADD CONSTRAINT provider_profiles_data_origin_valid
  CHECK (data_origin_code = ANY (ARRAY['REFERENCE'::text, 'REAL_PRELAUNCH'::text, 'SYNTHETIC_DEMO'::text, 'UAT'::text, 'SECURITY_NEGATIVE'::text, 'LIVE'::text]));

ALTER TABLE provider.provider_profiles
  DROP CONSTRAINT IF EXISTS provider_profiles_real_prelaunch_provenance_required;

ALTER TABLE provider.provider_profiles
  ADD CONSTRAINT provider_profiles_real_prelaunch_provenance_required
  CHECK (((data_origin_code <> 'REAL_PRELAUNCH'::text) OR (source_import_batch_id IS NOT NULL) OR ((source_reference IS NOT NULL) AND (length(btrim(source_reference)) > 0))));

-- Provenance Immutability Trigger
CREATE OR REPLACE FUNCTION provider.prevent_provider_provenance_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.data_origin_code IS DISTINCT FROM NEW.data_origin_code
       OR OLD.source_import_batch_id IS DISTINCT FROM NEW.source_import_batch_id
       OR OLD.source_reference IS DISTINCT FROM NEW.source_reference
    THEN
        RAISE EXCEPTION 'Provider provenance attributes are immutable.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_provider_provenance_update ON provider.provider_profiles;
CREATE TRIGGER trg_prevent_provider_provenance_update
BEFORE UPDATE ON provider.provider_profiles
FOR EACH ROW
EXECUTE FUNCTION provider.prevent_provider_provenance_update();

-- Backfill all smk:s2 provider profiles to SYNTHETIC_DEMO
UPDATE provider.provider_profiles SET data_origin_code = 'SYNTHETIC_DEMO' WHERE data_origin_code IS NULL;

-- ============================================================================
-- 4. Protected Command Functions (No Org Shortcuts, Isolated Command Guards)
-- ============================================================================

-- A. Provider Status Command
DROP FUNCTION IF EXISTS provider.execute_provider_status_command(uuid,text,text,text,text) CASCADE;

CREATE OR REPLACE FUNCTION provider.execute_provider_status_command(
    p_provider_profile_id uuid,
    p_target_status text,
    p_reason_code text,
    p_idempotency_key text DEFAULT NULL::text,
    p_correlation_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_person_id uuid;
    v_actor_account_id uuid;
    v_current_status text;
    v_response jsonb;
    v_scope text := 'provider:status_command';
    v_idempotency_record record;
    v_current_hash text;
    v_authorized boolean := false;
BEGIN
    v_actor_person_id := security.current_actor_person_id();
    v_actor_account_id := security.current_actor_account_id();

    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
    END IF;

    SELECT status INTO v_current_status
    FROM provider.provider_profiles
    WHERE id = p_provider_profile_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Provider profile not found.' USING ERRCODE = '23503';
    END IF;

    -- Strict authorization check without organization shortcuts
    IF access.has_local_capability('provider.status.transition', 'PROVIDER', NULL, NULL, NULL, p_provider_profile_id)
       OR access.has_platform_capability('provider.status.transition')
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
                RAISE EXCEPTION 'Idempotency key hash mismatch conflict.' USING ERRCODE = '22023';
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

    PERFORM set_config('vind.command_execution_active', 'off', true);

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

-- B. Publication Command
DROP FUNCTION IF EXISTS listing.execute_publication_command(uuid,text,text,text,text) CASCADE;

CREATE OR REPLACE FUNCTION listing.execute_publication_command(
    p_channel_publication_id uuid,
    p_target_publication_status text,
    p_reason_code text,
    p_idempotency_key text DEFAULT NULL::text,
    p_correlation_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_person_id uuid;
    v_actor_account_id uuid;
    v_prov_id uuid;
    v_prov_status text;
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

    SELECT status INTO v_prov_status
    FROM provider.provider_profiles WHERE id = v_prov_id;

    -- Strict authorization check without organization shortcuts
    IF access.has_local_capability('listing.publication.transition', 'PROVIDER', NULL, NULL, NULL, v_prov_id)
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
                RAISE EXCEPTION 'Idempotency key hash mismatch conflict.' USING ERRCODE = '22023';
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

    -- Gate 3: Media safety and rights provenance check
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

    PERFORM set_config('vind.command_execution_active', 'off', true);

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

-- C. Verification Evidence Read Command (Platform-Only Security Enforcement)
DROP FUNCTION IF EXISTS verification.read_evidence(uuid,text) CASCADE;
CREATE OR REPLACE FUNCTION verification.read_evidence(
    p_evidence_id uuid,
    p_purpose_code text
)
RETURNS TABLE(
    id uuid,
    evidence_type text,
    document_number_masked text,
    storage_path_encrypted text,
    status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
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

    -- Strict platform-only authorization (NO local provider or organization owner shortcuts)
    IF access.has_platform_capability('verification.evidence.read') THEN
        v_authorized := true;
    END IF;

    IF NOT v_authorized THEN
        RAISE EXCEPTION 'Unauthorized to read verification evidence.' USING ERRCODE = '42501';
    END IF;

    -- Record S1 compliance data access log
    INSERT INTO security.data_access_logs (
        actor_account_key, actor_person_key, acting_assignment_key,
        purpose_code, access_type, target_schema, target_relation, target_key,
        fields_accessed, result_count, correlation_id, request_id
    ) VALUES (
        v_actor_account_id::text, v_actor_person_id::text, v_acting_assignment_key,
        p_purpose_code, 'READ', 'verification', 'verification_evidence', p_evidence_id::text,
        '["id", "evidence_type", "document_number_masked", "storage_path_encrypted", "status"]'::jsonb,
        1, v_correlation_id, v_request_id
    );

    RETURN QUERY
    SELECT ve.id, ve.evidence_type, ve.document_number_masked, ve.storage_path_encrypted, ve.status
    FROM verification.verification_evidence ve
    WHERE ve.id = p_evidence_id;
END;
$function$;

-- D. Management Authority Command (Provider Workspace Links Lifecycle)
CREATE OR REPLACE FUNCTION provider.execute_management_authority_command(
    p_provider_profile_id uuid,
    p_managing_organization_id uuid,
    p_workspace_id uuid,
    p_target_link_status text,
    p_reason_code text,
    p_correlation_id text,
    p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_person_id uuid;
    v_actor_account_id uuid;
    v_existing_link_id uuid;
    v_existing_status text;
    v_ws_org_id uuid;
    v_response jsonb;
    v_scope text := 'provider:management_authority_command';
    v_idempotency_record record;
    v_current_hash text;
    v_authorized boolean := false;
BEGIN
    v_actor_person_id := security.current_actor_person_id();
    v_actor_account_id := security.current_actor_account_id();

    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM provider.provider_profiles WHERE id = p_provider_profile_id
    ) THEN
        RAISE EXCEPTION 'Provider profile not found.' USING ERRCODE = '23503';
    END IF;

    SELECT organization_id INTO v_ws_org_id
    FROM organization.workspaces WHERE id = p_workspace_id;

    IF NOT FOUND OR v_ws_org_id <> p_managing_organization_id THEN
        RAISE EXCEPTION 'Workspace does not belong to managing organization.' USING ERRCODE = '23514';
    END IF;

    -- Capability check using provider.management_authority.manage
    IF access.has_local_capability('provider.management_authority.manage', 'PROVIDER', NULL, NULL, NULL, p_provider_profile_id)
       OR access.has_platform_capability('provider.management_authority.manage')
    THEN
        v_authorized := true;
    END IF;

    IF NOT v_authorized THEN
        RAISE EXCEPTION 'Unauthorized to manage provider management authority.' USING ERRCODE = '42501';
    END IF;

    v_current_hash := encode(sha256((p_provider_profile_id::text || ':' || p_managing_organization_id::text || ':' || p_workspace_id::text || ':' || p_target_link_status)::bytea), 'hex');

    IF p_idempotency_key IS NOT NULL THEN
        SELECT status, request_hash_sha256, response_body INTO v_idempotency_record
        FROM integration.idempotency_keys
        WHERE scope = v_scope AND idempotency_key = p_idempotency_key;

        IF FOUND THEN
            IF v_idempotency_record.request_hash_sha256 <> v_current_hash THEN
                RAISE EXCEPTION 'Idempotency key hash mismatch conflict.' USING ERRCODE = '22023';
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

    SELECT id, link_status INTO v_existing_link_id, v_existing_status
    FROM provider.provider_workspace_links
    WHERE provider_profile_id = p_provider_profile_id
      AND managing_organization_id = p_managing_organization_id
      AND workspace_id = p_workspace_id;

    PERFORM set_config('vind.command_execution_active', 'on', true);

    IF v_existing_link_id IS NULL THEN
        INSERT INTO provider.provider_workspace_links (
            provider_profile_id, managing_organization_id, workspace_id, link_status
        ) VALUES (
            p_provider_profile_id, p_managing_organization_id, p_workspace_id, p_target_link_status
        );
    ELSE
        UPDATE provider.provider_workspace_links
        SET link_status = p_target_link_status, updated_at = clock_timestamp()
        WHERE id = v_existing_link_id;
    END IF;

    PERFORM set_config('vind.command_execution_active', 'off', true);

    v_response := jsonb_build_object(
        'status', 'SUCCESS',
        'provider_profile_id', p_provider_profile_id,
        'managing_organization_id', p_managing_organization_id,
        'workspace_id', p_workspace_id,
        'previous_link_status', COALESCE(v_existing_status, 'NONE'),
        'new_link_status', p_target_link_status
    );

    INSERT INTO audit.audit_events (
        event_type, action_code, actor_person_key, actor_account_key,
        target_schema, target_relation, target_key, reason_code, correlation_id, after_state, classification_code
    ) VALUES (
        'PROVIDER_MANAGEMENT_LINK_CHANGED', 'UPDATE_MANAGEMENT_LINK', v_actor_person_id::text, v_actor_account_id::text,
        'provider', 'provider_workspace_links', p_provider_profile_id::text, p_reason_code, p_correlation_id, v_response, 'INTERNAL'
    );

    INSERT INTO integration.outbox_events (
        event_key, aggregate_schema, aggregate_type, aggregate_key, aggregate_version, event_type, payload, correlation_id, status
    ) VALUES (
        gen_random_uuid()::text, 'provider', 'provider_workspace_links', p_provider_profile_id::text, 1,
        'PROVIDER_MANAGEMENT_LINK_CHANGED', v_response, p_correlation_id, 'PENDING'
    );

    IF p_idempotency_key IS NOT NULL THEN
        UPDATE integration.idempotency_keys
        SET status = 'SUCCEEDED', response_body = v_response, updated_at = clock_timestamp()
        WHERE scope = v_scope AND idempotency_key = p_idempotency_key;
    END IF;

    RETURN v_response;
END;
$function$;

REVOKE ALL ON FUNCTION provider.execute_management_authority_command(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider.execute_management_authority_command(uuid,uuid,uuid,text,text,text,text) TO vind_app_runtime, vind_importer;

REVOKE ALL ON FUNCTION provider.execute_provider_status_command(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider.execute_provider_status_command(uuid,text,text,text,text) TO vind_app_runtime, vind_importer;

REVOKE ALL ON FUNCTION listing.execute_publication_command(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION listing.execute_publication_command(uuid,text,text,text,text) TO vind_app_runtime, vind_importer;

REVOKE ALL ON FUNCTION verification.read_evidence(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verification.read_evidence(uuid,text) TO vind_app_runtime, vind_importer;

-- ============================================================================
-- 5. Importer Least-Privilege Policies
-- ============================================================================

-- Revoke DELETE DML on access schema authority tables from vind_importer
REVOKE DELETE ON TABLE access.platform_assignments FROM vind_importer;
REVOKE DELETE ON TABLE access.scoped_assignments FROM vind_importer;

-- Grant INSERT, UPDATE, SELECT for controlled seed execution
GRANT INSERT, UPDATE, SELECT ON TABLE access.platform_assignments TO vind_importer;
GRANT INSERT, UPDATE, SELECT ON TABLE access.scoped_assignments TO vind_importer;

ALTER TABLE access.platform_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.scoped_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_assignments_importer_all ON access.platform_assignments;
CREATE POLICY platform_assignments_importer_all ON access.platform_assignments
  FOR ALL TO vind_importer
  USING (current_setting('vind.command_execution_active', true) = 'on')
  WITH CHECK (current_setting('vind.command_execution_active', true) = 'on');

DROP POLICY IF EXISTS scoped_assignments_importer_all ON access.scoped_assignments;
CREATE POLICY scoped_assignments_importer_all ON access.scoped_assignments
  FOR ALL TO vind_importer
  USING (current_setting('vind.command_execution_active', true) = 'on')
  WITH CHECK (current_setting('vind.command_execution_active', true) = 'on');
