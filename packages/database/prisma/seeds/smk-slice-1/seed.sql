-- SMK Slice 1
-- Synthetic local fixture data only.
-- Transaction is managed by src/seed-smk.ts.

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';

-- =========================================================
-- Organizations
-- =========================================================

INSERT INTO organization.organizations (
    seed_key,
    legal_name,
    display_name,
    organization_type,
    status,
    verification_status,
    registration_country_code,
    registration_number,
    is_synthetic
)
VALUES
    (
        'smk:s1:org:alpha',
        'Organisasi Sintetis Alpha',
        'Sahabat Alpha',
        'SYNTHETIC_DEMO',
        'ACTIVE',
        'UNVERIFIED',
        'ID',
        NULL,
        true
    ),
    (
        'smk:s1:org:beta',
        'Organisasi Sintetis Beta',
        'Sahabat Beta',
        'SYNTHETIC_DEMO',
        'ACTIVE',
        'UNVERIFIED',
        'ID',
        NULL,
        true
    )
ON CONFLICT (seed_key) DO UPDATE
SET
    legal_name = EXCLUDED.legal_name,
    display_name = EXCLUDED.display_name,
    organization_type = EXCLUDED.organization_type,
    status = EXCLUDED.status,
    verification_status = EXCLUDED.verification_status,
    registration_country_code = EXCLUDED.registration_country_code,
    registration_number = EXCLUDED.registration_number,
    is_synthetic = EXCLUDED.is_synthetic;

-- =========================================================
-- Locations
-- =========================================================

INSERT INTO geo.locations (
    seed_key,
    organization_id,
    region_id,
    location_type,
    display_name,
    address_line_1,
    address_line_2,
    postal_code,
    visibility,
    precise_point,
    public_point,
    coordinate_source_type,
    source_license,
    source_metadata,
    status,
    is_synthetic
)
SELECT
    'smk:s1:location:alpha_hq',
    o.id,
    NULL::uuid,
    'OFFICE',
    'Lokasi Sintetis Alpha',
    'Alamat sintetis, bukan lokasi nyata',
    NULL::text,
    NULL::text,
    'PRIVATE',
    public.ST_SetSRID(
        public.ST_MakePoint(107.600000, -6.900000),
        4326
    )::public.geography,
    public.ST_SetSRID(
        public.ST_MakePoint(107.600500, -6.900500),
        4326
    )::public.geography,
    'SYNTHETIC',
    'SYNTHETIC_TEST_DATA',
    '{"profile":"SMK","slice":1,"synthetic":true}'::jsonb,
    'ACTIVE',
    true
FROM organization.organizations o
WHERE o.seed_key = 'smk:s1:org:alpha'
ON CONFLICT (seed_key) DO UPDATE
SET
    organization_id = EXCLUDED.organization_id,
    region_id = EXCLUDED.region_id,
    location_type = EXCLUDED.location_type,
    display_name = EXCLUDED.display_name,
    address_line_1 = EXCLUDED.address_line_1,
    address_line_2 = EXCLUDED.address_line_2,
    postal_code = EXCLUDED.postal_code,
    visibility = EXCLUDED.visibility,
    precise_point = EXCLUDED.precise_point,
    public_point = EXCLUDED.public_point,
    coordinate_source_type = EXCLUDED.coordinate_source_type,
    source_license = EXCLUDED.source_license,
    source_metadata = EXCLUDED.source_metadata,
    status = EXCLUDED.status,
    is_synthetic = EXCLUDED.is_synthetic;

INSERT INTO geo.locations (
    seed_key,
    organization_id,
    region_id,
    location_type,
    display_name,
    address_line_1,
    address_line_2,
    postal_code,
    visibility,
    precise_point,
    public_point,
    coordinate_source_type,
    source_license,
    source_metadata,
    status,
    is_synthetic
)
SELECT
    'smk:s1:location:beta_hq',
    o.id,
    NULL::uuid,
    'OFFICE',
    'Lokasi Sintetis Beta',
    'Alamat sintetis, bukan lokasi nyata',
    NULL::text,
    NULL::text,
    'PRIVATE',
    public.ST_SetSRID(
        public.ST_MakePoint(110.400000, -7.800000),
        4326
    )::public.geography,
    public.ST_SetSRID(
        public.ST_MakePoint(110.400500, -7.800500),
        4326
    )::public.geography,
    'SYNTHETIC',
    'SYNTHETIC_TEST_DATA',
    '{"profile":"SMK","slice":1,"synthetic":true}'::jsonb,
    'ACTIVE',
    true
