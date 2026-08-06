-- Physical Schema Slice 1:
-- Reference, Identity, Organization, Party, Geo, and Access.
--
-- Transaction is managed by the custom migration runner.
-- Do not add BEGIN or COMMIT.

SET search_path = pg_catalog;

-- =========================================================
-- Shared trigger functions
-- =========================================================

CREATE OR REPLACE FUNCTION security.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION security.prevent_seed_key_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.seed_key IS DISTINCT FROM OLD.seed_key THEN
        RAISE EXCEPTION
            'seed_key is immutable for %.%',
            TG_TABLE_SCHEMA,
            TG_TABLE_NAME
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION security.set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION security.prevent_seed_key_change() FROM PUBLIC;

-- =========================================================
-- Listing reference: channels
-- =========================================================

CREATE TABLE listing.channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    code text NOT NULL UNIQUE,
    display_name text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    trusted_host_patterns text[] NOT NULL DEFAULT ARRAY[]::text[],
    trusted_client_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
    retention_class_code text NOT NULL DEFAULT 'REF'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT channels_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT channels_code_format
        CHECK (code ~ '^[A-Z][A-Z0-9_]{2,31}$'),

    CONSTRAINT channels_status_valid
        CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

INSERT INTO listing.channels (
    seed_key,
    code,
    display_name
)
VALUES
    ('channel:channel:vindzam', 'VINDZAM', 'Vindzam'),
    ('channel:channel:vindloka', 'VINDLOKA', 'Vindloka');

-- =========================================================
-- Geo: regions
-- =========================================================

CREATE TABLE geo.regions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    parent_id uuid
        REFERENCES geo.regions(id)
        ON DELETE RESTRICT,
    region_type text NOT NULL,
    country_code text NOT NULL DEFAULT 'ID',
    code text NOT NULL,
    display_name text NOT NULL,
    boundary public.geometry(MultiPolygon, 4326),
    centroid public.geometry(Point, 4326),
    source_name text,
    source_url text,
    source_license text,
    source_retrieved_at timestamptz,
    source_checksum_sha256 text,
    source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'ACTIVE',
    retention_class_code text NOT NULL DEFAULT 'REF'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT regions_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT regions_type_valid
        CHECK (
            region_type IN (
                'COUNTRY',
                'PROVINCE',
                'CITY',
                'REGENCY',
                'DISTRICT',
                'SUBDISTRICT'
            )
        ),

    CONSTRAINT regions_country_code_format
        CHECK (country_code ~ '^[A-Z]{2}$'),

    CONSTRAINT regions_code_not_empty
        CHECK (length(btrim(code)) > 0),

    CONSTRAINT regions_status_valid
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'RETIRED')),

    CONSTRAINT regions_not_self_parent
        CHECK (parent_id IS NULL OR parent_id <> id),

    CONSTRAINT regions_source_checksum_format
        CHECK (
            source_checksum_sha256 IS NULL
            OR source_checksum_sha256 ~ '^[0-9a-f]{64}$'
        ),

    CONSTRAINT regions_boundary_valid
        CHECK (
            boundary IS NULL
            OR (
                public.ST_SRID(boundary) = 4326
                AND public.ST_IsValid(boundary)
            )
        ),

    CONSTRAINT regions_centroid_valid
        CHECK (
            centroid IS NULL
            OR public.ST_SRID(centroid) = 4326
        ),

    CONSTRAINT regions_business_key_unique
        UNIQUE (country_code, region_type, code)
);

CREATE INDEX regions_parent_idx
    ON geo.regions(parent_id);

CREATE INDEX regions_boundary_gist
    ON geo.regions
    USING gist(boundary)
    WHERE boundary IS NOT NULL;

-- =========================================================
-- Party: persons and consumer profile
-- =========================================================

CREATE TABLE party.persons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    display_name text NOT NULL,
    preferred_name text,
    legal_name text,
    status text NOT NULL DEFAULT 'ACTIVE',
    locale_code text NOT NULL DEFAULT 'id-ID',
    timezone_name text,
    is_synthetic boolean NOT NULL DEFAULT false,
    contactable boolean NOT NULL DEFAULT true,
    retention_class_code text NOT NULL DEFAULT 'PRIV'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT persons_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT persons_display_name_not_empty
        CHECK (length(btrim(display_name)) > 0),

    CONSTRAINT persons_status_valid
        CHECK (
            status IN (
                'ACTIVE',
                'INACTIVE',
                'RESTRICTED',
                'ARCHIVED'
            )
        ),

    CONSTRAINT persons_locale_format
        CHECK (locale_code ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),

    CONSTRAINT persons_synthetic_not_contactable
        CHECK (NOT is_synthetic OR contactable = false)
);

