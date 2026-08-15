-- DB-HO-03-01B — Provider/Catalog LOCAL Read RLS Alignment
-- Aligns ORGANIZATION / WORKSPACE / PROVIDER LOCAL read authority.
-- WORKSPACE authority is strict workspace-bound.
-- PROVIDER scope is limited to Provider + Catalog for B3.
-- Non-B3 provider domains remain tenant-only.
-- Request Context V2 remains authoritative.

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';
SET LOCAL row_security = off;

-- ============================================================================
-- 1. Helper Function #1: access.has_local_provider_catalog_read
-- ============================================================================

CREATE OR REPLACE FUNCTION access.has_local_provider_catalog_read(
    p_provider_id uuid,
    p_at timestamptz DEFAULT statement_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
SELECT EXISTS (
    SELECT 1
    FROM access.scoped_assignments sa
    JOIN access.roles r ON r.code = sa.role_code
    JOIN provider.provider_profiles pr ON pr.id = p_provider_id
    WHERE security.context_value('context_initialized') = 'true'
      AND security.context_value('context_version') = '2'
      AND security.context_value('actor_kind') = 'HUMAN'
      AND security.context_value('authority_plane') = 'LOCAL'
      AND security.context_value('local_assignment_key') IS NOT NULL
      AND security.context_value('local_assignment_key') <> ''
      AND sa.seed_key = security.context_value('local_assignment_key')
      AND sa.subject_person_id = security.current_actor_person_id()
      AND sa.status = 'ACTIVE'
      AND sa.effective_from <= p_at
      AND (sa.effective_to IS NULL OR sa.effective_to > p_at)
      AND r.authority_plane = 'SAHABAT'
      AND r.is_active = true
      AND (
          -- Organization Scope Branch
          (
              sa.scope_type = 'ORGANIZATION'
              AND sa.membership_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM access.memberships m
                  JOIN organization.organizations org ON org.id = sa.organization_id
                  WHERE m.id = sa.membership_id
                    AND m.person_id = sa.subject_person_id
                    AND m.organization_id = sa.organization_id
                    AND m.status = 'ACTIVE'
                    AND m.effective_from <= p_at
                    AND (m.effective_to IS NULL OR m.effective_to > p_at)
                    AND org.seed_key = security.context_value('organization_key')
              )
              AND (
                  pr.owning_organization_id = sa.organization_id
                  OR EXISTS (
                      SELECT 1
                      FROM provider.provider_workspace_links pwl
                      WHERE pwl.provider_profile_id = p_provider_id
                        AND pwl.managing_organization_id = sa.organization_id
                        AND pwl.link_status = 'ACTIVE'
                        AND pwl.effective_from <= p_at
                        AND (pwl.effective_to IS NULL OR pwl.effective_to > p_at)
                  )
              )
          )
          OR
          -- Workspace Scope Branch (Strict Workspace-Bound)
          (
              sa.scope_type = 'WORKSPACE'
              AND sa.membership_id IS NOT NULL
              AND sa.organization_id IS NOT NULL
              AND sa.workspace_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM access.memberships m
                  JOIN organization.workspaces w ON w.id = sa.workspace_id
                  JOIN organization.organizations org ON org.id = sa.organization_id
                  WHERE m.id = sa.membership_id
                    AND m.person_id = sa.subject_person_id
                    AND m.organization_id = sa.organization_id
                    AND m.status = 'ACTIVE'
                    AND m.effective_from <= p_at
                    AND (m.effective_to IS NULL OR m.effective_to > p_at)
                    AND w.organization_id = sa.organization_id
                    AND w.status = 'ACTIVE'
                    AND w.seed_key = security.context_value('workspace_key')
                    AND org.seed_key = security.context_value('organization_key')
              )
              AND EXISTS (
                  SELECT 1
                  FROM provider.provider_workspace_links pwl
                  WHERE pwl.provider_profile_id = p_provider_id
                    AND pwl.managing_organization_id = sa.organization_id
                    AND pwl.workspace_id = sa.workspace_id
                    AND pwl.link_status = 'ACTIVE'
                    AND pwl.effective_from <= p_at
                    AND (pwl.effective_to IS NULL OR pwl.effective_to > p_at)
              )
          )
          OR
          -- Provider Scope Branch
          (
              sa.scope_type = 'PROVIDER'
              AND sa.provider_id = p_provider_id
              AND pr.seed_key = security.context_value('provider_key')
              AND pr.status <> 'ARCHIVED'
              AND (
                  (
                      sa.membership_id IS NULL
                      AND pr.owning_person_id = sa.subject_person_id
                      AND pr.owning_organization_id IS NULL
                  )
                  OR
                  (
                      sa.membership_id IS NOT NULL
                      AND EXISTS (
                          SELECT 1
                          FROM access.memberships m
                          WHERE m.id = sa.membership_id
                            AND m.person_id = sa.subject_person_id
                            AND m.status = 'ACTIVE'
                            AND m.effective_from <= p_at
                            AND (m.effective_to IS NULL OR m.effective_to > p_at)
                            AND (
                                pr.owning_organization_id = m.organization_id
                                OR EXISTS (
                                    SELECT 1
                                    FROM provider.provider_workspace_links pwl
                                    WHERE pwl.provider_profile_id = p_provider_id
                                      AND pwl.managing_organization_id = m.organization_id
                                      AND pwl.link_status = 'ACTIVE'
                                      AND pwl.effective_from <= p_at
                                      AND (pwl.effective_to IS NULL OR pwl.effective_to > p_at)
                                )
                            )
                      )
                  )
              )
          )
      )
);
$function$;

