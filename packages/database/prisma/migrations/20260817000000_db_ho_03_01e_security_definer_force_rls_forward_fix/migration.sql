-- DB-HO-03-01E
-- SECURITY DEFINER / FORCE-RLS Forward Fix
--
-- Compatibility Defect:
-- Historical 03-01A and 03-01B migrations created SECURITY DEFINER functions
-- with `SET row_security = off`. When tables owned by vind_db_owner (NOBYPASSRLS)
-- have `FORCE ROW LEVEL SECURITY = true`, PostgreSQL throws SQLSTATE 42501
-- because row_security cannot be disabled for forced-RLS tables.
--
-- Resolution:
-- Align all 5 DB-HO-03-01 SECURITY DEFINER functions to `SET row_security = on`.
--
-- Security Invariants Maintained:
-- - Historical migrations remain 100% immutable and byte-for-byte unchanged.
-- - FORCE ROW LEVEL SECURITY remains enabled on all application tables.
-- - vind_db_owner and vind_migrator remain NOBYPASSRLS.
-- - No new owner policies or weakened RLS rules added.

SET search_path = pg_catalog;

ALTER FUNCTION listing.read_public_listings(text, uuid, timestamptz, uuid, integer) SET row_security = on;
ALTER FUNCTION listing.read_public_listing(uuid, text) SET row_security = on;
ALTER FUNCTION provider.read_public_provider(uuid, text) SET row_security = on;
ALTER FUNCTION access.has_local_provider_catalog_read(uuid, timestamptz) SET row_security = on;
ALTER FUNCTION access.has_local_tenant_provider_read(uuid, timestamptz) SET row_security = on;