CREATE TABLE party.contact_points (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    person_id uuid NOT NULL
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    contact_type text NOT NULL,
    label text,
    value text NOT NULL,
    normalized_value text NOT NULL,
    verification_status text NOT NULL DEFAULT 'UNVERIFIED',
    status text NOT NULL DEFAULT 'ACTIVE',
    is_primary boolean NOT NULL DEFAULT false,
    is_synthetic boolean NOT NULL DEFAULT false,
    contactable boolean NOT NULL DEFAULT true,
    valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    valid_to timestamptz,
    retention_class_code text NOT NULL DEFAULT 'PRIV'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT contact_points_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT contact_points_type_valid
        CHECK (contact_type IN ('EMAIL', 'PHONE')),

    CONSTRAINT contact_points_status_valid
        CHECK (
            status IN (
                'ACTIVE',
                'INACTIVE',
                'REVOKED'
            )
        ),

    CONSTRAINT contact_points_verification_valid
        CHECK (
            verification_status IN (
                'UNVERIFIED',
                'PENDING',
                'VERIFIED',
                'BOUNCED',
                'REVOKED'
            )
        ),

    CONSTRAINT contact_points_effective_range
        CHECK (
            valid_to IS NULL
            OR valid_to > valid_from
        ),

    CONSTRAINT contact_points_value_not_empty
        CHECK (
            length(btrim(value)) > 0
            AND length(btrim(normalized_value)) > 0
        ),

    CONSTRAINT contact_points_synthetic_not_contactable
        CHECK (NOT is_synthetic OR contactable = false),

    CONSTRAINT contact_points_synthetic_format
        CHECK (
            NOT is_synthetic
            OR (
                contact_type = 'EMAIL'
                AND normalized_value
                    ~ '^[^@[:space:]]+@[^@[:space:]]+\.invalid$'
            )
            OR (
                contact_type = 'PHONE'
                AND normalized_value
                    ~ '^otp-sim:[a-z0-9_-]+$'
            )
        ),

    CONSTRAINT contact_points_person_value_unique
        UNIQUE (person_id, contact_type, normalized_value)
);

CREATE UNIQUE INDEX contact_points_one_primary_active
    ON party.contact_points(person_id, contact_type)
    WHERE is_primary = true
      AND status = 'ACTIVE';

CREATE INDEX contact_points_normalized_idx
    ON party.contact_points(contact_type, normalized_value);

CREATE TABLE party.consumer_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    person_id uuid NOT NULL UNIQUE
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    preferred_channel_code text
        REFERENCES listing.channels(code)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'ACTIVE',
    preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_synthetic boolean NOT NULL DEFAULT false,
    retention_class_code text NOT NULL DEFAULT 'PRIV'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT consumer_profiles_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT consumer_profiles_status_valid
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED'))
);

-- =========================================================
-- Identity: account and person links
-- =========================================================

CREATE TABLE identity.accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    account_type text NOT NULL DEFAULT 'HUMAN',
    status text NOT NULL DEFAULT 'PENDING',
    last_authenticated_at timestamptz,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT accounts_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT accounts_type_valid
        CHECK (
            account_type IN (
                'HUMAN',
                'SERVICE',
                'SYSTEM'
            )
        ),

    CONSTRAINT accounts_status_valid
        CHECK (
            status IN (
                'PENDING',
                'ACTIVE',
                'LOCKED',
                'DISABLED',
                'ARCHIVED'
            )
        )
);

CREATE TABLE identity.identity_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    account_id uuid NOT NULL
        REFERENCES identity.accounts(id)
        ON DELETE RESTRICT,
    person_id uuid NOT NULL
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    issuer text NOT NULL,
    subject text NOT NULL,
    assurance_level text NOT NULL DEFAULT 'BASIC',
    status text NOT NULL DEFAULT 'ACTIVE',
    is_primary boolean NOT NULL DEFAULT false,
    linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT identity_links_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT identity_links_issuer_not_empty
        CHECK (length(btrim(issuer)) > 0),

    CONSTRAINT identity_links_subject_not_empty
        CHECK (length(btrim(subject)) > 0),

    CONSTRAINT identity_links_assurance_valid
        CHECK (
            assurance_level IN (
                'BASIC',
                'VERIFIED',
                'STRONG'
            )
        ),

    CONSTRAINT identity_links_status_valid
        CHECK (status IN ('ACTIVE', 'REVOKED')),

    CONSTRAINT identity_links_revoked_state_valid
        CHECK (
            revoked_at IS NULL
            OR status = 'REVOKED'
        ),

    CONSTRAINT identity_links_external_subject_unique
        UNIQUE (issuer, subject),

    CONSTRAINT identity_links_account_person_issuer_unique
        UNIQUE (account_id, person_id, issuer)
);