FROM organization.organizations o
WHERE o.seed_key = 'smk:s1:org:beta'
ON CONFLICT (seed_key) DO UPDATE
SET
    organization_id = EXCLUDED.organization_id,
    region_id = EXCLUDED.region_id,
    location_type = EXCLUDED.location_type,
    display_name = EXCLUDED.display_name,
    address_line_1 = EXCLUDED.address_line_1,
    address_line_2 = EXCLUDED.address_line_2,
    postal_code = EXCLUDED.postal_code,
    visibility = EXCLUDED.visibility,
    precise_point = EXCLUDED.precise_point,
    public_point = EXCLUDED.public_point,
    coordinate_source_type = EXCLUDED.coordinate_source_type,
    source_license = EXCLUDED.source_license,
    source_metadata = EXCLUDED.source_metadata,
    status = EXCLUDED.status,
    is_synthetic = EXCLUDED.is_synthetic;
-- =========================================================
-- Workspaces
-- =========================================================

INSERT INTO organization.workspaces (
    seed_key,
    organization_id,
    primary_location_id,
    code,
    display_name,
    status,
    is_default
)
SELECT
    'smk:s1:workspace:alpha',
    o.id,
    l.id,
    'HQ',
    'Workspace Utama Alpha',
    'ACTIVE',
    true
FROM organization.organizations o
JOIN geo.locations l
  ON l.organization_id = o.id
 AND l.seed_key = 'smk:s1:location:alpha_hq'
WHERE o.seed_key = 'smk:s1:org:alpha'

UNION ALL

SELECT
    'smk:s1:workspace:beta',
    o.id,
    l.id,
    'HQ',
    'Workspace Utama Beta',
    'ACTIVE',
    true
FROM organization.organizations o
JOIN geo.locations l
  ON l.organization_id = o.id
 AND l.seed_key = 'smk:s1:location:beta_hq'
WHERE o.seed_key = 'smk:s1:org:beta'

ON CONFLICT (seed_key) DO UPDATE
SET
    organization_id = EXCLUDED.organization_id,
    primary_location_id = EXCLUDED.primary_location_id,
    code = EXCLUDED.code,
    display_name = EXCLUDED.display_name,
    status = EXCLUDED.status,
    is_default = EXCLUDED.is_default;

-- =========================================================
-- Persons
-- =========================================================

INSERT INTO party.persons (
    seed_key,
    display_name,
    preferred_name,
    legal_name,
    status,
    locale_code,
    timezone_name,
    is_synthetic,
    contactable
)
VALUES
    (
        'smk:s1:person:owner_alpha',
        'Pemilik Sintetis Alpha',
        'Owner Alpha',
        'Pemilik Sintetis Alpha',
        'ACTIVE',
        'id-ID',
        'Asia/Jakarta',
        true,
        false
    ),
    (
        'smk:s1:person:operations_alpha',
        'Operasional Sintetis Alpha',
        'Ops Alpha',
        'Operasional Sintetis Alpha',
        'ACTIVE',
        'id-ID',
        'Asia/Jakarta',
        true,
        false
    ),
    (
        'smk:s1:person:owner_beta',
        'Pemilik Sintetis Beta',
        'Owner Beta',
        'Pemilik Sintetis Beta',
        'ACTIVE',
        'id-ID',
        'Asia/Jakarta',
        true,
        false
    ),
    (
        'smk:s1:person:consumer',
        'Konsumen Sintetis',
        'Konsumen',
        'Konsumen Sintetis',
        'ACTIVE',
        'id-ID',
        'Asia/Jakarta',
        true,
        false
    )
ON CONFLICT (seed_key) DO UPDATE
SET
    display_name = EXCLUDED.display_name,
    preferred_name = EXCLUDED.preferred_name,
    legal_name = EXCLUDED.legal_name,
    status = EXCLUDED.status,
    locale_code = EXCLUDED.locale_code,
    timezone_name = EXCLUDED.timezone_name,
    is_synthetic = EXCLUDED.is_synthetic,
    contactable = EXCLUDED.contactable;

-- =========================================================
-- Contact points
-- =========================================================

