\set ON_ERROR_STOP on

SELECT
    migration_name,
    checksum_sha256,
    applied_at,
    execution_ms,
    session_user_name,
    effective_role_name,
    runner_version
FROM public.vind_schema_migrations
ORDER BY migration_name;

SELECT
    schemaname,
    count(*) AS table_count
FROM pg_tables
WHERE schemaname IN (
    'privacy',
    'access',
    'integration',
    'audit',
    'security',
    'staging'
)
GROUP BY schemaname
ORDER BY schemaname;

SELECT code
FROM privacy.retention_classes
ORDER BY code;

SELECT code, role_scope
FROM access.roles
ORDER BY code;

SELECT
    p.proname AS function_name,
    pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p
JOIN pg_namespace n
  ON n.oid = p.pronamespace
WHERE n.nspname = 'security'
ORDER BY p.proname;

SELECT
    has_table_privilege(
        'vind_app_runtime',
        'integration.idempotency_keys',
        'INSERT'
    ) AS runtime_can_insert_idempotency,

    has_table_privilege(
        'vind_app_runtime',
        'audit.audit_events',
        'INSERT'
    ) AS runtime_can_insert_audit,

    has_table_privilege(
        'vind_app_runtime',
        'audit.audit_events',
        'UPDATE'
    ) AS runtime_can_update_audit,

    has_table_privilege(
        'vind_importer',
        'staging.import_batches',
        'INSERT'
    ) AS importer_can_insert_batch,

    has_table_privilege(
        'vind_readonly',
        'staging.import_batches',
        'SELECT'
    ) AS readonly_can_read_batch;

SELECT
    count(*) FILTER (
        WHERE table_schema = 'privacy'
    ) AS privacy_tables,
    count(*) FILTER (
        WHERE table_schema = 'access'
    ) AS access_tables,
    count(*) FILTER (
        WHERE table_schema = 'integration'
    ) AS integration_tables,
    count(*) FILTER (
        WHERE table_schema = 'audit'
    ) AS audit_tables,
    count(*) FILTER (
        WHERE table_schema = 'security'
    ) AS security_tables,
    count(*) FILTER (
        WHERE table_schema = 'staging'
    ) AS staging_tables
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema IN (
      'privacy',
      'access',
      'integration',
      'audit',
      'security',
      'staging'
  );