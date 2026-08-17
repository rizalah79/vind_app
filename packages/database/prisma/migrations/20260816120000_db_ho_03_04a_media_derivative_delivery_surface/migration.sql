-- DB-HO-03-04A
-- Safe Media Derivative Delivery Surface
-- Additive only. Original/source media remains private.
-- No upload/transcoding/scanning pipeline is activated here.

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';
SET LOCAL row_security = off;

-- ============================================================================
-- 1. Safe derivative metadata
-- ============================================================================

CREATE TABLE media.media_derivatives (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    source_media_asset_id uuid NOT NULL
        REFERENCES media.media_assets(id)
        ON DELETE RESTRICT,

    variant_code text NOT NULL,
    is_canonical boolean NOT NULL DEFAULT false,

    content_type text NOT NULL,
    storage_locator text NOT NULL,
    checksum_sha256 text NOT NULL,

    scan_status text NOT NULL,
    moderation_status text NOT NULL,
    delivery_status text NOT NULL,

    width_px integer,
    height_px integer,

    effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
    effective_to timestamptz,

    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT chk_media_derivatives_scan_status
        CHECK (
            scan_status IN (
                'PENDING',
                'CLEAN',
                'QUARANTINED',
                'UNSAFE',
                'INFECTED',
                'FAILED'
            )
        ),

    CONSTRAINT chk_media_derivatives_moderation_status
        CHECK (
            moderation_status IN (
                'PENDING',
                'APPROVED',
                'BLOCKED'
            )
        ),

    CONSTRAINT chk_media_derivatives_delivery_status
        CHECK (
            delivery_status IN (
                'PENDING',
                'DELIVERABLE',
                'BLOCKED',
                'REVOKED'
            )
        ),

    CONSTRAINT chk_media_derivatives_period
        CHECK (
            effective_to IS NULL
            OR effective_to >= effective_from
        ),

    CONSTRAINT chk_media_derivatives_dimensions
        CHECK (
            (width_px IS NULL AND height_px IS NULL)
            OR
            (width_px > 0 AND height_px > 0)
        ),

    CONSTRAINT chk_media_derivatives_deliverable_safety
        CHECK (
            delivery_status <> 'DELIVERABLE'
            OR (
                scan_status = 'CLEAN'
                AND moderation_status = 'APPROVED'
            )
        )
);

ALTER TABLE media.media_derivatives OWNER TO vind_db_owner;

-- ============================================================================
-- 2. Indexes
-- ============================================================================

CREATE UNIQUE INDEX media_derivatives_canonical_source_uidx
    ON media.media_derivatives(source_media_asset_id)
    WHERE is_canonical = true;

CREATE UNIQUE INDEX media_derivatives_storage_locator_uidx
    ON media.media_derivatives(storage_locator);

CREATE INDEX media_links_public_delivery_idx
    ON media.media_links(
        media_asset_id,
        channel_publication_id,
        effective_from,
        effective_to
    )
    WHERE link_role = 'PUBLIC_LISTING'
      AND link_status = 'ACTIVE'
      AND channel_publication_id IS NOT NULL;

CREATE INDEX media_rights_active_delivery_idx
    ON media.media_rights(
        media_asset_id,
        effective_from,
        effective_to
    )
    WHERE status = 'ACTIVE';

-- ============================================================================
-- 3. Reject derivative locator reuse of original/source object
-- ============================================================================

CREATE OR REPLACE FUNCTION media.validate_derivative_storage_locator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM media.media_assets ma
        WHERE ma.id = NEW.source_media_asset_id
          AND ma.storage_path = NEW.storage_locator
    ) THEN
        RAISE EXCEPTION
            'Derivative storage locator must differ from source media storage path.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION media.validate_derivative_storage_locator()
    OWNER TO vind_db_owner;

REVOKE ALL
    ON FUNCTION media.validate_derivative_storage_locator()
    FROM PUBLIC;

REVOKE ALL
    ON FUNCTION media.validate_derivative_storage_locator()
    FROM vind_importer;

REVOKE ALL
    ON FUNCTION media.validate_derivative_storage_locator()
    FROM vind_app_runtime;