INSERT INTO party.contact_points (
    seed_key,
    person_id,
    contact_type,
    label,
    value,
    normalized_value,
    verification_status,
    status,
    is_primary,
    is_synthetic,
    contactable,
    valid_from
)
SELECT
    fixture.seed_key,
    p.id,
    fixture.contact_type,
    fixture.label,
    fixture.value,
    fixture.normalized_value,
    'UNVERIFIED',
    'ACTIVE',
    fixture.is_primary,
    true,
    false,
    '2026-08-05T00:00:00Z'::timestamptz
FROM (
    VALUES
        (
            'smk:s1:contact:owner_alpha_email',
            'smk:s1:person:owner_alpha',
            'EMAIL',
            'Email sintetis',
            'owner.alpha@smk.invalid',
            'owner.alpha@smk.invalid',
            true
        ),
        (
            'smk:s1:contact:owner_alpha_phone',
            'smk:s1:person:owner_alpha',
            'PHONE',
            'OTP simulator',
            'otp-sim:owner-alpha',
            'otp-sim:owner-alpha',
            true
        ),
        (
            'smk:s1:contact:operations_alpha_email',
            'smk:s1:person:operations_alpha',
            'EMAIL',
            'Email sintetis',
            'operations.alpha@smk.invalid',
            'operations.alpha@smk.invalid',
            true
        ),
        (
            'smk:s1:contact:owner_beta_email',
            'smk:s1:person:owner_beta',
            'EMAIL',
            'Email sintetis',
            'owner.beta@smk.invalid',
            'owner.beta@smk.invalid',
            true
        ),
        (
            'smk:s1:contact:consumer_email',
            'smk:s1:person:consumer',
            'EMAIL',
            'Email sintetis',
            'consumer@smk.invalid',
            'consumer@smk.invalid',
            true
        ),
        (
            'smk:s1:contact:consumer_phone',
            'smk:s1:person:consumer',
            'PHONE',
            'OTP simulator',
            'otp-sim:consumer',
            'otp-sim:consumer',
            true
        )
) AS fixture (
    seed_key,
    person_seed_key,
    contact_type,
    label,
    value,
    normalized_value,
    is_primary
)
JOIN party.persons p
  ON p.seed_key = fixture.person_seed_key
ON CONFLICT (seed_key) DO UPDATE
SET
    person_id = EXCLUDED.person_id,
    contact_type = EXCLUDED.contact_type,
    label = EXCLUDED.label,
    value = EXCLUDED.value,
    normalized_value = EXCLUDED.normalized_value,
    verification_status = EXCLUDED.verification_status,
    status = EXCLUDED.status,
    is_primary = EXCLUDED.is_primary,
    is_synthetic = EXCLUDED.is_synthetic,
    contactable = EXCLUDED.contactable,
    valid_from = EXCLUDED.valid_from,
    valid_to = NULL;

-- =========================================================
-- Consumer profile
-- =========================================================

INSERT INTO party.consumer_profiles (
    seed_key,
    person_id,
    preferred_channel_code,
    status,
    preferences,
    is_synthetic
)
SELECT
    'smk:s1:consumer_profile:consumer',
    p.id,
    'VINDZAM',
    'ACTIVE',
    '{
      "language":"id-ID",
      "fixture_profile":"SMK",
      "synthetic":true
    }'::jsonb,
    true
FROM party.persons p
WHERE p.seed_key = 'smk:s1:person:consumer'
ON CONFLICT (seed_key) DO UPDATE
SET
    person_id = EXCLUDED.person_id,
    preferred_channel_code = EXCLUDED.preferred_channel_code,
    status = EXCLUDED.status,
    preferences = EXCLUDED.preferences,
    is_synthetic = EXCLUDED.is_synthetic;

-- =========================================================
-- Accounts
-- =========================================================

INSERT INTO identity.accounts (
    seed_key,
    account_type,
    status,
    last_authenticated_at
)
VALUES
    (
        'smk:s1:account:owner_alpha',
        'HUMAN',
        'ACTIVE',
        NULL
    ),
    (
        'smk:s1:account:operations_alpha',
        'HUMAN',
        'ACTIVE',
        NULL
    ),
    (
        'smk:s1:account:owner_beta',
        'HUMAN',
        'ACTIVE',
        NULL
    ),
    (
        'smk:s1:account:consumer',
        'HUMAN',
        'ACTIVE',
        NULL
    )
ON CONFLICT (seed_key) DO UPDATE
SET
    account_type = EXCLUDED.account_type,
    status = EXCLUDED.status,
    last_authenticated_at = EXCLUDED.last_authenticated_at;

