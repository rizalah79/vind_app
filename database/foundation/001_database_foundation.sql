\set ON_ERROR_STOP on

BEGIN;

-- =========================================================
-- Extension baseline
-- =========================================================

DROP EXTENSION IF EXISTS postgis_tiger_geocoder CASCADE;
DROP EXTENSION IF EXISTS postgis_topology CASCADE;
DROP EXTENSION IF EXISTS fuzzystrmatch CASCADE;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =========================================================
-- Technical roles
-- =========================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'vind_db_owner'
    ) THEN
        CREATE ROLE vind_db_owner
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOINHERIT
            NOREPLICATION
            NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'vind_migrator'
    ) THEN
        CREATE ROLE vind_migrator
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOINHERIT
            NOREPLICATION
            NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'vind_app_runtime'
    ) THEN
        CREATE ROLE vind_app_runtime
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            INHERIT
            NOREPLICATION
            NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'vind_importer'
    ) THEN
        CREATE ROLE vind_importer
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            INHERIT
            NOREPLICATION
            NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'vind_readonly'
    ) THEN
        CREATE ROLE vind_readonly
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            INHERIT
            NOREPLICATION
            NOBYPASSRLS;
    END IF;
END
$$;

ALTER ROLE vind_migrator
    PASSWORD :'migrator_password';

ALTER ROLE vind_app_runtime
    PASSWORD :'runtime_password';

ALTER ROLE vind_importer
    PASSWORD :'importer_password';

ALTER ROLE vind_readonly
    PASSWORD :'readonly_password';

-- Migrator harus memakai SET ROLE secara eksplisit.
GRANT vind_db_owner TO vind_migrator;

-- =========================================================
-- Database ownership and connection policy
-- =========================================================

ALTER DATABASE vind_app_dev OWNER TO vind_db_owner;
ALTER DATABASE vind_app_dev SET timezone TO 'UTC';

REVOKE ALL ON DATABASE vind_app_dev FROM PUBLIC;

GRANT CONNECT ON DATABASE vind_app_dev TO
    vind_migrator,
    vind_app_runtime,
    vind_importer,
    vind_readonly;

ALTER ROLE vind_migrator
    IN DATABASE vind_app_dev
    SET search_path = pg_catalog, public;

ALTER ROLE vind_app_runtime
    IN DATABASE vind_app_dev
    SET search_path = pg_catalog, public;

ALTER ROLE vind_importer
    IN DATABASE vind_app_dev
    SET search_path = pg_catalog, public;

ALTER ROLE vind_readonly
    IN DATABASE vind_app_dev
    SET search_path = pg_catalog, public;

ALTER ROLE vind_app_runtime SET row_security = on;
ALTER ROLE vind_importer SET row_security = on;
ALTER ROLE vind_readonly SET row_security = on;

-- =========================================================
-- Public schema lockdown
-- =========================================================

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO
    vind_migrator,
    vind_app_runtime,
    vind_importer,
    vind_readonly;

-- =========================================================
-- Logical schemas
-- =========================================================

DO $$
DECLARE
    schema_name text;
    schema_names text[] := ARRAY[
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
    ];
BEGIN
    FOREACH schema_name IN ARRAY schema_names LOOP
        EXECUTE format(
            'CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION vind_db_owner',
            schema_name
        );

        EXECUTE format(
            'ALTER SCHEMA %I OWNER TO vind_db_owner',
            schema_name
        );

        EXECUTE format(
            'REVOKE ALL ON SCHEMA %I FROM PUBLIC',
            schema_name
        );

        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA %I
             REVOKE ALL ON TABLES FROM PUBLIC',
            schema_name
        );

        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA %I
             REVOKE ALL ON SEQUENCES FROM PUBLIC',
            schema_name
        );

        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA %I
             REVOKE ALL ON FUNCTIONS FROM PUBLIC',
            schema_name
        );

        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE vind_db_owner IN SCHEMA %I
             REVOKE ALL ON TYPES FROM PUBLIC',
            schema_name
        );
    END LOOP;
END
$$;

-- Schema visibility only. Table privileges will be explicit
-- in each approved domain migration.

GRANT USAGE ON SCHEMA
    identity,
    party,
    privacy,
    organization,
    access,
    geo,
    provider,
    verification,
    catalog,
    listing,
    media,
    availability,
    engagement,
    messaging,
    commercial,
    content,
    ads,
    sponsor,
    finance,
    audit,
    security,
    integration
TO vind_app_runtime;

GRANT USAGE ON SCHEMA
    identity,
    party,
    privacy,
    organization,
    access,
    geo,
    provider,
    verification,
    catalog,
    listing,
    media,
    availability,
    engagement,
    messaging,
    commercial,
    content,
    ads,
    sponsor,
    finance,
    staging
TO vind_importer;

COMMIT;