CREATE TRIGGER trg_media_derivative_storage_locator
BEFORE INSERT OR UPDATE OF source_media_asset_id, storage_locator
ON media.media_derivatives
FOR EACH ROW
EXECUTE FUNCTION media.validate_derivative_storage_locator();

-- ============================================================================
-- 4. Narrow authenticated media-delivery authorization
-- ============================================================================

CREATE OR REPLACE FUNCTION access.has_local_media_delivery_read(
    p_media_id uuid,
    p_at timestamptz DEFAULT statement_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$

SELECT EXISTS (
    SELECT 1
    FROM media.media_assets ma
    JOIN provider.provider_profiles pr
      ON pr.id = ma.owner_provider_profile_id
    JOIN access.scoped_assignments sa
      ON sa.seed_key = security.context_value('local_assignment_key')
    JOIN access.roles r
      ON r.code = sa.role_code

    WHERE ma.id = p_media_id

      -- Request Context V2
      AND security.context_value('context_initialized') = 'true'
      AND security.context_value('context_version') = '2'
      AND security.context_value('actor_kind') = 'HUMAN'
      AND security.context_value('authority_plane') = 'LOCAL'

      AND security.context_value('local_assignment_key') IS NOT NULL
      AND security.context_value('local_assignment_key') <> ''

      -- assignment actor / lifecycle
      AND sa.subject_person_id = security.current_actor_person_id()
      AND sa.status = 'ACTIVE'
      AND sa.effective_from <= p_at
      AND (sa.effective_to IS NULL OR sa.effective_to > p_at)

      AND r.authority_plane = 'SAHABAT'
      AND r.is_active = true

      -- source object must itself remain eligible
      AND ma.status = 'ACTIVE'

      -- provider must remain operationally active
      AND pr.status = 'ACTIVE'

      -- rights must be currently valid
      AND EXISTS (
          SELECT 1
          FROM media.media_rights mr
          WHERE mr.media_asset_id = ma.id
            AND mr.status = 'ACTIVE'
            AND mr.effective_from <= p_at
            AND (mr.effective_to IS NULL OR mr.effective_to > p_at)
      )

      AND (
          -- ================================================================
          -- ORGANIZATION scope
          -- ================================================================
          (
              sa.scope_type = 'ORGANIZATION'
              AND sa.membership_id IS NOT NULL
              AND sa.organization_id IS NOT NULL

              AND EXISTS (
                  SELECT 1
                  FROM access.memberships m
                  JOIN organization.organizations org
                    ON org.id = sa.organization_id
                  WHERE m.id = sa.membership_id
                    AND m.person_id = sa.subject_person_id
                    AND m.organization_id = sa.organization_id
                    AND m.status = 'ACTIVE'
                    AND m.effective_from <= p_at
                    AND (m.effective_to IS NULL OR m.effective_to > p_at)
                    AND org.seed_key =
                        security.context_value('organization_key')
              )

              AND (
                  pr.owning_organization_id = sa.organization_id

                  OR EXISTS (
                      SELECT 1
                      FROM provider.provider_workspace_links pwl
                      WHERE pwl.provider_profile_id = pr.id
                        AND pwl.managing_organization_id =
                            sa.organization_id
                        AND pwl.link_status = 'ACTIVE'
                        AND pwl.effective_from <= p_at
                        AND (
                            pwl.effective_to IS NULL
                            OR pwl.effective_to > p_at
                        )
                  )
              )
          )

          OR

          -- ================================================================
          -- WORKSPACE scope â€” strict workspace-bound
          -- ================================================================
          (
              sa.scope_type = 'WORKSPACE'
              AND sa.membership_id IS NOT NULL
              AND sa.organization_id IS NOT NULL
              AND sa.workspace_id IS NOT NULL

              AND EXISTS (
                  SELECT 1
                  FROM access.memberships m
                  JOIN organization.workspaces w
                    ON w.id = sa.workspace_id
                  JOIN organization.organizations org
                    ON org.id = sa.organization_id
                  WHERE m.id = sa.membership_id
                    AND m.person_id = sa.subject_person_id
                    AND m.organization_id = sa.organization_id
                    AND m.status = 'ACTIVE'
                    AND m.effective_from <= p_at
                    AND (m.effective_to IS NULL OR m.effective_to > p_at)
                    AND w.organization_id = sa.organization_id
                    AND w.status = 'ACTIVE'
                    AND w.seed_key =
                        security.context_value('workspace_key')
                    AND org.seed_key =
                        security.context_value('organization_key')
              )

              AND EXISTS (
                  SELECT 1
                  FROM provider.provider_workspace_links pwl
                  WHERE pwl.provider_profile_id = pr.id
                    AND pwl.managing_organization_id =
                        sa.organization_id
                    AND pwl.workspace_id = sa.workspace_id
                    AND pwl.link_status = 'ACTIVE'
                    AND pwl.effective_from <= p_at
                    AND (
                        pwl.effective_to IS NULL
                        OR pwl.effective_to > p_at
                    )
              )
          )

          OR

          -- ================================================================
          -- PROVIDER scope
          -- ================================================================
          (
              sa.scope_type = 'PROVIDER'
              AND sa.provider_id = pr.id
              AND pr.seed_key =
                  security.context_value('provider_key')

              AND (
                  -- independent person-owned provider
                  (
                      sa.membership_id IS NULL
                      AND pr.owning_person_id =
                          sa.subject_person_id
                      AND pr.owning_organization_id IS NULL
                  )

                  OR

                  -- organization-owned / managed provider
                  (
                      sa.membership_id IS NOT NULL

                      AND EXISTS (
                          SELECT 1
                          FROM access.memberships m
                          WHERE m.id = sa.membership_id
                            AND m.person_id =
                                sa.subject_person_id
                            AND m.status = 'ACTIVE'
                            AND m.effective_from <= p_at
                            AND (
                                m.effective_to IS NULL
                                OR m.effective_to > p_at
                            )
                            AND (
                                pr.owning_organization_id =
                                    m.organization_id

                                OR EXISTS (
                                    SELECT 1
                                    FROM provider.provider_workspace_links pwl
                                    WHERE pwl.provider_profile_id =
                                        pr.id
                                      AND pwl.managing_organization_id =
                                          m.organization_id
                                      AND pwl.link_status =
                                          'ACTIVE'
                                      AND pwl.effective_from <= p_at
                                      AND (
                                          pwl.effective_to IS NULL
                                          OR pwl.effective_to > p_at
                                      )
                                )
                            )
                      )
                  )
              )
          )
      )
);

$function$;

ALTER FUNCTION access.has_local_media_delivery_read(uuid, timestamptz)
    OWNER TO vind_db_owner;

REVOKE ALL
    ON FUNCTION access.has_local_media_delivery_read(uuid, timestamptz)
    FROM PUBLIC;

REVOKE ALL
    ON FUNCTION access.has_local_media_delivery_read(uuid, timestamptz)
    FROM vind_importer;

GRANT EXECUTE
    ON FUNCTION access.has_local_media_delivery_read(uuid, timestamptz)
    TO vind_app_runtime;

-- ============================================================================
-- 5. FORCE RLS on derivative surface
-- ============================================================================

ALTER TABLE media.media_derivatives
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE media.media_derivatives
    FORCE ROW LEVEL SECURITY;

REVOKE ALL
    ON TABLE media.media_derivatives
    FROM PUBLIC;

REVOKE ALL
    ON TABLE media.media_derivatives
    FROM vind_importer;

REVOKE ALL
    ON TABLE media.media_derivatives
    FROM vind_app_runtime;

GRANT SELECT
    ON TABLE media.media_derivatives
    TO vind_app_runtime;

CREATE POLICY owner_all_media_derivatives
ON media.media_derivatives
FOR ALL
TO vind_db_owner
USING (true)
WITH CHECK (true);

CREATE POLICY runtime_media_derivatives_delivery
ON media.media_derivatives
FOR SELECT
TO vind_app_runtime
USING (
    is_canonical = true
    AND scan_status = 'CLEAN'
    AND moderation_status = 'APPROVED'
    AND delivery_status = 'DELIVERABLE'
    AND effective_from <= statement_timestamp()
    AND (
        effective_to IS NULL
        OR effective_to > statement_timestamp()
    )
    AND access.has_local_media_delivery_read(
        source_media_asset_id,
        statement_timestamp()
    )
);