-- =========================================================
-- Identity links
-- =========================================================

INSERT INTO identity.identity_links (
    seed_key,
    account_id,
    person_id,
    issuer,
    subject,
    assurance_level,
    status,
    is_primary,
    linked_at
)
SELECT
    fixture.seed_key,
    a.id,
    p.id,
    'https://identity.smk.invalid',
    fixture.subject,
    'BASIC',
    'ACTIVE',
    true,
    '2026-08-05T00:00:00Z'::timestamptz
FROM (
    VALUES
        (
            'smk:s1:identity_link:owner_alpha',
            'smk:s1:account:owner_alpha',
            'smk:s1:person:owner_alpha',
            'owner-alpha'
        ),
        (
            'smk:s1:identity_link:operations_alpha',
            'smk:s1:account:operations_alpha',
            'smk:s1:person:operations_alpha',
            'operations-alpha'
        ),
        (
            'smk:s1:identity_link:owner_beta',
            'smk:s1:account:owner_beta',
            'smk:s1:person:owner_beta',
            'owner-beta'
        ),
        (
            'smk:s1:identity_link:consumer',
            'smk:s1:account:consumer',
            'smk:s1:person:consumer',
            'consumer'
        )
) AS fixture (
    seed_key,
    account_seed_key,
    person_seed_key,
    subject
)
JOIN identity.accounts a
  ON a.seed_key = fixture.account_seed_key
JOIN party.persons p
  ON p.seed_key = fixture.person_seed_key
ON CONFLICT (seed_key) DO UPDATE
SET
    account_id = EXCLUDED.account_id,
    person_id = EXCLUDED.person_id,
    issuer = EXCLUDED.issuer,
    subject = EXCLUDED.subject,
    assurance_level = EXCLUDED.assurance_level,
    status = EXCLUDED.status,
    is_primary = EXCLUDED.is_primary,
    linked_at = EXCLUDED.linked_at,
    revoked_at = NULL;

-- =========================================================
-- Memberships
-- =========================================================

INSERT INTO access.memberships (
    seed_key,
    person_id,
    organization_id,
    workspace_id,
    status,
    effective_from,
    effective_to,
    invited_by_person_id,
    accepted_at
)
SELECT
    'smk:s1:membership:owner_alpha',
    p.id,
    o.id,
    NULL,
    'ACTIVE',
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz,
    NULL,
    '2026-08-05T00:00:00Z'::timestamptz
FROM party.persons p
JOIN organization.organizations o
  ON o.seed_key = 'smk:s1:org:alpha'
WHERE p.seed_key = 'smk:s1:person:owner_alpha'

UNION ALL

SELECT
    'smk:s1:membership:operations_alpha',
    p.id,
    o.id,
    w.id,
    'ACTIVE',
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz,
    inviter.id,
    '2026-08-05T00:00:00Z'::timestamptz
FROM party.persons p
JOIN organization.organizations o
  ON o.seed_key = 'smk:s1:org:alpha'
JOIN organization.workspaces w
  ON w.seed_key = 'smk:s1:workspace:alpha'
JOIN party.persons inviter
  ON inviter.seed_key = 'smk:s1:person:owner_alpha'
WHERE p.seed_key = 'smk:s1:person:operations_alpha'

UNION ALL

SELECT
    'smk:s1:membership:owner_beta',
    p.id,
    o.id,
    NULL,
    'ACTIVE',
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz,
    NULL,
    '2026-08-05T00:00:00Z'::timestamptz
FROM party.persons p
JOIN organization.organizations o
  ON o.seed_key = 'smk:s1:org:beta'
WHERE p.seed_key = 'smk:s1:person:owner_beta'

ON CONFLICT (seed_key) DO UPDATE
SET
    person_id = EXCLUDED.person_id,
    organization_id = EXCLUDED.organization_id,
    workspace_id = EXCLUDED.workspace_id,
    status = EXCLUDED.status,
    effective_from = EXCLUDED.effective_from,
    effective_to = EXCLUDED.effective_to,
    invited_by_person_id = EXCLUDED.invited_by_person_id,
    accepted_at = EXCLUDED.accepted_at;

-- =========================================================
-- Scoped role assignments
-- =========================================================