CREATE UNIQUE INDEX identity_links_one_primary_active
    ON identity.identity_links(account_id)
    WHERE is_primary = true
      AND status = 'ACTIVE';

CREATE INDEX identity_links_person_idx
    ON identity.identity_links(person_id);

-- =========================================================
-- Organization
-- =========================================================

CREATE TABLE organization.organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    legal_name text NOT NULL,
    display_name text NOT NULL,
    organization_type text NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    verification_status text NOT NULL DEFAULT 'UNVERIFIED',
    registration_country_code text NOT NULL DEFAULT 'ID',
    registration_number text,
    is_synthetic boolean NOT NULL DEFAULT false,
    retention_class_code text NOT NULL DEFAULT 'OPS'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT organizations_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT organizations_legal_name_not_empty
        CHECK (length(btrim(legal_name)) > 0),

    CONSTRAINT organizations_display_name_not_empty
        CHECK (length(btrim(display_name)) > 0),

    CONSTRAINT organizations_type_valid
        CHECK (
            organization_type IN (
                'LEGAL_ENTITY',
                'SYNTHETIC_DEMO'
            )
        ),

    CONSTRAINT organizations_status_valid
        CHECK (
            status IN (
                'DRAFT',
                'ACTIVE',
                'SUSPENDED',
                'ARCHIVED'
            )
        ),

    CONSTRAINT organizations_verification_valid
        CHECK (
            verification_status IN (
                'UNVERIFIED',
                'PENDING',
                'VERIFIED',
                'REJECTED',
                'EXPIRED'
            )
        ),

    CONSTRAINT organizations_country_code_format
        CHECK (registration_country_code ~ '^[A-Z]{2}$'),

    CONSTRAINT organizations_synthetic_type_consistent
        CHECK (
            NOT is_synthetic
            OR organization_type = 'SYNTHETIC_DEMO'
        )
);

CREATE UNIQUE INDEX organizations_registration_unique
    ON organization.organizations(
        registration_country_code,
        registration_number
    )
    WHERE registration_number IS NOT NULL;

-- =========================================================
-- Geo: locations
-- =========================================================

CREATE TABLE geo.locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    organization_id uuid
        REFERENCES organization.organizations(id)
        ON DELETE RESTRICT,
    region_id uuid
        REFERENCES geo.regions(id)
        ON DELETE RESTRICT,
    location_type text NOT NULL,
    display_name text NOT NULL,
    address_line_1 text,
    address_line_2 text,
    postal_code text,
    visibility text NOT NULL DEFAULT 'PRIVATE',
    precise_point public.geography(Point, 4326),
    public_point public.geography(Point, 4326),
    coordinate_source_type text,
    source_url text,
    source_license text,
    source_retrieved_at timestamptz,
    source_checksum_sha256 text,
    source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'ACTIVE',
    is_synthetic boolean NOT NULL DEFAULT false,
    retention_class_code text NOT NULL DEFAULT 'OPS'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT locations_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT locations_type_valid
        CHECK (
            location_type IN (
                'BRANCH',
                'OFFICE',
                'WAREHOUSE',
                'VENUE',
                'SERVICE_POINT',
                'OTHER'
            )
        ),

    CONSTRAINT locations_visibility_valid
        CHECK (
            visibility IN (
                'PUBLIC',
                'INTERNAL',
                'PRIVATE'
            )
        ),

    CONSTRAINT locations_status_valid
        CHECK (
            status IN (
                'ACTIVE',
                'INACTIVE',
                'ARCHIVED'
            )
        ),

    CONSTRAINT locations_coordinate_source_valid
        CHECK (
            coordinate_source_type IS NULL
            OR coordinate_source_type IN (
                'MANUAL_VERIFIED',
                'LICENSED_SOURCE',
                'GEOCODED_APPROVED',
                'SYNTHETIC'
            )
        ),

    CONSTRAINT locations_coordinate_provenance_required
        CHECK (
            (
                precise_point IS NULL
                AND public_point IS NULL
            )
            OR coordinate_source_type IS NOT NULL
        ),

    CONSTRAINT locations_no_legacy_inference
        CHECK (
            coordinate_source_type IS NULL
            OR coordinate_source_type <> 'LEGACY_INFERRED'
        ),

    CONSTRAINT locations_source_checksum_format
        CHECK (
            source_checksum_sha256 IS NULL
            OR source_checksum_sha256 ~ '^[0-9a-f]{64}$'
        ),

    CONSTRAINT locations_precise_point_srid
        CHECK (
            precise_point IS NULL
            OR public.ST_SRID(precise_point::public.geometry) = 4326
        ),

    CONSTRAINT locations_public_point_srid
        CHECK (
            public_point IS NULL
            OR public.ST_SRID(public_point::public.geometry) = 4326
        )
);

