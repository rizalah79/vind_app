\set ON_ERROR_STOP on

SELECT
    migration_name,
    checksum_sha256,
    applied_at,
    execution_ms,
    session_user_name,
    effective_role_name
FROM public.vind_schema_migrations
ORDER BY migration_name;

SELECT
    schemaname,
    count(*) AS table_count
FROM pg_tables
WHERE schemaname IN (
    'listing',
    'geo',
    'party',
    'identity',
    'organization',
    'access'
)
GROUP BY schemaname
ORDER BY schemaname;

SELECT
    code,
    display_name,
    status
FROM listing.channels
ORDER BY code;

SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    c.relrowsecurity AS rls_enabled,
    count(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n
  ON n.oid = c.relnamespace
LEFT JOIN pg_policy p
  ON p.polrelid = c.oid
WHERE c.relkind = 'r'
  AND n.nspname IN (
      'geo',
      'party',
      'identity',
      'organization',
      'access'
  )
  AND c.relname IN (
      'locations',
      'persons',
      'contact_points',
      'consumer_profiles',
      'accounts',
      'identity_links',
      'organizations',
      'workspaces',
      'memberships',
      'scoped_assignments',
      'pic_assignments'
  )
GROUP BY
    n.nspname,
    c.relname,
    c.relrowsecurity
ORDER BY
    n.nspname,
    c.relname;

SELECT
    p.proname,
    pg_get_userbyid(p.proowner) AS function_owner,
    p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n
  ON n.oid = p.pronamespace
WHERE (
        n.nspname = 'security'
        AND p.proname IN (
            'current_actor_person_id',
            'current_actor_account_id',
            'current_organization_id',
            'current_workspace_id',
            'set_updated_at',
            'prevent_seed_key_change'
        )
    )
    OR (
        n.nspname = 'access'
        AND p.proname IN (
            'validate_membership_workspace',
            'validate_scoped_assignment',
            'validate_pic_assignment'
        )
    )
ORDER BY n.nspname, p.proname;

SELECT
    has_table_privilege(
        'vind_app_runtime',
        'listing.channels',
        'SELECT'
    ) AS runtime_can_read_channels,

    has_table_privilege(
        'vind_app_runtime',
        'party.contact_points',
        'INSERT'
    ) AS runtime_can_insert_contact,

    has_table_privilege(
        'vind_app_runtime',
        'organization.organizations',
        'INSERT'
    ) AS runtime_can_insert_organization,

    has_table_privilege(
        'vind_importer',
        'organization.organizations',
        'INSERT'
    ) AS importer_can_insert_organization,

    has_table_privilege(
        'vind_readonly',
        'party.persons',
        'SELECT'
    ) AS readonly_can_read_persons;

SELECT
    count(*) FILTER (
        WHERE conname LIKE '%no_overlap'
    ) AS exclusion_constraints,
    count(*) FILTER (
        WHERE conname LIKE '%synthetic%'
    ) AS synthetic_constraints,
    count(*) FILTER (
        WHERE conname LIKE '%seed_key%'
    ) AS seed_key_constraints
FROM pg_constraint
WHERE connamespace IN (
    'access'::regnamespace,
    'party'::regnamespace,
    'geo'::regnamespace,
    'identity'::regnamespace,
    'organization'::regnamespace,
    'listing'::regnamespace
);

SELECT PostGIS_Full_Version();