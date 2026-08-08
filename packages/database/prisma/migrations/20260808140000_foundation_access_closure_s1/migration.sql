-- S1 Foundation & Access Closure
-- Transaction is managed by the custom migration runner.
-- Do not add BEGIN or COMMIT.

SET search_path = pg_catalog;

-- ============================================================================
-- Preconditions
-- ============================================================================

DO $block$
BEGIN
    IF to_regclass('provider.provider_profiles') IS NOT NULL THEN
        RAISE EXCEPTION
            'S1 must run before provider.provider_profiles exists'
            USING ERRCODE = '55000';
    END IF;
END;
$block$;

-- ============================================================================
-- Configuration schema
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS configuration AUTHORIZATION vind_db_owner;
ALTER SCHEMA configuration OWNER TO vind_db_owner;
REVOKE ALL ON SCHEMA configuration FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA configuration
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA configuration
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA configuration
    REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA configuration
    REVOKE ALL ON TYPES FROM PUBLIC;

GRANT USAGE ON SCHEMA configuration TO vind_app_runtime;

-- ============================================================================
-- Access role authority plane
-- ============================================================================

ALTER TABLE access.roles
    ADD COLUMN authority_plane text;

UPDATE access.roles
SET authority_plane = 'SAHABAT'
WHERE code IN (
    'OWNER',
    'ADMIN',
    'OPERATIONS_STAFF',
    'ACCOUNTING',
    'CONTENT_MANAGER'
);

INSERT INTO access.roles (
    code,
    display_name,
    description,
    role_scope,
    is_system,
    is_active,
    authority_plane
)
VALUES
    (
        'SUPER_ADMIN',
        'Super Admin',
        'Emergency break-glass platform administrator',
        'SYSTEM',
        true,
        true,
        'PLATFORM'
    ),
    (
        'OPERATIONS_ADMIN',
        'Operations Admin',
        'Platform operations administrator',
        'SYSTEM',
        true,
        true,
        'PLATFORM'
    ),
    (
        'MODERATOR',
        'Moderator',
        'Platform moderation staff',
        'SYSTEM',
        true,
        true,
        'PLATFORM'
    ),
    (
        'SUPPORT_AGENT',
        'Support Agent',
        'Platform support staff',
        'CASE',
        true,
        true,
        'PLATFORM'
    ),
    (
        'ADS_OPERATOR',
        'Ads Operator',
        'Platform advertising operations staff',
        'SYSTEM',
        true,
        true,
        'PLATFORM'
    ),
    (
        'FINANCE_MAKER',
        'Finance Maker',
        'Platform finance maker role',
        'FINANCE',
        true,
        true,
        'PLATFORM'
    ),
    (
        'FINANCE_CHECKER',
        'Finance Checker',
        'Platform finance checker role',
        'FINANCE',
        true,
        true,
        'PLATFORM'
    ),
    (
        'SECURITY_AUDITOR',
        'Security Auditor',
        'Platform security and audit reviewer',
        'SYSTEM',
        true,
        true,
        'PLATFORM'
    ),
    (
        'REPORT_VIEWER',
        'Report Viewer',
        'Platform reporting viewer',
        'SYSTEM',
        true,
        true,
        'PLATFORM'
    )
ON CONFLICT (code) DO NOTHING;

DO $block$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*)
    INTO v_count
    FROM access.roles
    WHERE authority_plane IS NULL;

    IF v_count <> 0 THEN
        RAISE EXCEPTION
            'All existing roles must have an authority_plane before S1 closes'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.roles
        WHERE authority_plane NOT IN ('SAHABAT', 'PLATFORM')
    ) THEN
        RAISE EXCEPTION
            'Invalid access.roles authority_plane'
            USING ERRCODE = '23514';
    END IF;
END;
$block$;

ALTER TABLE access.roles
    ALTER COLUMN authority_plane SET NOT NULL;

ALTER TABLE access.roles
    ADD CONSTRAINT roles_authority_plane_valid
    CHECK (authority_plane IN ('SAHABAT', 'PLATFORM'));

CREATE INDEX roles_authority_plane_active_idx
    ON access.roles(authority_plane, is_active);

-- ============================================================================
-- Locked sensitive capabilities and exact routine mappings
-- ============================================================================

INSERT INTO access.capabilities (
    code,
    domain_code,
    action_code,
    description,
    is_sensitive,
    is_active
)
VALUES
    (
        'provider.status.transition',
        'provider',
        'status.transition',
        'Transition provider lifecycle status',
        true,
        true
    ),
    (
        'provider.management_authority.manage',
        'provider',
        'management_authority.manage',
        'Manage provider management authority',
        true,
        true
    ),
    (
        'listing.publication.transition',
        'listing',
        'publication.transition',
        'Transition listing publication lifecycle',
        true,
        true
    ),
    (
        'verification.evidence.read',
        'verification',
        'evidence.read',
        'Read restricted verification evidence',
        true,
        true
    )
ON CONFLICT (code) DO NOTHING;

DO $block$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM access.capabilities
        WHERE code IN (
            'provider.status.transition',
            'provider.management_authority.manage',
            'listing.publication.transition',
            'verification.evidence.read'
        )
          AND (is_sensitive = false OR is_active = false)
    ) THEN
        RAISE EXCEPTION
            'Locked S1 sensitive capabilities must be active and sensitive'
            USING ERRCODE = '23514';
    END IF;
END;
$block$;

INSERT INTO access.role_capabilities (
    role_code,
    capability_code,
    effect
)
VALUES
    ('OWNER', 'provider.status.transition', 'ALLOW'),
    ('OWNER', 'provider.management_authority.manage', 'ALLOW'),
    ('OWNER', 'listing.publication.transition', 'ALLOW'),
    ('ADMIN', 'provider.status.transition', 'ALLOW'),
    ('ADMIN', 'listing.publication.transition', 'ALLOW'),
    ('CONTENT_MANAGER', 'listing.publication.transition', 'ALLOW'),
    ('MODERATOR', 'verification.evidence.read', 'ALLOW'),
    ('OPERATIONS_ADMIN', 'verification.evidence.read', 'ALLOW'),
    ('OPERATIONS_ADMIN', 'provider.status.transition', 'ALLOW')
ON CONFLICT (role_code, capability_code) DO NOTHING;

DO $block$
DECLARE
    v_expected integer;
    v_actual integer;
