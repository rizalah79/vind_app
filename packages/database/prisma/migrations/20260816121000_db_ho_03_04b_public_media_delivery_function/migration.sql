-- DB-HO-03-04B
-- Public Safe Media Delivery Contract
-- Public reads receive only an approved canonical derivative.
-- Original media storage_path remains private.

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';
SET LOCAL row_security = on;

CREATE OR REPLACE FUNCTION media.read_public_media_delivery(
    p_media_id uuid,
    p_channel_code text
)
RETURNS TABLE (
    media_id uuid,
    derivative_id uuid,
    storage_locator text,
    content_type text,
    variant_code text,
    width_px integer,
    height_px integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
    v_at timestamptz := statement_timestamp();
    v_channel_id uuid;
BEGIN
    IF p_media_id IS NULL THEN
        RETURN;
    END IF;

    IF p_channel_code IS NULL OR btrim(p_channel_code) = '' THEN
        RETURN;
    END IF;

    -- Resolve only a currently ACTIVE canonical channel.
    SELECT ch.id
    INTO v_channel_id
    FROM listing.channels ch
    WHERE ch.code = p_channel_code
      AND ch.status = 'ACTIVE';

    IF v_channel_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        ma.id AS media_id,
        md.id AS derivative_id,
        md.storage_locator,
        md.content_type,
        md.variant_code,
        md.width_px,
        md.height_px
    FROM media.media_assets ma
    JOIN media.media_derivatives md
      ON md.source_media_asset_id = ma.id
    JOIN provider.provider_profiles pr
      ON pr.id = ma.owner_provider_profile_id
    WHERE ma.id = p_media_id

      -- source/original must be active but is never returned
      AND ma.status = 'ACTIVE'

      -- exactly the canonical safe delivery derivative
      AND md.is_canonical = true
      AND md.scan_status = 'CLEAN'
      AND md.moderation_status = 'APPROVED'
      AND md.delivery_status = 'DELIVERABLE'
      AND md.effective_from <= v_at
      AND (md.effective_to IS NULL OR md.effective_to > v_at)

      -- source object can never itself be the delivery object
      AND md.storage_locator <> ma.storage_path

      -- rights must currently permit use
      AND EXISTS (
          SELECT 1
          FROM media.media_rights mr
          WHERE mr.media_asset_id = ma.id
            AND mr.status = 'ACTIVE'
            AND mr.effective_from <= v_at
            AND (mr.effective_to IS NULL OR mr.effective_to > v_at)
      )

      -- provider must currently be public-eligible
      AND pr.status = 'ACTIVE'

      -- Public eligibility must come from a DIRECT publication link.
      AND EXISTS (
          SELECT 1
          FROM media.media_links ml
          JOIN listing.channel_publications cp
            ON cp.id = ml.channel_publication_id
          JOIN listing.channels ch
            ON ch.id = cp.channel_id
          WHERE ml.media_asset_id = ma.id

            AND ml.link_role = 'PUBLIC_LISTING'
            AND ml.link_status = 'ACTIVE'
            AND ml.channel_publication_id IS NOT NULL
            AND ml.effective_from <= v_at
            AND (ml.effective_to IS NULL OR ml.effective_to > v_at)

            AND cp.provider_profile_id = ma.owner_provider_profile_id
            AND cp.publication_status = 'PUBLISHED'
            AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
            AND (cp.effective_to IS NULL OR cp.effective_to > v_at)

            AND cp.channel_id = v_channel_id
            AND cp.channel_code = p_channel_code

            AND ch.id = v_channel_id
            AND ch.code = p_channel_code
            AND ch.status = 'ACTIVE'
      )

    LIMIT 1;
END;
$function$;

ALTER FUNCTION media.read_public_media_delivery(uuid, text)
    OWNER TO vind_db_owner;

REVOKE ALL
    ON FUNCTION media.read_public_media_delivery(uuid, text)
    FROM PUBLIC;

REVOKE ALL
    ON FUNCTION media.read_public_media_delivery(uuid, text)
    FROM vind_importer;

GRANT EXECUTE
    ON FUNCTION media.read_public_media_delivery(uuid, text)
    TO vind_app_runtime;