INSERT INTO access.scoped_assignments (
    seed_key,
    membership_id,
    role_code,
    scope_type,
    organization_id,
    workspace_id,
    status,
    effective_from,
    effective_to,
    reason_code
)
SELECT
    'smk:s1:assignment:owner_alpha',
    m.id,
    'OWNER',
    'ORGANIZATION',
    o.id,
    NULL,
    'ACTIVE',
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz,
    'SMK_FIXTURE'
FROM access.memberships m
JOIN organization.organizations o
  ON o.seed_key = 'smk:s1:org:alpha'
WHERE m.seed_key = 'smk:s1:membership:owner_alpha'

UNION ALL

SELECT
    'smk:s1:assignment:operations_alpha',
    m.id,
    'OPERATIONS_STAFF',
    'WORKSPACE',
    o.id,
    w.id,
    'ACTIVE',
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz,
    'SMK_FIXTURE'
FROM access.memberships m
JOIN organization.organizations o
  ON o.seed_key = 'smk:s1:org:alpha'
JOIN organization.workspaces w
  ON w.seed_key = 'smk:s1:workspace:alpha'
WHERE m.seed_key = 'smk:s1:membership:operations_alpha'

UNION ALL

SELECT
    'smk:s1:assignment:owner_beta',
    m.id,
    'OWNER',
    'ORGANIZATION',
    o.id,
    NULL,
    'ACTIVE',
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz,
    'SMK_FIXTURE'
FROM access.memberships m
JOIN organization.organizations o
  ON o.seed_key = 'smk:s1:org:beta'
WHERE m.seed_key = 'smk:s1:membership:owner_beta'

ON CONFLICT (seed_key) DO UPDATE
SET
    membership_id = EXCLUDED.membership_id,
    role_code = EXCLUDED.role_code,
    scope_type = EXCLUDED.scope_type,
    organization_id = EXCLUDED.organization_id,
    workspace_id = EXCLUDED.workspace_id,
    status = EXCLUDED.status,
    effective_from = EXCLUDED.effective_from,
    effective_to = EXCLUDED.effective_to,
    reason_code = EXCLUDED.reason_code;

-- =========================================================
-- PIC assignments
-- =========================================================

INSERT INTO access.pic_assignments (
    seed_key,
    scoped_assignment_id,
    responsibility_code,
    target_type,
    organization_id,
    workspace_id,
    location_id,
    status,
    is_primary,
    effective_from,
    effective_to
)
SELECT
    'smk:s1:pic:owner_alpha',
    sa.id,
    'PRIMARY_CONTACT',
    'ORGANIZATION',
    o.id,
    NULL::uuid,
    NULL::uuid,
    'ACTIVE',
    true,
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz
FROM access.scoped_assignments sa
JOIN organization.organizations o
  ON o.seed_key = 'smk:s1:org:alpha'
WHERE sa.seed_key = 'smk:s1:assignment:owner_alpha'

UNION ALL

SELECT
    'smk:s1:pic:operations_alpha',
    sa.id,
    'OPERATIONS',
    'WORKSPACE',
    NULL::uuid,
    w.id,
    NULL::uuid,
    'ACTIVE',
    true,
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz
FROM access.scoped_assignments sa
JOIN organization.workspaces w
  ON w.seed_key = 'smk:s1:workspace:alpha'
WHERE sa.seed_key = 'smk:s1:assignment:operations_alpha'

UNION ALL

SELECT
    'smk:s1:pic:owner_beta',
    sa.id,
    'PRIMARY_CONTACT',
    'ORGANIZATION',
    o.id,
    NULL::uuid,
    NULL::uuid,
    'ACTIVE',
    true,
    '2026-08-05T00:00:00Z'::timestamptz,
    NULL::timestamptz
FROM access.scoped_assignments sa
JOIN organization.organizations o
  ON o.seed_key = 'smk:s1:org:beta'
WHERE sa.seed_key = 'smk:s1:assignment:owner_beta'

ON CONFLICT (seed_key) DO UPDATE
SET
    scoped_assignment_id = EXCLUDED.scoped_assignment_id,
    responsibility_code = EXCLUDED.responsibility_code,
    target_type = EXCLUDED.target_type,
    organization_id = EXCLUDED.organization_id,
    workspace_id = EXCLUDED.workspace_id,
    location_id = EXCLUDED.location_id,
    status = EXCLUDED.status,
    is_primary = EXCLUDED.is_primary,
    effective_from = EXCLUDED.effective_from,
    effective_to = EXCLUDED.effective_to;