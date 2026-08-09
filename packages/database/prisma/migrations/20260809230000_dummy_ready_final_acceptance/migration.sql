-- 20260809230000_dummy_ready_final_acceptance/migration.sql
-- Forward-fix: Fully revoke vind_importer blanket DML, RLS policies, evidence SELECT, and function execution on DB-DEC021 relations.

-- 1. Revoke raw DML privileges on all 15 DB-DEC021 relations from vind_importer
REVOKE INSERT, UPDATE, DELETE ON TABLE
  provider.provider_profiles,
  provider.provider_workspace_links,
  provider.capability_definitions,
  provider.provider_capabilities,
  verification.verification_cases,
  verification.verification_evidence,
  catalog.offerings,
  catalog.resources,
  catalog.offering_resources,
  catalog.packages,
  catalog.package_items,
  media.media_assets,
  media.media_rights,
  media.media_links,
  listing.channel_publications
FROM vind_importer;

-- 2. Revoke direct SELECT privilege on verification.verification_evidence from vind_importer
REVOKE SELECT ON TABLE verification.verification_evidence FROM vind_importer;

-- 3. Drop unrestricted FOR ALL RLS policies for vind_importer on DB-DEC021 relations
DROP POLICY IF EXISTS importer_all_provider_profiles ON provider.provider_profiles;
DROP POLICY IF EXISTS importer_all_provider_workspace_links ON provider.provider_workspace_links;
DROP POLICY IF EXISTS importer_all_capability_definitions ON provider.capability_definitions;
DROP POLICY IF EXISTS importer_all_provider_capabilities ON provider.provider_capabilities;

DROP POLICY IF EXISTS importer_all_verification_cases ON verification.verification_cases;
DROP POLICY IF EXISTS importer_all_verification_evidence ON verification.verification_evidence;

DROP POLICY IF EXISTS importer_all_offerings ON catalog.offerings;
DROP POLICY IF EXISTS importer_all_resources ON catalog.resources;
DROP POLICY IF EXISTS importer_all_offering_resources ON catalog.offering_resources;
DROP POLICY IF EXISTS importer_all_packages ON catalog.packages;
DROP POLICY IF EXISTS importer_all_package_items ON catalog.package_items;

DROP POLICY IF EXISTS importer_all_media_assets ON media.media_assets;
DROP POLICY IF EXISTS importer_all_media_rights ON media.media_rights;
DROP POLICY IF EXISTS importer_all_media_links ON media.media_links;

DROP POLICY IF EXISTS importer_all_channel_publications ON listing.channel_publications;

-- 4. Revoke function execution privileges from vind_importer in domain schemas
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA provider FROM vind_importer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA verification FROM vind_importer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA catalog FROM vind_importer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA media FROM vind_importer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA listing FROM vind_importer;

REVOKE EXECUTE ON FUNCTION verification.read_evidence(uuid, text) FROM vind_importer;