CREATE INDEX locations_organization_idx
    ON geo.locations(organization_id);

CREATE INDEX locations_region_idx
    ON geo.locations(region_id);

CREATE INDEX locations_precise_point_gist
    ON geo.locations
    USING gist(precise_point)
    WHERE precise_point IS NOT NULL;

CREATE INDEX locations_public_point_gist
    ON geo.locations
    USING gist(public_point)
    WHERE public_point IS NOT NULL;

-- =========================================================
-- Organization: workspaces
-- =========================================================

CREATE TABLE organization.workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    organization_id uuid NOT NULL
        REFERENCES organization.organizations(id)
        ON DELETE RESTRICT,
    primary_location_id uuid
        REFERENCES geo.locations(id)
        ON DELETE RESTRICT,
    code text NOT NULL,
    display_name text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    is_default boolean NOT NULL DEFAULT false,
    retention_class_code text NOT NULL DEFAULT 'OPS'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT workspaces_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT workspaces_code_format
        CHECK (code ~ '^[A-Z][A-Z0-9_-]{1,31}$'),

    CONSTRAINT workspaces_status_valid
        CHECK (
            status IN (
                'ACTIVE',
                'INACTIVE',
                'ARCHIVED'
            )
        ),

    CONSTRAINT workspaces_org_code_unique
        UNIQUE (organization_id, code)
);

CREATE UNIQUE INDEX workspaces_one_default_active
    ON organization.workspaces(organization_id)
    WHERE is_default = true
      AND status = 'ACTIVE';

-- =========================================================
-- Access: membership and assignments
-- =========================================================

CREATE TABLE access.memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    person_id uuid NOT NULL
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    organization_id uuid NOT NULL
        REFERENCES organization.organizations(id)
        ON DELETE RESTRICT,
    workspace_id uuid
        REFERENCES organization.workspaces(id)
        ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'INVITED',
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    invited_by_person_id uuid
        REFERENCES party.persons(id)
        ON DELETE RESTRICT,
    accepted_at timestamptz,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT memberships_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT memberships_status_valid
        CHECK (
            status IN (
                'INVITED',
                'ACTIVE',
                'SUSPENDED',
                'REVOKED',
                'EXPIRED'
            )
        ),

    CONSTRAINT memberships_effective_range
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        ),

    CONSTRAINT memberships_acceptance_valid
        CHECK (
            accepted_at IS NULL
            OR accepted_at >= effective_from
        )
);

CREATE UNIQUE INDEX memberships_active_org_unique
    ON access.memberships(person_id, organization_id)
    WHERE workspace_id IS NULL
      AND status = 'ACTIVE'
      AND effective_to IS NULL;

CREATE UNIQUE INDEX memberships_active_workspace_unique
    ON access.memberships(
        person_id,
        organization_id,
        workspace_id
    )
    WHERE workspace_id IS NOT NULL
      AND status = 'ACTIVE'
      AND effective_to IS NULL;

CREATE INDEX memberships_organization_idx
    ON access.memberships(organization_id, status);

CREATE INDEX memberships_person_idx
    ON access.memberships(person_id, status);