BEGIN
    SELECT count(*)
    INTO v_actual
    FROM access.role_capabilities rc
    WHERE rc.role_code IN (
        'OWNER',
        'ADMIN',
        'CONTENT_MANAGER',
        'OPERATIONS_STAFF',
        'ACCOUNTING',
        'SUPER_ADMIN',
        'OPERATIONS_ADMIN',
        'MODERATOR',
        'SUPPORT_AGENT',
        'ADS_OPERATOR',
        'FINANCE_MAKER',
        'FINANCE_CHECKER',
        'SECURITY_AUDITOR',
        'REPORT_VIEWER'
    )
      AND rc.capability_code IN (
        'provider.status.transition',
        'provider.management_authority.manage',
        'listing.publication.transition',
        'verification.evidence.read'
      );

    v_expected := 9;

    IF v_actual <> v_expected THEN
        RAISE EXCEPTION
            'Unexpected routine mapping count for locked S1 capabilities: %',
            v_actual
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.role_capabilities rc
        WHERE rc.role_code IN ('OWNER', 'ADMIN')
          AND rc.capability_code = 'verification.evidence.read'
    ) THEN
        RAISE EXCEPTION
            'OWNER/ADMIN must not receive verification.evidence.read'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.role_capabilities rc
        WHERE rc.role_code = 'SUPER_ADMIN'
          AND rc.capability_code IN (
              'provider.status.transition',
              'provider.management_authority.manage',
              'listing.publication.transition',
              'verification.evidence.read'
          )
    ) THEN
        RAISE EXCEPTION
            'SUPER_ADMIN must not receive routine sensitive mappings'
            USING ERRCODE = '23514';
    END IF;
END;
$block$;

-- ============================================================================
-- Local scoped assignments: explicit subject + PERSON target
-- PROVIDER remains fail-closed and has no physical FK in S1.
-- ============================================================================

ALTER TABLE access.scoped_assignments
    ADD COLUMN subject_person_id uuid,
    ADD COLUMN scope_person_id uuid;

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_subject_person_fk
    FOREIGN KEY (subject_person_id)
    REFERENCES party.persons(id)
    ON DELETE RESTRICT;

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_scope_person_fk
    FOREIGN KEY (scope_person_id)
    REFERENCES party.persons(id)
    ON DELETE RESTRICT;

UPDATE access.scoped_assignments sa
SET subject_person_id = m.person_id
FROM access.memberships m
WHERE m.id = sa.membership_id;