-- ============================================================================
-- 2. Helper Function #2: access.has_local_tenant_provider_read
-- ============================================================================

CREATE OR REPLACE FUNCTION access.has_local_tenant_provider_read(
    p_provider_id uuid,
    p_at timestamptz DEFAULT statement_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
SELECT EXISTS (
    SELECT 1
    FROM access.scoped_assignments sa
    JOIN access.roles r ON r.code = sa.role_code
    JOIN provider.provider_profiles pr ON pr.id = p_provider_id
    WHERE security.context_value('context_initialized') = 'true'
      AND security.context_value('context_version') = '2'
      AND security.context_value('actor_kind') = 'HUMAN'
      AND security.context_value('authority_plane') = 'LOCAL'
      AND security.context_value('local_assignment_key') IS NOT NULL
      AND security.context_value('local_assignment_key') <> ''
      AND sa.seed_key = security.context_value('local_assignment_key')
      AND sa.subject_person_id = security.current_actor_person_id()
      AND sa.status = 'ACTIVE'
      AND sa.effective_from <= p_at
      AND (sa.effective_to IS NULL OR sa.effective_to > p_at)
      AND r.authority_plane = 'SAHABAT'
      AND r.is_active = true
      AND (
          -- Organization Scope Branch
          (
              sa.scope_type = 'ORGANIZATION'
              AND sa.membership_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM access.memberships m
                  JOIN organization.organizations org ON org.id = sa.organization_id
                  WHERE m.id = sa.membership_id
                    AND m.person_id = sa.subject_person_id
                    AND m.organization_id = sa.organization_id
                    AND m.status = 'ACTIVE'
                    AND m.effective_from <= p_at
                    AND (m.effective_to IS NULL OR m.effective_to > p_at)
                    AND org.seed_key = security.context_value('organization_key')
              )
              AND (
                  pr.owning_organization_id = sa.organization_id
                  OR EXISTS (
                      SELECT 1
                      FROM provider.provider_workspace_links pwl
                      WHERE pwl.provider_profile_id = p_provider_id
                        AND pwl.managing_organization_id = sa.organization_id
                        AND pwl.link_status = 'ACTIVE'
                        AND pwl.effective_from <= p_at
                        AND (pwl.effective_to IS NULL OR pwl.effective_to > p_at)
                  )
              )
          )
          OR
          -- Workspace Scope Branch (Strict Workspace-Bound)
          (
              sa.scope_type = 'WORKSPACE'
              AND sa.membership_id IS NOT NULL
              AND sa.organization_id IS NOT NULL
              AND sa.workspace_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM access.memberships m
                  JOIN organization.workspaces w ON w.id = sa.workspace_id
                  JOIN organization.organizations org ON org.id = sa.organization_id
                  WHERE m.id = sa.membership_id
                    AND m.person_id = sa.subject_person_id
                    AND m.organization_id = sa.organization_id
                    AND m.status = 'ACTIVE'
                    AND m.effective_from <= p_at
                    AND (m.effective_to IS NULL OR m.effective_to > p_at)
                    AND w.organization_id = sa.organization_id
                    AND w.status = 'ACTIVE'
                    AND w.seed_key = security.context_value('workspace_key')
                    AND org.seed_key = security.context_value('organization_key')
              )
              AND EXISTS (
                  SELECT 1
                  FROM provider.provider_workspace_links pwl
                  WHERE pwl.provider_profile_id = p_provider_id
                    AND pwl.managing_organization_id = sa.organization_id
                    AND pwl.workspace_id = sa.workspace_id
                    AND pwl.link_status = 'ACTIVE'
                    AND pwl.effective_from <= p_at
                    AND (pwl.effective_to IS NULL OR pwl.effective_to > p_at)
              )
          )
      )
);
$function$;