CREATE TABLE access.scoped_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    membership_id uuid NOT NULL
        REFERENCES access.memberships(id)
        ON DELETE RESTRICT,
    role_code text NOT NULL
        REFERENCES access.roles(code)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    scope_type text NOT NULL,
    organization_id uuid NOT NULL
        REFERENCES organization.organizations(id)
        ON DELETE RESTRICT,
    workspace_id uuid
        REFERENCES organization.workspaces(id)
        ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'DRAFT',
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    reason_code text,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT scoped_assignments_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT scoped_assignments_scope_valid
        CHECK (
            (
                scope_type = 'ORGANIZATION'
                AND workspace_id IS NULL
            )
            OR (
                scope_type = 'WORKSPACE'
                AND workspace_id IS NOT NULL
            )
        ),

    CONSTRAINT scoped_assignments_status_valid
        CHECK (
            status IN (
                'DRAFT',
                'ACTIVE',
                'SUSPENDED',
                'REVOKED',
                'EXPIRED'
            )
        ),

    CONSTRAINT scoped_assignments_effective_range
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        )
);

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_org_no_overlap
    EXCLUDE USING gist (
        membership_id WITH =,
        role_code WITH =,
        organization_id WITH =,
        tstzrange(
            effective_from,
            COALESCE(
                effective_to,
                'infinity'::timestamptz
            ),
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
        membership_id WITH =,
        role_code WITH =,
        workspace_id WITH =,
        tstzrange(
            effective_from,
            COALESCE(
                effective_to,
                'infinity'::timestamptz
            ),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND scope_type = 'WORKSPACE'
    );

CREATE INDEX scoped_assignments_membership_idx
    ON access.scoped_assignments(membership_id, status);

CREATE TABLE access.pic_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_key text NOT NULL UNIQUE,
    scoped_assignment_id uuid NOT NULL
        REFERENCES access.scoped_assignments(id)
        ON DELETE RESTRICT,
    responsibility_code text NOT NULL,
    target_type text NOT NULL,
    organization_id uuid
        REFERENCES organization.organizations(id)
        ON DELETE RESTRICT,
    workspace_id uuid
        REFERENCES organization.workspaces(id)
        ON DELETE RESTRICT,
    location_id uuid
        REFERENCES geo.locations(id)
        ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'ACTIVE',
    is_primary boolean NOT NULL DEFAULT false,
    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT pic_assignments_seed_key_format
        CHECK (seed_key ~ '^[a-z][a-z0-9:_-]{2,127}$'),

    CONSTRAINT pic_assignments_responsibility_valid
        CHECK (
            responsibility_code IN (
                'PRIMARY_CONTACT',
                'OPERATIONS',
                'FINANCE',
                'CONTENT'
            )
        ),

    CONSTRAINT pic_assignments_target_valid
        CHECK (
            (
                target_type = 'ORGANIZATION'
                AND organization_id IS NOT NULL
                AND workspace_id IS NULL
                AND location_id IS NULL
            )
            OR (
                target_type = 'WORKSPACE'
                AND organization_id IS NULL
                AND workspace_id IS NOT NULL
                AND location_id IS NULL
            )
            OR (
                target_type = 'LOCATION'
                AND organization_id IS NULL
                AND workspace_id IS NULL
                AND location_id IS NOT NULL
            )
        ),

    CONSTRAINT pic_assignments_status_valid
        CHECK (
            status IN (
                'ACTIVE',
                'SUSPENDED',
                'REVOKED',
                'EXPIRED'
            )
        ),

    CONSTRAINT pic_assignments_effective_range
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        )
);