ALTER TABLE access.scoped_assignments
    ALTER COLUMN subject_person_id SET NOT NULL,
    ALTER COLUMN membership_id DROP NOT NULL,
    ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE access.scoped_assignments
    DROP CONSTRAINT scoped_assignments_scope_valid,
    DROP CONSTRAINT scoped_assignments_org_no_overlap,
    DROP CONSTRAINT scoped_assignments_workspace_no_overlap;

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_scope_valid
    CHECK (
        (
            scope_type = 'PERSON'
            AND scope_person_id IS NOT NULL
            AND scope_person_id = subject_person_id
            AND membership_id IS NULL
            AND organization_id IS NULL
            AND workspace_id IS NULL
        )
        OR
        (
            scope_type = 'ORGANIZATION'
            AND scope_person_id IS NULL
            AND membership_id IS NOT NULL
            AND organization_id IS NOT NULL
            AND workspace_id IS NULL
        )
        OR
        (
            scope_type = 'WORKSPACE'
            AND scope_person_id IS NULL
            AND membership_id IS NOT NULL
            AND organization_id IS NOT NULL
            AND workspace_id IS NOT NULL
        )
    );

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_person_no_overlap
    EXCLUDE USING gist (
        subject_person_id WITH =,
        role_code WITH =,
        scope_person_id WITH =,
        tstzrange(
            effective_from,
            COALESCE(effective_to, 'infinity'::timestamptz),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND scope_type = 'PERSON'
    );

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_org_no_overlap
    EXCLUDE USING gist (
        subject_person_id WITH =,
        role_code WITH =,
        organization_id WITH =,
        tstzrange(
            effective_from,
            COALESCE(effective_to, 'infinity'::timestamptz),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND scope_type = 'ORGANIZATION'
    );

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_workspace_no_overlap
    EXCLUDE USING gist (
        subject_person_id WITH =,
        role_code WITH =,
        workspace_id WITH =,
        tstzrange(
            effective_from,
            COALESCE(effective_to, 'infinity'::timestamptz),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND scope_type = 'WORKSPACE'
    );

CREATE INDEX scoped_assignments_subject_person_idx
    ON access.scoped_assignments(subject_person_id, status);

CREATE INDEX scoped_assignments_organization_status_idx
    ON access.scoped_assignments(organization_id, status)
    WHERE organization_id IS NOT NULL;

CREATE INDEX scoped_assignments_workspace_status_idx
    ON access.scoped_assignments(workspace_id, status)
    WHERE workspace_id IS NOT NULL;

CREATE OR REPLACE FUNCTION access.validate_scoped_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, access, organization
SET row_security = off
AS $function$
DECLARE
    v_membership_person_id uuid;
    v_membership_organization_id uuid;
    v_workspace_organization_id uuid;
    v_authority_plane text;
BEGIN
    SELECT authority_plane
    INTO v_authority_plane
    FROM access.roles
    WHERE code = NEW.role_code;

    IF NOT FOUND OR v_authority_plane <> 'SAHABAT' THEN
        RAISE EXCEPTION
            'Local scoped assignment requires a SAHABAT role'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.scope_type = 'PERSON' THEN
        IF NEW.scope_person_id IS DISTINCT FROM NEW.subject_person_id THEN
            RAISE EXCEPTION
                'PERSON scope must be self-person scoped'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.scope_type NOT IN ('ORGANIZATION', 'WORKSPACE') THEN
        RAISE EXCEPTION
            'PROVIDER scope is reserved and fail-closed until S2'
            USING ERRCODE = '23514';
    END IF;

    SELECT person_id, organization_id
    INTO v_membership_person_id, v_membership_organization_id
    FROM access.memberships
    WHERE id = NEW.membership_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membership does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF v_membership_person_id <> NEW.subject_person_id THEN
        RAISE EXCEPTION
            'Assignment subject differs from membership person'
            USING ERRCODE = '23514';
    END IF;

    IF v_membership_organization_id <> NEW.organization_id THEN
        RAISE EXCEPTION
            'Assignment organization differs from membership organization'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.scope_type = 'WORKSPACE' THEN
        SELECT organization_id
        INTO v_workspace_organization_id
        FROM organization.workspaces
        WHERE id = NEW.workspace_id;

        IF NOT FOUND
           OR v_workspace_organization_id <> NEW.organization_id THEN
            RAISE EXCEPTION
                'Assignment workspace does not belong to organization'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION access.validate_scoped_assignment() FROM PUBLIC;

DROP TRIGGER scoped_assignments_validate_scope
ON access.scoped_assignments;

CREATE TRIGGER scoped_assignments_validate_scope
BEFORE INSERT OR UPDATE OF
    subject_person_id,
    membership_id,
    role_code,
    scope_type,
    scope_person_id,
    organization_id,
    workspace_id
ON access.scoped_assignments
FOR EACH ROW
EXECUTE FUNCTION access.validate_scoped_assignment();

-- ============================================================================
-- Platform human assignments
-- ============================================================================

CREATE TABLE access.platform_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_key text NOT NULL UNIQUE,
    subject_person_id uuid NOT NULL
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    role_code text NOT NULL
        REFERENCES access.roles(code)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    assignment_mode text NOT NULL DEFAULT 'ROUTINE',
    status text NOT NULL DEFAULT 'DRAFT',
    channel_id uuid
        REFERENCES listing.channels(id)
        ON DELETE RESTRICT,
    region_id uuid
        REFERENCES geo.regions(id)
        ON DELETE RESTRICT,
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    reason_code text NOT NULL,
    approved_by_person_id uuid
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    approval_reference text,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT platform_assignments_key_format
        CHECK (assignment_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT platform_assignments_mode_valid
        CHECK (assignment_mode IN ('ROUTINE', 'BREAK_GLASS')),

    CONSTRAINT platform_assignments_status_valid
        CHECK (
            status IN (
                'DRAFT',
                'ACTIVE',
                'SUSPENDED',
                'REVOKED',
                'EXPIRED'
            )
        ),

    CONSTRAINT platform_assignments_effective_range
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        ),

    CONSTRAINT platform_assignments_reason_not_empty
        CHECK (length(btrim(reason_code)) > 0),

    CONSTRAINT platform_assignments_approver_not_self
        CHECK (
            approved_by_person_id IS NULL
            OR approved_by_person_id <> subject_person_id
        ),

    CONSTRAINT platform_assignments_break_glass_shape
        CHECK (
            (
                role_code = 'SUPER_ADMIN'
                AND assignment_mode = 'BREAK_GLASS'
                AND effective_to IS NOT NULL
                AND approved_by_person_id IS NOT NULL
                AND approval_reference IS NOT NULL
                AND length(btrim(approval_reference)) > 0
            )
            OR
            (
                role_code <> 'SUPER_ADMIN'
                AND assignment_mode = 'ROUTINE'
            )
        )
);

CREATE INDEX platform_assignments_subject_idx
    ON access.platform_assignments(subject_person_id, status);

CREATE INDEX platform_assignments_role_idx
    ON access.platform_assignments(role_code, status);

CREATE INDEX platform_assignments_channel_idx
    ON access.platform_assignments(channel_id, status)
    WHERE channel_id IS NOT NULL;

CREATE INDEX platform_assignments_region_idx
    ON access.platform_assignments(region_id, status)
    WHERE region_id IS NOT NULL;

ALTER TABLE access.platform_assignments
    ADD CONSTRAINT platform_assignments_active_no_overlap
    EXCLUDE USING gist (
        subject_person_id WITH =,
        role_code WITH =,
        (COALESCE(
            channel_id,
            '00000000-0000-0000-0000-000000000000'::uuid
        )) WITH =,
        (COALESCE(
            region_id,
            '00000000-0000-0000-0000-000000000000'::uuid
        )) WITH =,
        tstzrange(
            effective_from,
            COALESCE(effective_to, 'infinity'::timestamptz),
            '[)'
        ) WITH &&
    )
    WHERE (status = 'ACTIVE');

CREATE OR REPLACE FUNCTION access.validate_platform_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, access
SET row_security = off
AS $function$
DECLARE
    v_plane text;
    v_role_active boolean;
BEGIN
    SELECT authority_plane, is_active
    INTO v_plane, v_role_active
    FROM access.roles
    WHERE code = NEW.role_code;

    IF NOT FOUND
       OR v_plane <> 'PLATFORM'
       OR v_role_active = false THEN
        RAISE EXCEPTION
            'Platform assignment requires an active PLATFORM role'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION access.validate_platform_assignment() FROM PUBLIC;

CREATE TRIGGER platform_assignments_validate_role
BEFORE INSERT OR UPDATE OF role_code
ON access.platform_assignments
FOR EACH ROW
EXECUTE FUNCTION access.validate_platform_assignment();

CREATE TRIGGER platform_assignments_set_updated_at
BEFORE UPDATE ON access.platform_assignments
FOR EACH ROW
EXECUTE FUNCTION security.set_updated_at();

-- ============================================================================
-- Machine/service principal grants
-- ============================================================================

CREATE TABLE access.service_principal_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grant_key text NOT NULL UNIQUE,
    subject_account_id uuid NOT NULL
        REFERENCES identity.accounts(id)
        ON DELETE RESTRICT,
    capability_code text NOT NULL
        REFERENCES access.capabilities(code)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'DRAFT',
    purpose_code text NOT NULL,
    channel_id uuid
        REFERENCES listing.channels(id)
        ON DELETE RESTRICT,
    region_id uuid
        REFERENCES geo.regions(id)
        ON DELETE RESTRICT,
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    reason_code text NOT NULL,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT service_principal_grants_key_format
        CHECK (grant_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT service_principal_grants_status_valid
        CHECK (
            status IN (
                'DRAFT',
                'ACTIVE',
                'SUSPENDED',
                'REVOKED',
                'EXPIRED'
            )
        ),

    CONSTRAINT service_principal_grants_purpose_not_empty
        CHECK (length(btrim(purpose_code)) > 0),

    CONSTRAINT service_principal_grants_reason_not_empty
        CHECK (length(btrim(reason_code)) > 0),

    CONSTRAINT service_principal_grants_effective_range
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        )
);

CREATE INDEX service_principal_grants_account_idx
    ON access.service_principal_grants(subject_account_id, status);

CREATE INDEX service_principal_grants_capability_idx
    ON access.service_principal_grants(capability_code, status);

ALTER TABLE access.service_principal_grants
    ADD CONSTRAINT service_principal_grants_active_no_overlap
    EXCLUDE USING gist (
        subject_account_id WITH =,
        capability_code WITH =,
        purpose_code WITH =,
        (COALESCE(
            channel_id,
            '00000000-0000-0000-0000-000000000000'::uuid
        )) WITH =,
        (COALESCE(
            region_id,
            '00000000-0000-0000-0000-000000000000'::uuid
        )) WITH =,
        tstzrange(
            effective_from,
            COALESCE(effective_to, 'infinity'::timestamptz),
            '[)'
        ) WITH &&
    )
    WHERE (status = 'ACTIVE');

CREATE OR REPLACE FUNCTION access.validate_service_principal_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, access
SET row_security = off
AS $function$
DECLARE
    v_account_type text;
BEGIN
    SELECT account_type
    INTO v_account_type
    FROM identity.accounts
    WHERE id = NEW.subject_account_id;

    IF NOT FOUND
       OR v_account_type NOT IN ('SERVICE', 'SYSTEM') THEN
        RAISE EXCEPTION
            'Service principal grant requires SERVICE/SYSTEM account'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION access.validate_service_principal_grant() FROM PUBLIC;

CREATE TRIGGER service_principal_grants_validate_subject
BEFORE INSERT OR UPDATE OF subject_account_id
ON access.service_principal_grants
FOR EACH ROW
EXECUTE FUNCTION access.validate_service_principal_grant();

CREATE TRIGGER service_principal_grants_set_updated_at
BEFORE UPDATE ON access.service_principal_grants
FOR EACH ROW
EXECUTE FUNCTION security.set_updated_at();

-- ============================================================================
-- Privacy: immutable consent receipts
-- ============================================================================

CREATE TABLE privacy.consent_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_key text NOT NULL UNIQUE,
    person_id uuid NOT NULL
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    purpose_code text NOT NULL,
    policy_version text NOT NULL,
    consent_action text NOT NULL,
    channel_id uuid
        REFERENCES listing.channels(id)
        ON DELETE RESTRICT,
    grant_effective_from timestamptz,
    grant_effective_until timestamptz,
    revokes_receipt_id uuid
        REFERENCES privacy.consent_receipts(id)
        ON DELETE RESTRICT,
    source_reference text,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    retention_class_code text NOT NULL DEFAULT 'PRIV'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT consent_receipts_key_format
        CHECK (receipt_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT consent_receipts_purpose_not_empty
        CHECK (length(btrim(purpose_code)) > 0),

    CONSTRAINT consent_receipts_policy_version_not_empty
        CHECK (length(btrim(policy_version)) > 0),

    CONSTRAINT consent_receipts_action_valid
        CHECK (consent_action IN ('GRANTED', 'WITHDRAWN')),

    CONSTRAINT consent_receipts_action_shape
        CHECK (
            (
                consent_action = 'GRANTED'
                AND grant_effective_from IS NOT NULL
                AND revokes_receipt_id IS NULL
                AND (
                    grant_effective_until IS NULL
                    OR grant_effective_until > grant_effective_from
                )
            )
            OR
            (
                consent_action = 'WITHDRAWN'
                AND grant_effective_from IS NULL
                AND grant_effective_until IS NULL
                AND revokes_receipt_id IS NOT NULL
            )
        )
);

CREATE INDEX consent_receipts_person_idx
    ON privacy.consent_receipts(person_id, occurred_at DESC);

CREATE UNIQUE INDEX consent_receipts_one_withdrawal_per_grant
    ON privacy.consent_receipts(revokes_receipt_id)
    WHERE consent_action = 'WITHDRAWN';

CREATE OR REPLACE FUNCTION privacy.validate_consent_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, privacy
SET row_security = off
AS $function$
DECLARE
    v_grant_person_id uuid;
    v_grant_purpose_code text;
    v_grant_channel_id uuid;
    v_grant_action text;
BEGIN
    IF NEW.consent_action <> 'WITHDRAWN' THEN
        RETURN NEW;
    END IF;

    SELECT
        person_id,
        purpose_code,
        channel_id,
        consent_action
    INTO
        v_grant_person_id,
        v_grant_purpose_code,
        v_grant_channel_id,
        v_grant_action
    FROM privacy.consent_receipts
    WHERE id = NEW.revokes_receipt_id;

    IF NOT FOUND
       OR v_grant_action <> 'GRANTED'
       OR v_grant_person_id <> NEW.person_id
       OR v_grant_purpose_code <> NEW.purpose_code
       OR v_grant_channel_id IS DISTINCT FROM NEW.channel_id THEN
        RAISE EXCEPTION
            'Withdrawal receipt must match the original granted receipt'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION privacy.validate_consent_receipt() FROM PUBLIC;

CREATE TRIGGER consent_receipts_validate
BEFORE INSERT ON privacy.consent_receipts
FOR EACH ROW
EXECUTE FUNCTION privacy.validate_consent_receipt();

-- ============================================================================
-- Privacy: subject requests
-- ============================================================================

CREATE TABLE privacy.subject_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_key text NOT NULL UNIQUE,
    person_id uuid NOT NULL
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    request_type text NOT NULL,
    status text NOT NULL DEFAULT 'SUBMITTED',
    channel_id uuid
        REFERENCES listing.channels(id)
        ON DELETE RESTRICT,
    request_details jsonb NOT NULL DEFAULT '{}'::jsonb,
    submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    verified_at timestamptz,
    due_at timestamptz,
    completed_at timestamptz,
    resolution_code text,
    resolution_details jsonb NOT NULL DEFAULT '{}'::jsonb,
    retention_class_code text NOT NULL DEFAULT 'PRIV'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT subject_requests_key_format
        CHECK (request_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT subject_requests_type_valid
        CHECK (
            request_type IN (
                'ACCESS',
                'EXPORT',
                'ERASURE',
                'RESTRICTION',
                'RECTIFICATION'
            )
        ),

    CONSTRAINT subject_requests_status_valid
        CHECK (
            status IN (
                'SUBMITTED',
                'VERIFYING',
                'IN_REVIEW',
                'APPROVED',
                'REJECTED',
                'IN_PROGRESS',
                'COMPLETED',
                'CANCELLED'
            )
        ),

    CONSTRAINT subject_requests_time_valid
        CHECK (
            (verified_at IS NULL OR verified_at >= submitted_at)
            AND
            (due_at IS NULL OR due_at >= submitted_at)
            AND
            (completed_at IS NULL OR completed_at >= submitted_at)
        )
);

CREATE INDEX subject_requests_person_idx
    ON privacy.subject_requests(person_id, status, submitted_at DESC);

CREATE INDEX subject_requests_due_idx
    ON privacy.subject_requests(status, due_at)
    WHERE status NOT IN ('REJECTED', 'COMPLETED', 'CANCELLED')
      AND due_at IS NOT NULL;

CREATE TRIGGER subject_requests_set_updated_at
BEFORE UPDATE ON privacy.subject_requests
FOR EACH ROW
EXECUTE FUNCTION security.set_updated_at();

-- ============================================================================
-- Typed non-secret configuration
-- ============================================================================

CREATE TABLE configuration.settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    setting_key text NOT NULL,
    scope_type text NOT NULL,
    channel_id uuid
        REFERENCES listing.channels(id)
        ON DELETE RESTRICT,
    region_id uuid
        REFERENCES geo.regions(id)
        ON DELETE RESTRICT,
    version integer NOT NULL,
    value_type text NOT NULL,
    value_json jsonb NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    retention_class_code text NOT NULL DEFAULT 'REF'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT settings_key_format
        CHECK (setting_key ~ '^[a-z][a-z0-9_.:-]{2,127}$'),

    CONSTRAINT settings_scope_valid
        CHECK (
            (
                scope_type = 'GLOBAL'
                AND channel_id IS NULL
                AND region_id IS NULL
            )
            OR
            (
                scope_type = 'CHANNEL'
                AND channel_id IS NOT NULL
                AND region_id IS NULL
            )
            OR
            (
                scope_type = 'REGION'
                AND channel_id IS NULL
                AND region_id IS NOT NULL
            )
        ),

    CONSTRAINT settings_version_positive
        CHECK (version > 0),

    CONSTRAINT settings_value_type_valid
        CHECK (
            value_type IN (
                'BOOLEAN',
                'INTEGER',
                'DECIMAL',
                'TEXT',
                'DURATION_SECONDS',
                'JSON'
            )
        ),

    CONSTRAINT settings_value_shape
        CHECK (
            CASE value_type
                WHEN 'BOOLEAN' THEN jsonb_typeof(value_json) = 'boolean'
                WHEN 'INTEGER' THEN
                    jsonb_typeof(value_json) = 'number'
                    AND (value_json #>> '{}') ~ '^-?[0-9]+$'
                WHEN 'DECIMAL' THEN jsonb_typeof(value_json) = 'number'
                WHEN 'TEXT' THEN jsonb_typeof(value_json) = 'string'
                WHEN 'DURATION_SECONDS' THEN
                    jsonb_typeof(value_json) = 'number'
                    AND (value_json #>> '{}') ~ '^[0-9]+$'
                WHEN 'JSON' THEN true
                ELSE false
            END
        ),

    CONSTRAINT settings_status_valid
        CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),

    CONSTRAINT settings_effective_range
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        )
);