-- ============================================================================
-- 3. Function Ownership & ACL
-- ============================================================================

ALTER FUNCTION access.has_local_provider_catalog_read(uuid, timestamptz) OWNER TO vind_db_owner;
ALTER FUNCTION access.has_local_tenant_provider_read(uuid, timestamptz) OWNER TO vind_db_owner;

REVOKE ALL ON FUNCTION access.has_local_provider_catalog_read(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION access.has_local_provider_catalog_read(uuid, timestamptz) FROM vind_importer;
GRANT EXECUTE ON FUNCTION access.has_local_provider_catalog_read(uuid, timestamptz) TO vind_app_runtime;

REVOKE ALL ON FUNCTION access.has_local_tenant_provider_read(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION access.has_local_tenant_provider_read(uuid, timestamptz) FROM vind_importer;
GRANT EXECUTE ON FUNCTION access.has_local_tenant_provider_read(uuid, timestamptz) TO vind_app_runtime;

-- ============================================================================
-- 4. RLS Policy Replacements (13 SELECT Policies)
-- ============================================================================

-- 1. provider.provider_profiles
DROP POLICY IF EXISTS runtime_provider_profiles ON provider.provider_profiles;
CREATE POLICY runtime_provider_profiles ON provider.provider_profiles FOR SELECT TO vind_app_runtime USING (
    access.has_local_provider_catalog_read(id)
);

-- 2. provider.provider_workspace_links
DROP POLICY IF EXISTS runtime_provider_workspace_links ON provider.provider_workspace_links;
CREATE POLICY runtime_provider_workspace_links ON provider.provider_workspace_links FOR SELECT TO vind_app_runtime USING (
    EXISTS (
        SELECT 1
        FROM access.scoped_assignments sa
        JOIN access.roles r ON r.code = sa.role_code
        WHERE security.context_value('context_initialized') = 'true'
          AND security.context_value('context_version') = '2'
          AND security.context_value('actor_kind') = 'HUMAN'
          AND security.context_value('authority_plane') = 'LOCAL'
          AND security.context_value('local_assignment_key') IS NOT NULL
          AND security.context_value('local_assignment_key') <> ''
          AND sa.seed_key = security.context_value('local_assignment_key')
          AND sa.subject_person_id = security.current_actor_person_id()
          AND sa.status = 'ACTIVE'
          AND sa.effective_from <= statement_timestamp()
          AND (sa.effective_to IS NULL OR sa.effective_to > statement_timestamp())
          AND r.authority_plane = 'SAHABAT'
          AND r.is_active = true
          AND (
              (
                  sa.scope_type = 'ORGANIZATION'
                  AND sa.organization_id = provider_workspace_links.managing_organization_id
                  AND EXISTS (
                      SELECT 1
                      FROM access.memberships m
                      JOIN organization.organizations org ON org.id = sa.organization_id
                      WHERE m.id = sa.membership_id
                        AND m.person_id = sa.subject_person_id
                        AND m.organization_id = sa.organization_id
                        AND m.status = 'ACTIVE'
                        AND m.effective_from <= statement_timestamp()
                        AND (m.effective_to IS NULL OR m.effective_to > statement_timestamp())
                        AND org.seed_key = security.context_value('organization_key')
                  )
              )
              OR
              (
                  sa.scope_type = 'WORKSPACE'
                  AND sa.organization_id = provider_workspace_links.managing_organization_id
                  AND sa.workspace_id = provider_workspace_links.workspace_id
                  AND EXISTS (
                      SELECT 1
                      FROM access.memberships m
                      JOIN organization.workspaces w ON w.id = sa.workspace_id
                      JOIN organization.organizations org ON org.id = sa.organization_id
                      WHERE m.id = sa.membership_id
                        AND m.person_id = sa.subject_person_id
                        AND m.organization_id = sa.organization_id
                        AND m.status = 'ACTIVE'
                        AND m.effective_from <= statement_timestamp()
                        AND (m.effective_to IS NULL OR m.effective_to > statement_timestamp())
                        AND w.organization_id = sa.organization_id
                        AND w.status = 'ACTIVE'
                        AND w.seed_key = security.context_value('workspace_key')
                        AND org.seed_key = security.context_value('organization_key')
                  )
              )
          )
    )
);

-- 3. provider.provider_capabilities
DROP POLICY IF EXISTS runtime_provider_capabilities ON provider.provider_capabilities;
CREATE POLICY runtime_provider_capabilities ON provider.provider_capabilities FOR SELECT TO vind_app_runtime USING (
    access.has_local_tenant_provider_read(provider_profile_id)
);

-- 4. verification.verification_cases
DROP POLICY IF EXISTS runtime_verification_cases ON verification.verification_cases;
CREATE POLICY runtime_verification_cases ON verification.verification_cases FOR SELECT TO vind_app_runtime USING (
    access.has_local_tenant_provider_read(provider_profile_id)
);

-- 5. catalog.offerings
DROP POLICY IF EXISTS runtime_offerings ON catalog.offerings;
CREATE POLICY runtime_offerings ON catalog.offerings FOR SELECT TO vind_app_runtime USING (
    access.has_local_provider_catalog_read(provider_profile_id)
);

-- 6. catalog.resources
DROP POLICY IF EXISTS runtime_resources ON catalog.resources;
CREATE POLICY runtime_resources ON catalog.resources FOR SELECT TO vind_app_runtime USING (
    access.has_local_provider_catalog_read(provider_profile_id)
);

-- 7. catalog.offering_resources
DROP POLICY IF EXISTS runtime_offering_resources ON catalog.offering_resources;
CREATE POLICY runtime_offering_resources ON catalog.offering_resources FOR SELECT TO vind_app_runtime USING (
    EXISTS (
        SELECT 1
        FROM catalog.offerings o
        JOIN catalog.resources r ON r.id = offering_resources.resource_id
        WHERE o.id = offering_resources.offering_id
          AND o.provider_profile_id = r.provider_profile_id
          AND access.has_local_provider_catalog_read(o.provider_profile_id)
    )
);

-- 8. catalog.packages
DROP POLICY IF EXISTS runtime_packages ON catalog.packages;
CREATE POLICY runtime_packages ON catalog.packages FOR SELECT TO vind_app_runtime USING (
    access.has_local_provider_catalog_read(provider_profile_id)
);

-- 9. catalog.package_items
DROP POLICY IF EXISTS runtime_package_items ON catalog.package_items;
CREATE POLICY runtime_package_items ON catalog.package_items FOR SELECT TO vind_app_runtime USING (
    EXISTS (
        SELECT 1
        FROM catalog.packages pkg
        JOIN catalog.offerings o ON o.id = package_items.offering_id
        WHERE pkg.id = package_items.package_id
          AND pkg.provider_profile_id = o.provider_profile_id
          AND access.has_local_provider_catalog_read(pkg.provider_profile_id)
    )
);

-- 10. media.media_assets
DROP POLICY IF EXISTS runtime_media_assets ON media.media_assets;
CREATE POLICY runtime_media_assets ON media.media_assets FOR SELECT TO vind_app_runtime USING (
    access.has_local_tenant_provider_read(owner_provider_profile_id)
);

-- 11. media.media_rights
DROP POLICY IF EXISTS runtime_media_rights ON media.media_rights;
CREATE POLICY runtime_media_rights ON media.media_rights FOR SELECT TO vind_app_runtime USING (
    EXISTS (
        SELECT 1
        FROM media.media_assets ma
        WHERE ma.id = media_rights.media_asset_id
          AND access.has_local_tenant_provider_read(ma.owner_provider_profile_id)
    )
);

-- 12. media.media_links
DROP POLICY IF EXISTS runtime_media_links ON media.media_links;
CREATE POLICY runtime_media_links ON media.media_links FOR SELECT TO vind_app_runtime USING (
    EXISTS (
        SELECT 1
        FROM media.media_assets ma
        WHERE ma.id = media_links.media_asset_id
          AND access.has_local_tenant_provider_read(ma.owner_provider_profile_id)
    )
);

-- 13. listing.channel_publications
DROP POLICY IF EXISTS runtime_channel_publications ON listing.channel_publications;
CREATE POLICY runtime_channel_publications ON listing.channel_publications FOR SELECT TO vind_app_runtime USING (
    access.has_local_tenant_provider_read(provider_profile_id)
);

-- ============================================================================
-- 5. Provider Workspace Link Indexes
-- ============================================================================

CREATE INDEX provider_workspace_links_workspace_active_idx
ON provider.provider_workspace_links (
    workspace_id,
    provider_profile_id
)
WHERE workspace_id IS NOT NULL
  AND link_status = 'ACTIVE';

CREATE INDEX provider_workspace_links_managing_org_active_idx
ON provider.provider_workspace_links (
    managing_organization_id,
    provider_profile_id
)
WHERE link_status = 'ACTIVE';