ALTER TABLE access.pic_assignments
    ADD CONSTRAINT pic_assignments_org_primary_no_overlap
    EXCLUDE USING gist (
        organization_id WITH =,
        responsibility_code WITH =,
        tstzrange(
            effective_from,
            COALESCE(
                effective_to,
                'infinity'::timestamptz
            ),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND is_primary = true
        AND target_type = 'ORGANIZATION'
    );

ALTER TABLE access.pic_assignments
    ADD CONSTRAINT pic_assignments_workspace_primary_no_overlap
    EXCLUDE USING gist (
        workspace_id WITH =,
        responsibility_code WITH =,
        tstzrange(
            effective_from,
            COALESCE(
                effective_to,
                'infinity'::timestamptz
            ),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND is_primary = true
        AND target_type = 'WORKSPACE'
    );

ALTER TABLE access.pic_assignments
    ADD CONSTRAINT pic_assignments_location_primary_no_overlap
    EXCLUDE USING gist (
        location_id WITH =,
        responsibility_code WITH =,
        tstzrange(
            effective_from,
            COALESCE(
                effective_to,
                'infinity'::timestamptz
            ),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND is_primary = true
        AND target_type = 'LOCATION'
    );

-- =========================================================
-- Cross-table scope validation
-- =========================================================

CREATE OR REPLACE FUNCTION access.validate_membership_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, organization
SET row_security = off
AS $function$
DECLARE
    v_workspace_organization_id uuid;
BEGIN
    IF NEW.workspace_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT organization_id
    INTO v_workspace_organization_id
    FROM organization.workspaces
    WHERE id = NEW.workspace_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workspace does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF v_workspace_organization_id <> NEW.organization_id THEN
        RAISE EXCEPTION
            'Workspace does not belong to membership organization'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION access.validate_scoped_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, access, organization
SET row_security = off
AS $function$
DECLARE
    v_membership_organization_id uuid;
    v_workspace_organization_id uuid;
BEGIN
    SELECT organization_id
    INTO v_membership_organization_id
    FROM access.memberships
    WHERE id = NEW.membership_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membership does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF v_membership_organization_id <> NEW.organization_id THEN
        RAISE EXCEPTION
            'Assignment organization differs from membership organization'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.workspace_id IS NOT NULL THEN
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

CREATE OR REPLACE FUNCTION access.validate_pic_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, access, organization, geo
SET row_security = off
AS $function$
DECLARE
    v_assignment_organization_id uuid;
    v_target_organization_id uuid;
BEGIN
    SELECT organization_id
    INTO v_assignment_organization_id
    FROM access.scoped_assignments
    WHERE id = NEW.scoped_assignment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Scoped assignment does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.target_type = 'ORGANIZATION' THEN
        v_target_organization_id := NEW.organization_id;

    ELSIF NEW.target_type = 'WORKSPACE' THEN
        SELECT organization_id
        INTO v_target_organization_id
        FROM organization.workspaces
        WHERE id = NEW.workspace_id;

    ELSIF NEW.target_type = 'LOCATION' THEN
        SELECT organization_id
        INTO v_target_organization_id
        FROM geo.locations
        WHERE id = NEW.location_id;
    END IF;

    IF v_target_organization_id IS NULL
       OR v_target_organization_id <> v_assignment_organization_id THEN
        RAISE EXCEPTION
            'PIC target is outside assignment organization'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION
    access.validate_membership_workspace()
FROM PUBLIC;

REVOKE ALL ON FUNCTION
    access.validate_scoped_assignment()
FROM PUBLIC;

REVOKE ALL ON FUNCTION
    access.validate_pic_assignment()
FROM PUBLIC;

CREATE TRIGGER memberships_validate_workspace
BEFORE INSERT OR UPDATE OF organization_id, workspace_id
ON access.memberships
FOR EACH ROW
EXECUTE FUNCTION access.validate_membership_workspace();

CREATE TRIGGER scoped_assignments_validate_scope
BEFORE INSERT OR UPDATE OF
    membership_id,
    organization_id,
    workspace_id,
    scope_type
ON access.scoped_assignments
FOR EACH ROW
EXECUTE FUNCTION access.validate_scoped_assignment();

CREATE TRIGGER pic_assignments_validate_target
BEFORE INSERT OR UPDATE OF
    scoped_assignment_id,
    target_type,
    organization_id,
    workspace_id,
    location_id
ON access.pic_assignments
FOR EACH ROW
EXECUTE FUNCTION access.validate_pic_assignment();

-- =========================================================
-- Context ID resolvers for RLS
-- =========================================================

CREATE OR REPLACE FUNCTION security.current_actor_person_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, security, party
SET row_security = off
AS $function$
    SELECT p.id
    FROM party.persons p
    WHERE p.seed_key =
        security.context_value('actor_person_key')
    LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION security.current_actor_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, security, identity
SET row_security = off
AS $function$
    SELECT a.id
    FROM identity.accounts a
    WHERE a.seed_key =
        security.context_value('actor_account_key')
    LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION security.current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, security, organization
SET row_security = off
AS $function$
    SELECT o.id
    FROM organization.organizations o
    WHERE o.seed_key =
        security.context_value('organization_key')
    LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION security.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, security, organization
SET row_security = off
AS $function$
    SELECT w.id
    FROM organization.workspaces w
    WHERE w.seed_key =
        security.context_value('workspace_key')
    LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION security.current_actor_person_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION security.current_actor_account_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION security.current_organization_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION security.current_workspace_id() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION security.current_actor_person_id()
TO vind_app_runtime, vind_importer;

GRANT EXECUTE ON FUNCTION security.current_actor_account_id()
TO vind_app_runtime, vind_importer;

GRANT EXECUTE ON FUNCTION security.current_organization_id()
TO vind_app_runtime, vind_importer;

GRANT EXECUTE ON FUNCTION security.current_workspace_id()
TO vind_app_runtime, vind_importer;

-- =========================================================
-- updated_at and immutable seed_key triggers
-- =========================================================

DO $block$
DECLARE
    v_relation text;
    v_relations text[] := ARRAY[
        'listing.channels',
        'geo.regions',
        'geo.locations',
        'party.persons',
        'party.contact_points',
        'party.consumer_profiles',
        'identity.accounts',
        'identity.identity_links',
        'organization.organizations',
        'organization.workspaces',
        'access.memberships',
        'access.scoped_assignments',
        'access.pic_assignments'
    ];
BEGIN
    FOREACH v_relation IN ARRAY v_relations LOOP
        EXECUTE format(
            'CREATE TRIGGER %I
             BEFORE UPDATE ON %s
             FOR EACH ROW
             EXECUTE FUNCTION security.set_updated_at()',
            replace(v_relation, '.', '_') || '_set_updated_at',
            v_relation
        );

        EXECUTE format(
            'CREATE TRIGGER %I
             BEFORE UPDATE OF seed_key ON %s
             FOR EACH ROW
             EXECUTE FUNCTION security.prevent_seed_key_change()',
            replace(v_relation, '.', '_') || '_seed_key_immutable',
            v_relation
        );
    END LOOP;
END;
$block$;

-- =========================================================
-- Row-level security
-- =========================================================

ALTER TABLE geo.locations ENABLE ROW LEVEL SECURITY;

ALTER TABLE party.persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE party.contact_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE party.consumer_profiles ENABLE ROW LEVEL SECURITY;

ALTER TABLE identity.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.identity_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization.workspaces ENABLE ROW LEVEL SECURITY;

ALTER TABLE access.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.scoped_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.pic_assignments ENABLE ROW LEVEL SECURITY;

-- Geo locations
CREATE POLICY locations_runtime_select
ON geo.locations
FOR SELECT
TO vind_app_runtime
USING (
    visibility = 'PUBLIC'
    OR organization_id = security.current_organization_id()
);

CREATE POLICY locations_runtime_write
ON geo.locations
FOR ALL
TO vind_app_runtime
USING (
    organization_id = security.current_organization_id()
)
WITH CHECK (
    organization_id = security.current_organization_id()
);

CREATE POLICY locations_importer_all
ON geo.locations
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Persons
CREATE POLICY persons_runtime_select
ON party.persons
FOR SELECT
TO vind_app_runtime
USING (id = security.current_actor_person_id());

CREATE POLICY persons_runtime_update
ON party.persons
FOR UPDATE
TO vind_app_runtime
USING (id = security.current_actor_person_id())
WITH CHECK (id = security.current_actor_person_id());

CREATE POLICY persons_importer_all
ON party.persons
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Contact points
CREATE POLICY contact_points_runtime_select
ON party.contact_points
FOR SELECT
TO vind_app_runtime
USING (person_id = security.current_actor_person_id());

CREATE POLICY contact_points_runtime_write
ON party.contact_points
FOR ALL
TO vind_app_runtime
USING (person_id = security.current_actor_person_id())
WITH CHECK (person_id = security.current_actor_person_id());

CREATE POLICY contact_points_importer_all
ON party.contact_points
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Consumer profiles
CREATE POLICY consumer_profiles_runtime_select
ON party.consumer_profiles
FOR SELECT
TO vind_app_runtime
USING (person_id = security.current_actor_person_id());

CREATE POLICY consumer_profiles_runtime_write
ON party.consumer_profiles
FOR ALL
TO vind_app_runtime
USING (person_id = security.current_actor_person_id())
WITH CHECK (person_id = security.current_actor_person_id());

CREATE POLICY consumer_profiles_importer_all
ON party.consumer_profiles
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Identity accounts
CREATE POLICY accounts_runtime_select
ON identity.accounts
FOR SELECT
TO vind_app_runtime
USING (
    EXISTS (
        SELECT 1
        FROM identity.identity_links il
        WHERE il.account_id = accounts.id
          AND il.person_id = security.current_actor_person_id()
          AND il.status = 'ACTIVE'
    )
);

CREATE POLICY accounts_importer_all
ON identity.accounts
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Identity links
CREATE POLICY identity_links_runtime_select
ON identity.identity_links
FOR SELECT
TO vind_app_runtime
USING (person_id = security.current_actor_person_id());

CREATE POLICY identity_links_importer_all
ON identity.identity_links
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Organizations
CREATE POLICY organizations_runtime_select
ON organization.organizations
FOR SELECT
TO vind_app_runtime
USING (id = security.current_organization_id());

CREATE POLICY organizations_runtime_update
ON organization.organizations
FOR UPDATE
TO vind_app_runtime
USING (id = security.current_organization_id())
WITH CHECK (id = security.current_organization_id());

CREATE POLICY organizations_importer_all
ON organization.organizations
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Workspaces
CREATE POLICY workspaces_runtime_select
ON organization.workspaces
FOR SELECT
TO vind_app_runtime
USING (organization_id = security.current_organization_id());

CREATE POLICY workspaces_runtime_update
ON organization.workspaces
FOR UPDATE
TO vind_app_runtime
USING (organization_id = security.current_organization_id())
WITH CHECK (organization_id = security.current_organization_id());

CREATE POLICY workspaces_importer_all
ON organization.workspaces
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Memberships
CREATE POLICY memberships_runtime_select
ON access.memberships
FOR SELECT
TO vind_app_runtime
USING (organization_id = security.current_organization_id());

CREATE POLICY memberships_runtime_write
ON access.memberships
FOR ALL
TO vind_app_runtime
USING (organization_id = security.current_organization_id())
WITH CHECK (organization_id = security.current_organization_id());

CREATE POLICY memberships_importer_all
ON access.memberships
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- Scoped assignments
CREATE POLICY scoped_assignments_runtime_select
ON access.scoped_assignments
FOR SELECT
TO vind_app_runtime
USING (organization_id = security.current_organization_id());

CREATE POLICY scoped_assignments_runtime_write
ON access.scoped_assignments
FOR ALL
TO vind_app_runtime
USING (organization_id = security.current_organization_id())
WITH CHECK (organization_id = security.current_organization_id());

CREATE POLICY scoped_assignments_importer_all
ON access.scoped_assignments
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- PIC assignments
CREATE POLICY pic_assignments_runtime_select
ON access.pic_assignments
FOR SELECT
TO vind_app_runtime
USING (
    EXISTS (
        SELECT 1
        FROM access.scoped_assignments sa
        WHERE sa.id = pic_assignments.scoped_assignment_id
          AND sa.organization_id =
              security.current_organization_id()
    )
);

CREATE POLICY pic_assignments_runtime_write
ON access.pic_assignments
FOR ALL
TO vind_app_runtime
USING (
    EXISTS (
        SELECT 1
        FROM access.scoped_assignments sa
        WHERE sa.id = pic_assignments.scoped_assignment_id
          AND sa.organization_id =
              security.current_organization_id()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM access.scoped_assignments sa
        WHERE sa.id = pic_assignments.scoped_assignment_id
          AND sa.organization_id =
              security.current_organization_id()
    )
);

CREATE POLICY pic_assignments_importer_all
ON access.pic_assignments
FOR ALL
TO vind_importer
USING (true)
WITH CHECK (true);

-- =========================================================
-- Privileges
-- =========================================================

REVOKE ALL ON ALL TABLES
IN SCHEMA listing, geo, party, identity, organization
FROM PUBLIC;

REVOKE ALL ON
    access.memberships,
    access.scoped_assignments,
    access.pic_assignments
FROM PUBLIC;

GRANT USAGE ON SCHEMA
    listing,
    geo,
    party,
    identity,
    organization,
    access
TO vind_app_runtime, vind_importer;

GRANT USAGE ON SCHEMA
    listing,
    geo
TO vind_readonly;

GRANT SELECT ON
    listing.channels,
    geo.regions
TO vind_app_runtime, vind_importer, vind_readonly;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    listing.channels,
    geo.regions,
    geo.locations,
    party.persons,
    party.contact_points,
    party.consumer_profiles,
    identity.accounts,
    identity.identity_links,
    organization.organizations,
    organization.workspaces,
    access.memberships,
    access.scoped_assignments,
    access.pic_assignments
TO vind_importer;

GRANT SELECT, UPDATE ON
    party.persons,
    organization.organizations,
    organization.workspaces
TO vind_app_runtime;

GRANT SELECT, INSERT, UPDATE ON
    party.contact_points,
    party.consumer_profiles,
    geo.locations,
    access.memberships,
    access.scoped_assignments,
    access.pic_assignments
TO vind_app_runtime;

GRANT SELECT ON
    identity.accounts,
    identity.identity_links
TO vind_app_runtime;