CREATE UNIQUE INDEX settings_global_version_unique
    ON configuration.settings(setting_key, version)
    WHERE scope_type = 'GLOBAL';

CREATE UNIQUE INDEX settings_channel_version_unique
    ON configuration.settings(setting_key, channel_id, version)
    WHERE scope_type = 'CHANNEL';

CREATE UNIQUE INDEX settings_region_version_unique
    ON configuration.settings(setting_key, region_id, version)
    WHERE scope_type = 'REGION';

ALTER TABLE configuration.settings
    ADD CONSTRAINT settings_global_active_no_overlap
    EXCLUDE USING gist (
        setting_key WITH =,
        tstzrange(
            effective_from,
            COALESCE(effective_to, 'infinity'::timestamptz),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND scope_type = 'GLOBAL'
    );

ALTER TABLE configuration.settings
    ADD CONSTRAINT settings_channel_active_no_overlap
    EXCLUDE USING gist (
        setting_key WITH =,
        channel_id WITH =,
        tstzrange(
            effective_from,
            COALESCE(effective_to, 'infinity'::timestamptz),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND scope_type = 'CHANNEL'
    );

ALTER TABLE configuration.settings
    ADD CONSTRAINT settings_region_active_no_overlap
    EXCLUDE USING gist (
        setting_key WITH =,
        region_id WITH =,
        tstzrange(
            effective_from,
            COALESCE(effective_to, 'infinity'::timestamptz),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND scope_type = 'REGION'
    );

CREATE INDEX settings_effective_lookup_idx
    ON configuration.settings(setting_key, status, effective_from, effective_to);

CREATE TRIGGER settings_set_updated_at
BEFORE UPDATE ON configuration.settings
FOR EACH ROW
EXECUTE FUNCTION security.set_updated_at();

CREATE OR REPLACE FUNCTION configuration.get_effective_setting(
    p_setting_key text,
    p_channel_id uuid DEFAULT NULL,
    p_region_id uuid DEFAULT NULL,
    p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, configuration
SET row_security = off
AS $function$
    SELECT s.value_json
    FROM configuration.settings s
    WHERE s.setting_key = p_setting_key
      AND s.status = 'ACTIVE'
      AND s.effective_from <= p_at
      AND (s.effective_to IS NULL OR s.effective_to > p_at)
      AND (
          (s.scope_type = 'REGION' AND s.region_id = p_region_id)
          OR
          (s.scope_type = 'CHANNEL' AND s.channel_id = p_channel_id)
          OR
          s.scope_type = 'GLOBAL'
      )
    ORDER BY
        CASE s.scope_type
            WHEN 'REGION' THEN 1
            WHEN 'CHANNEL' THEN 2
            ELSE 3
        END,
        s.version DESC
    LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION configuration.get_effective_setting(
    text, uuid, uuid, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION configuration.get_effective_setting(
    text, uuid, uuid, timestamptz
) TO vind_app_runtime;

-- ============================================================================
-- Data origin / REAL_PRELAUNCH provenance
-- ============================================================================

ALTER TABLE party.persons
    ADD COLUMN data_origin_code text,
    ADD COLUMN source_import_batch_id bigint
        REFERENCES staging.import_batches(id)
        ON DELETE RESTRICT,
    ADD COLUMN source_reference text;

ALTER TABLE organization.organizations
    ADD COLUMN data_origin_code text,
    ADD COLUMN source_import_batch_id bigint
        REFERENCES staging.import_batches(id)
        ON DELETE RESTRICT,
    ADD COLUMN source_reference text;

ALTER TABLE identity.accounts
    ADD COLUMN data_origin_code text,
    ADD COLUMN source_import_batch_id bigint
        REFERENCES staging.import_batches(id)
        ON DELETE RESTRICT,
    ADD COLUMN source_reference text;

UPDATE party.persons
SET
    data_origin_code = 'SYNTHETIC_DEMO',
    source_reference = COALESCE(
        source_reference,
        's1:preexisting-synthetic:' || seed_key
    )
WHERE is_synthetic = true
  AND data_origin_code IS NULL;

UPDATE organization.organizations
SET
    data_origin_code = 'SYNTHETIC_DEMO',
    source_reference = COALESCE(
        source_reference,
        's1:preexisting-synthetic:' || seed_key
    )
WHERE is_synthetic = true
  AND data_origin_code IS NULL;

UPDATE identity.accounts a
SET
    data_origin_code = 'SYNTHETIC_DEMO',
    source_reference = COALESCE(
        a.source_reference,
        's1:preexisting-synthetic:' || a.seed_key
    )
WHERE a.data_origin_code IS NULL
  AND EXISTS (
      SELECT 1
      FROM identity.identity_links il
      JOIN party.persons p
        ON p.id = il.person_id
      WHERE il.account_id = a.id
        AND p.data_origin_code = 'SYNTHETIC_DEMO'
  );

DO $block$
DECLARE
    v_persons integer;
    v_orgs integer;
    v_accounts integer;
BEGIN
    SELECT count(*) INTO v_persons
    FROM party.persons
    WHERE data_origin_code IS NULL;

    SELECT count(*) INTO v_orgs
    FROM organization.organizations
    WHERE data_origin_code IS NULL;

    SELECT count(*) INTO v_accounts
    FROM identity.accounts
    WHERE data_origin_code IS NULL;

    IF v_persons <> 0 OR v_orgs <> 0 OR v_accounts <> 0 THEN
        RAISE EXCEPTION
            'Unreconciled preexisting provenance rows: persons %, organizations %, accounts %',
            v_persons, v_orgs, v_accounts
            USING ERRCODE = '23514';
    END IF;
END;
$block$;

ALTER TABLE party.persons
    ALTER COLUMN data_origin_code SET NOT NULL;

ALTER TABLE organization.organizations
    ALTER COLUMN data_origin_code SET NOT NULL;

ALTER TABLE identity.accounts
    ALTER COLUMN data_origin_code SET NOT NULL;

ALTER TABLE party.persons
    ADD CONSTRAINT persons_data_origin_valid
    CHECK (
        data_origin_code IN (
            'REFERENCE',
            'REAL_PRELAUNCH',
            'SYNTHETIC_DEMO',
            'UAT',
            'SECURITY_NEGATIVE',
            'LIVE'
        )
    ),
    ADD CONSTRAINT persons_data_origin_synthetic_consistency
    CHECK (
        (
            data_origin_code IN (
                'SYNTHETIC_DEMO',
                'UAT',
                'SECURITY_NEGATIVE'
            )
            AND is_synthetic = true
        )
        OR
        (
            data_origin_code IN (
                'REFERENCE',
                'REAL_PRELAUNCH',
                'LIVE'
            )
            AND is_synthetic = false
        )
    ),
    ADD CONSTRAINT persons_real_prelaunch_provenance_required
    CHECK (
        data_origin_code <> 'REAL_PRELAUNCH'
        OR source_import_batch_id IS NOT NULL
        OR (
            source_reference IS NOT NULL
            AND length(btrim(source_reference)) > 0
        )
    );

ALTER TABLE organization.organizations
    ADD CONSTRAINT organizations_data_origin_valid
    CHECK (
        data_origin_code IN (
            'REFERENCE',
            'REAL_PRELAUNCH',
            'SYNTHETIC_DEMO',
            'UAT',
            'SECURITY_NEGATIVE',
            'LIVE'
        )
    ),
    ADD CONSTRAINT organizations_data_origin_synthetic_consistency
    CHECK (
        (
            data_origin_code IN (
                'SYNTHETIC_DEMO',
                'UAT',
                'SECURITY_NEGATIVE'
            )
            AND is_synthetic = true
        )
        OR
        (
            data_origin_code IN (
                'REFERENCE',
                'REAL_PRELAUNCH',
                'LIVE'
            )
            AND is_synthetic = false
        )
    ),
    ADD CONSTRAINT organizations_real_prelaunch_provenance_required
    CHECK (
        data_origin_code <> 'REAL_PRELAUNCH'
        OR source_import_batch_id IS NOT NULL
        OR (
            source_reference IS NOT NULL
            AND length(btrim(source_reference)) > 0
        )
    );

ALTER TABLE identity.accounts
    ADD CONSTRAINT accounts_data_origin_valid
    CHECK (
        data_origin_code IN (
            'REFERENCE',
            'REAL_PRELAUNCH',
            'SYNTHETIC_DEMO',
            'UAT',
            'SECURITY_NEGATIVE',
            'LIVE'
        )
    ),
    ADD CONSTRAINT accounts_real_prelaunch_provenance_required
    CHECK (
        data_origin_code <> 'REAL_PRELAUNCH'
        OR source_import_batch_id IS NOT NULL
        OR (
            source_reference IS NOT NULL
            AND length(btrim(source_reference)) > 0
        )
    );

CREATE INDEX persons_data_origin_idx
    ON party.persons(data_origin_code);

CREATE INDEX organizations_data_origin_idx
    ON organization.organizations(data_origin_code);

CREATE INDEX accounts_data_origin_idx
    ON identity.accounts(data_origin_code);

ALTER TABLE staging.import_batches
    DROP CONSTRAINT import_batch_profile_valid;

ALTER TABLE staging.import_batches
    ADD CONSTRAINT import_batch_profile_valid
    CHECK (
        dataset_profile_code IN (
            'REF',
            'SMK',
            'UAT',
            'NEG',
            'VOL',
            'REAL_PRELAUNCH',
            'LIVE'
        )
    );

CREATE OR REPLACE FUNCTION security.prevent_data_origin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF (
        NEW.data_origin_code IS DISTINCT FROM OLD.data_origin_code
        OR NEW.source_import_batch_id IS DISTINCT FROM OLD.source_import_batch_id
        OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
    )
       AND session_user NOT IN ('vind_migrator', 'vind_bootstrap') THEN
        RAISE EXCEPTION
            'Data-origin provenance is controlled and immutable for ordinary actors'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION security.prevent_data_origin_change() FROM PUBLIC;

CREATE TRIGGER persons_data_origin_immutable
BEFORE UPDATE OF
    data_origin_code,
    source_import_batch_id,
    source_reference
ON party.persons
FOR EACH ROW
EXECUTE FUNCTION security.prevent_data_origin_change();

CREATE TRIGGER organizations_data_origin_immutable
BEFORE UPDATE OF
    data_origin_code,
    source_import_batch_id,
    source_reference
ON organization.organizations
FOR EACH ROW
EXECUTE FUNCTION security.prevent_data_origin_change();

CREATE TRIGGER accounts_data_origin_immutable
BEFORE UPDATE OF
    data_origin_code,
    source_import_batch_id,
    source_reference
ON identity.accounts
FOR EACH ROW
EXECUTE FUNCTION security.prevent_data_origin_change();

-- ============================================================================
-- Request context v2
-- ============================================================================

CREATE OR REPLACE FUNCTION security.clear_request_context()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_key text;
    v_keys text[] := ARRAY[
        'context_version',
        'actor_account_key',
        'actor_person_key',
        'actor_kind',
        'authority_plane',
        'membership_key',
        'local_assignment_key',
        'platform_assignment_key',
        'service_grant_key',
        'organization_key',
        'workspace_key',
        'provider_key',
        'channel_code',
        'region_key',
        'purpose_code',
        'correlation_id',
        'request_id',
        'auth_assurance_level',
        'step_up_verified',
        'break_glass_reference',
        'context_initialized'
    ];
BEGIN
    FOREACH v_key IN ARRAY v_keys LOOP
        PERFORM set_config('app.' || v_key, '', true);
    END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION security.set_request_context_v2(
    p_actor_account_key text,
    p_actor_person_key text,
    p_actor_kind text,
    p_authority_plane text,
    p_membership_key text,
    p_local_assignment_key text,
    p_platform_assignment_key text,
    p_service_grant_key text,
    p_organization_key text,
    p_workspace_key text,
    p_provider_key text,
    p_channel_code text,
    p_region_key text,
    p_purpose_code text,
    p_correlation_id text,
    p_request_id text,
    p_auth_assurance_level text,
    p_step_up_verified boolean,
    p_break_glass_reference text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, security
AS $function$
BEGIN
    IF p_actor_kind NOT IN ('HUMAN', 'SERVICE') THEN
        RAISE EXCEPTION 'Invalid actor_kind'
            USING ERRCODE = '22023';
    END IF;

    IF p_authority_plane NOT IN (
        'RELATIONSHIP',
        'LOCAL',
        'PLATFORM',
        'SERVICE'
    ) THEN
        RAISE EXCEPTION 'Invalid authority_plane'
            USING ERRCODE = '22023';
    END IF;

    IF p_actor_kind = 'HUMAN'
       AND (p_actor_person_key IS NULL OR btrim(p_actor_person_key) = '') THEN
        RAISE EXCEPTION 'Human actor requires actor_person_key'
            USING ERRCODE = '22023';
    END IF;

    IF p_actor_kind = 'SERVICE'
       AND p_authority_plane <> 'SERVICE' THEN
        RAISE EXCEPTION 'Service actor requires SERVICE authority plane'
            USING ERRCODE = '22023';
    END IF;

    PERFORM security.clear_request_context();

    PERFORM set_config('app.context_version', '2', true);
    PERFORM set_config(
        'app.actor_account_key',
        COALESCE(p_actor_account_key, ''),
        true
    );
    PERFORM set_config(
        'app.actor_person_key',
        COALESCE(p_actor_person_key, ''),
        true
    );
    PERFORM set_config('app.actor_kind', p_actor_kind, true);
    PERFORM set_config('app.authority_plane', p_authority_plane, true);
    PERFORM set_config(
        'app.membership_key',
        COALESCE(p_membership_key, ''),
        true
    );
    PERFORM set_config(
        'app.local_assignment_key',
        COALESCE(p_local_assignment_key, ''),
        true
    );
    PERFORM set_config(
        'app.platform_assignment_key',
        COALESCE(p_platform_assignment_key, ''),
        true
    );
    PERFORM set_config(
        'app.service_grant_key',
        COALESCE(p_service_grant_key, ''),
        true
    );
    PERFORM set_config(
        'app.organization_key',
        COALESCE(p_organization_key, ''),
        true
    );
    PERFORM set_config(
        'app.workspace_key',
        COALESCE(p_workspace_key, ''),
        true
    );
    PERFORM set_config(
        'app.provider_key',
        COALESCE(p_provider_key, ''),
        true
    );
    PERFORM set_config(
        'app.channel_code',
        COALESCE(p_channel_code, ''),
        true
    );
    PERFORM set_config(
        'app.region_key',
        COALESCE(p_region_key, ''),
        true
    );
    PERFORM set_config(
        'app.purpose_code',
        COALESCE(p_purpose_code, ''),
        true
    );
    PERFORM set_config(
        'app.correlation_id',
        COALESCE(p_correlation_id, ''),
        true
    );
    PERFORM set_config(
        'app.request_id',
        COALESCE(p_request_id, ''),
        true
    );
    PERFORM set_config(
        'app.auth_assurance_level',
        COALESCE(p_auth_assurance_level, ''),
        true
    );
    PERFORM set_config(
        'app.step_up_verified',
        CASE WHEN p_step_up_verified THEN 'true' ELSE 'false' END,
        true
    );
    PERFORM set_config(
        'app.break_glass_reference',
        COALESCE(p_break_glass_reference, ''),
        true
    );
    PERFORM set_config('app.context_initialized', 'true', true);
END;
$function$;

REVOKE ALL ON FUNCTION security.clear_request_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION security.set_request_context_v2(
    text, text, text, text, text, text, text, text, text, text,
    text, text, text, text, text, text, text, boolean, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION security.clear_request_context()
TO vind_app_runtime, vind_importer;

GRANT EXECUTE ON FUNCTION security.set_request_context_v2(
    text, text, text, text, text, text, text, text, text, text,
    text, text, text, text, text, text, text, boolean, text
)
TO vind_app_runtime, vind_importer;

CREATE OR REPLACE FUNCTION security.current_channel_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, security, listing
SET row_security = off
AS $function$
    SELECT c.id
    FROM listing.channels c
    WHERE c.code = security.context_value('channel_code')
      AND c.status = 'ACTIVE'
    LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION security.current_region_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, security, geo
SET row_security = off
AS $function$
    SELECT r.id
    FROM geo.regions r
    WHERE r.seed_key = security.context_value('region_key')
      AND r.status = 'ACTIVE'
    LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION security.current_channel_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION security.current_region_id() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION security.current_channel_id()
TO vind_app_runtime, vind_importer;

GRANT EXECUTE ON FUNCTION security.current_region_id()
TO vind_app_runtime, vind_importer;

-- ============================================================================
-- Access capability resolvers
-- ============================================================================

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
SET search_path = pg_catalog, access, security, party, organization
SET row_security = off
AS $function$
    SELECT CASE
        WHEN security.context_value('context_initialized') <> 'true'
          OR security.context_value('context_version') <> '2'
          OR security.context_value('actor_kind') <> 'HUMAN'
          OR security.context_value('authority_plane') <> 'LOCAL'
          OR p_scope_type = 'PROVIDER'
          OR p_provider_id IS NOT NULL
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
            WHERE sa.seed_key =
                    security.context_value('local_assignment_key')
              AND sa.subject_person_id =
                    security.current_actor_person_id()
              AND sa.status = 'ACTIVE'
              AND sa.effective_from <= p_at
              AND (sa.effective_to IS NULL OR sa.effective_to > p_at)
              AND (
                  (
                      p_scope_type = 'PERSON'
                      AND sa.scope_type = 'PERSON'
                      AND sa.scope_person_id = p_scope_person_id
                      AND sa.scope_person_id =
                            security.current_actor_person_id()
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
                            AND (
                                m.effective_to IS NULL
                                OR m.effective_to > p_at
                            )
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
                            AND (
                                m.effective_to IS NULL
                                OR m.effective_to > p_at
                            )
                      )
                      AND EXISTS (
                          SELECT 1
                          FROM organization.workspaces w
                          WHERE w.id = sa.workspace_id
                            AND w.organization_id = sa.organization_id
                            AND w.status = 'ACTIVE'
                      )
                  )
              )
        )
    END;
$function$;

CREATE OR REPLACE FUNCTION access.has_platform_capability(
    p_capability_code text,
    p_target_channel_id uuid DEFAULT NULL,
    p_target_region_id uuid DEFAULT NULL,
    p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, access, security
SET row_security = off
AS $function$
    SELECT CASE
        WHEN security.context_value('context_initialized') <> 'true'
          OR security.context_value('context_version') <> '2'
          OR security.context_value('actor_kind') <> 'HUMAN'
          OR security.context_value('authority_plane') <> 'PLATFORM'
        THEN false
        ELSE EXISTS (
            SELECT 1
            FROM access.platform_assignments pa
            JOIN access.roles r
              ON r.code = pa.role_code
             AND r.authority_plane = 'PLATFORM'
             AND r.is_active = true
            JOIN access.capabilities c
              ON c.code = p_capability_code
             AND c.is_active = true
            WHERE pa.assignment_key =
                    security.context_value('platform_assignment_key')
              AND pa.subject_person_id =
                    security.current_actor_person_id()
              AND pa.status = 'ACTIVE'
              AND pa.effective_from <= p_at
              AND (pa.effective_to IS NULL OR pa.effective_to > p_at)
              AND (pa.channel_id IS NULL OR pa.channel_id = p_target_channel_id)
              AND (pa.region_id IS NULL OR pa.region_id = p_target_region_id)
              AND (
                  (
                      pa.role_code <> 'SUPER_ADMIN'
                      AND EXISTS (
                          SELECT 1
                          FROM access.role_capabilities rc
                          WHERE rc.role_code = pa.role_code
                            AND rc.capability_code = p_capability_code
                            AND rc.effect = 'ALLOW'
                      )
                  )
                  OR
                  (
                      pa.role_code = 'SUPER_ADMIN'
                      AND pa.assignment_mode = 'BREAK_GLASS'
                      AND security.context_value('step_up_verified') = 'true'
                      AND security.context_value('auth_assurance_level') = 'STRONG'
                      AND pa.approval_reference =
                            security.context_value('break_glass_reference')
                      AND security.context_value('purpose_code') IS NOT NULL
                      AND length(
                          btrim(security.context_value('purpose_code'))
                      ) > 0
                  )
              )
        )
    END;
$function$;

CREATE OR REPLACE FUNCTION access.has_service_capability(
    p_capability_code text,
    p_target_channel_id uuid DEFAULT NULL,
    p_target_region_id uuid DEFAULT NULL,
    p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, access, security, identity
SET row_security = off
AS $function$
    SELECT CASE
        WHEN security.context_value('context_initialized') <> 'true'
          OR security.context_value('context_version') <> '2'
          OR security.context_value('actor_kind') <> 'SERVICE'
          OR security.context_value('authority_plane') <> 'SERVICE'
        THEN false
        ELSE EXISTS (
            SELECT 1
            FROM access.service_principal_grants g
            JOIN identity.accounts a
              ON a.id = g.subject_account_id
             AND a.id = security.current_actor_account_id()
             AND a.account_type IN ('SERVICE', 'SYSTEM')
             AND a.status = 'ACTIVE'
            JOIN access.capabilities c
              ON c.code = g.capability_code
             AND c.is_active = true
            WHERE g.grant_key =
                    security.context_value('service_grant_key')
              AND g.capability_code = p_capability_code
              AND g.status = 'ACTIVE'
              AND g.effective_from <= p_at
              AND (g.effective_to IS NULL OR g.effective_to > p_at)
              AND g.purpose_code =
                    security.context_value('purpose_code')
              AND (g.channel_id IS NULL OR g.channel_id = p_target_channel_id)
              AND (g.region_id IS NULL OR g.region_id = p_target_region_id)
        )
    END;
$function$;

REVOKE ALL ON FUNCTION access.has_local_capability(
    text, text, uuid, uuid, uuid, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION access.has_platform_capability(
    text, uuid, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION access.has_service_capability(
    text, uuid, uuid, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION access.has_local_capability(
    text, text, uuid, uuid, uuid, uuid, timestamptz
) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION access.has_platform_capability(
    text, uuid, uuid, timestamptz
) TO vind_app_runtime;
GRANT EXECUTE ON FUNCTION access.has_service_capability(
    text, uuid, uuid, timestamptz
) TO vind_app_runtime;

-- ============================================================================
-- Restricted-data access logging helper for future S2 evidence reads
-- ============================================================================

CREATE OR REPLACE FUNCTION security.record_data_access(
    p_access_type text,
    p_target_schema text,
    p_target_relation text,
    p_target_key text,
    p_fields_accessed text[],
    p_result_count integer,
    p_reason_code text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, security
SET row_security = off
AS $function$
DECLARE
    v_id bigint;
    v_assignment_key text;
BEGIN
    IF security.context_value('context_initialized') <> 'true'
       OR security.context_value('context_version') <> '2' THEN
        RAISE EXCEPTION 'Request context v2 is required'
            USING ERRCODE = '42501';
    END IF;

    v_assignment_key := COALESCE(
        security.context_value('platform_assignment_key'),
        security.context_value('local_assignment_key'),
        security.context_value('service_grant_key')
    );

    INSERT INTO security.data_access_logs (
        actor_account_key,
        actor_person_key,
        acting_assignment_key,
        purpose_code,
        access_type,
        target_schema,
        target_relation,
        target_key,
        fields_accessed,
        result_count,
        reason_code,
        correlation_id,
        request_id
    )
    VALUES (
        security.context_value('actor_account_key'),
        security.context_value('actor_person_key'),
        v_assignment_key,
        COALESCE(
            security.context_value('purpose_code'),
            'UNSPECIFIED'
        ),
        p_access_type,
        p_target_schema,
        p_target_relation,
        p_target_key,
        COALESCE(p_fields_accessed, ARRAY[]::text[]),
        p_result_count,
        p_reason_code,
        security.context_value('correlation_id'),
        security.context_value('request_id')
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION security.record_data_access(
    text, text, text, text, text[], integer, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION security.record_data_access(
    text, text, text, text, text[], integer, text
) TO vind_app_runtime;

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE access.platform_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.service_principal_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.consent_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuration.settings ENABLE ROW LEVEL SECURITY;

DROP POLICY scoped_assignments_runtime_select
ON access.scoped_assignments;

DROP POLICY scoped_assignments_runtime_write
ON access.scoped_assignments;

CREATE POLICY scoped_assignments_runtime_select
ON access.scoped_assignments
FOR SELECT
TO vind_app_runtime
USING (
    subject_person_id = security.current_actor_person_id()
);

-- Importer policy is retained only for deterministic Slice-1 fixture ingestion.
-- Runtime gets no direct write policy.

CREATE POLICY platform_assignments_runtime_select
ON access.platform_assignments
FOR SELECT
TO vind_app_runtime
USING (
    subject_person_id = security.current_actor_person_id()
);

CREATE POLICY consent_receipts_runtime_select
ON privacy.consent_receipts
FOR SELECT
TO vind_app_runtime
USING (
    person_id = security.current_actor_person_id()
);

CREATE POLICY subject_requests_runtime_select
ON privacy.subject_requests
FOR SELECT
TO vind_app_runtime
USING (
    person_id = security.current_actor_person_id()
);

-- No runtime base-table policies for service grants or configuration settings.

-- ============================================================================
-- Grants / least privilege
-- ============================================================================

REVOKE INSERT, UPDATE, DELETE
ON access.scoped_assignments
FROM vind_app_runtime;

GRANT SELECT
ON access.platform_assignments
TO vind_app_runtime;

REVOKE INSERT, UPDATE, DELETE
ON access.platform_assignments
FROM vind_app_runtime;

REVOKE ALL
ON access.service_principal_grants
FROM vind_app_runtime;

GRANT SELECT
ON privacy.consent_receipts,
   privacy.subject_requests
TO vind_app_runtime;

REVOKE INSERT, UPDATE, DELETE
ON privacy.consent_receipts,
   privacy.subject_requests
FROM vind_app_runtime;

REVOKE ALL
ON configuration.settings
FROM vind_app_runtime;

REVOKE UPDATE
ON party.persons
FROM vind_app_runtime;

GRANT UPDATE (
    display_name,
    preferred_name,
    legal_name,
    status,
    locale_code,
    timezone_name,
    contactable
)
ON party.persons
TO vind_app_runtime;

REVOKE UPDATE
ON organization.organizations
FROM vind_app_runtime;

GRANT UPDATE (
    legal_name,
    display_name,
    organization_type,
    status,
    verification_status,
    registration_country_code,
    registration_number
)
ON organization.organizations
TO vind_app_runtime;

-- No importer blanket grants on the new authority/privacy/configuration tables.

-- ============================================================================
-- Final S1 safety checks
-- ============================================================================

DO $block$
DECLARE
    v_provider_column integer;
BEGIN
    SELECT count(*)
    INTO v_provider_column
    FROM information_schema.columns
    WHERE table_schema = 'access'
      AND table_name = 'scoped_assignments'
      AND column_name = 'provider_id';

    IF v_provider_column <> 0 THEN
        RAISE EXCEPTION
            'provider_id must not exist in S1 access.scoped_assignments'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.scoped_assignments
        WHERE scope_type = 'PROVIDER'
    ) THEN
        RAISE EXCEPTION
            'PROVIDER scope must remain fail-closed in S1'
            USING ERRCODE = '23514';
    END IF;
END;
$block$;
