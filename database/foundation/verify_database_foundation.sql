\set ON_ERROR_STOP on

SELECT
    current_database() AS database_name,
    pg_get_userbyid(datdba) AS database_owner,
    datcollate,
    datctype
FROM pg_database
WHERE datname = current_database();

SELECT
    extname,
    extversion
FROM pg_extension
ORDER BY extname;

SELECT
    rolname,
    rolcanlogin,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolbypassrls,
    rolinherit
FROM pg_roles
WHERE rolname LIKE 'vind_%'
ORDER BY rolname;

SELECT
    n.nspname AS schema_name,
    pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname IN (
    'identity',
    'party',
    'privacy',
    'organization',
    'access',
    'geo',
    'provider',
    'verification',
    'catalog',
    'listing',
    'media',
    'availability',
    'engagement',
    'messaging',
    'commercial',
    'content',
    'ads',
    'sponsor',
    'finance',
    'audit',
    'security',
    'integration',
    'staging'
)
ORDER BY n.nspname;

SELECT
    pg_has_role(
        'vind_migrator',
        'vind_db_owner',
        'MEMBER'
    ) AS migrator_is_owner_member,
    has_schema_privilege(
        'public',
        'public',
        'CREATE'
    ) AS public_can_create_in_public;

SELECT PostGIS_Full_Version();