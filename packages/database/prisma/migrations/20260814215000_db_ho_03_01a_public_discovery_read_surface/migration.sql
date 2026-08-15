-- DB-HO-03-01A — Public Discovery / Read Access Contract
-- Public reads through constrained SECURITY DEFINER functions.
-- Base-table RLS remains unchanged and fail-closed.
-- No broad public SELECT is introduced.

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';

-- ============================================================================
-- 1. Public Listing Collection Function
-- ============================================================================

CREATE OR REPLACE FUNCTION listing.read_public_listings(
    p_channel_code text,
    p_provider_id uuid DEFAULT NULL,
    p_before_created_at timestamptz DEFAULT NULL,
    p_before_publication_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 10
)
RETURNS TABLE (
    publication_id uuid,
    provider_id uuid,
    offering_id uuid,
    package_id uuid,
    channel_code text,
    publication_status text,
    title text,
    description text,
    effective_from timestamptz,
    created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
DECLARE
    v_at timestamptz := statement_timestamp();
    v_channel_id uuid;
BEGIN
    IF p_channel_code IS NULL OR btrim(p_channel_code) = '' THEN
        RAISE EXCEPTION 'Canonical channel code is required.' USING ERRCODE = '22023';
    END IF;

    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
        RAISE EXCEPTION 'Public listing limit must be between 1 and 50.' USING ERRCODE = '22023';
    END IF;

    IF (p_before_created_at IS NOT NULL AND p_before_publication_id IS NULL)
       OR (p_before_created_at IS NULL AND p_before_publication_id IS NOT NULL)
    THEN
        RAISE EXCEPTION 'Cursor parameters must be both null or both non-null.' USING ERRCODE = '22023';
    END IF;

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
        cp.id AS publication_id,
        cp.provider_profile_id AS provider_id,
        cp.offering_id,
        cp.package_id,
        cp.channel_code,
        cp.publication_status,
        COALESCE(o.title, pkg.title) AS title,
        o.description,
        cp.effective_from,
        cp.created_at
    FROM listing.channel_publications cp
    JOIN provider.provider_profiles pr
      ON pr.id = cp.provider_profile_id
    JOIN listing.channels ch
      ON ch.id = cp.channel_id
    LEFT JOIN catalog.offerings o
      ON o.id = cp.offering_id
    LEFT JOIN catalog.packages pkg
      ON pkg.id = cp.package_id
    WHERE cp.channel_id = v_channel_id
      AND cp.channel_code = p_channel_code
      AND ch.id = v_channel_id
      AND ch.code = p_channel_code
      AND ch.status = 'ACTIVE'
      AND cp.publication_status = 'PUBLISHED'
      AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
      AND (cp.effective_to IS NULL OR cp.effective_to > v_at)
      AND pr.status = 'ACTIVE'
      AND (p_provider_id IS NULL OR cp.provider_profile_id = p_provider_id)
      AND (
          p_before_created_at IS NULL
          OR cp.created_at < p_before_created_at
          OR (cp.created_at = p_before_created_at AND cp.id < p_before_publication_id)
      )
    ORDER BY
        cp.created_at DESC,
        cp.id DESC
    LIMIT p_limit + 1;
END;
$function$;

-- ============================================================================
-- 2. Public Listing Detail Function
-- ============================================================================

CREATE OR REPLACE FUNCTION listing.read_public_listing(
    p_publication_id uuid,
    p_channel_code text
)
RETURNS TABLE (
    publication_id uuid,
    provider_id uuid,
    provider_display_name text,
    provider_type text,

    offering_id uuid,
    offering_code text,
    offering_title text,
    offering_description text,

    package_id uuid,
    package_code text,
    package_title text,
    package_anchor_offering_id uuid,

    channel_code text,
    publication_status text,
    effective_from timestamptz,
    created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
DECLARE
    v_at timestamptz := statement_timestamp();
    v_channel_id uuid;
BEGIN
    IF p_publication_id IS NULL THEN
        RETURN;
    END IF;

    IF p_channel_code IS NULL OR btrim(p_channel_code) = '' THEN
        RETURN;
    END IF;

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
        cp.id AS publication_id,
        cp.provider_profile_id AS provider_id,
        pr.display_name AS provider_display_name,
        pr.provider_type,

        cp.offering_id,
        o.offering_code,
        o.title AS offering_title,
        o.description AS offering_description,

        cp.package_id,
        pkg.package_code,
        pkg.title AS package_title,
        pkg.anchor_offering_id AS package_anchor_offering_id,

        cp.channel_code,
        cp.publication_status,
        cp.effective_from,
        cp.created_at
    FROM listing.channel_publications cp
    JOIN provider.provider_profiles pr
      ON pr.id = cp.provider_profile_id
    JOIN listing.channels ch
      ON ch.id = cp.channel_id
    LEFT JOIN catalog.offerings o
      ON o.id = cp.offering_id
    LEFT JOIN catalog.packages pkg
      ON pkg.id = cp.package_id
    WHERE cp.id = p_publication_id
      AND cp.channel_id = v_channel_id
      AND cp.channel_code = p_channel_code
      AND ch.id = v_channel_id
      AND ch.code = p_channel_code
      AND ch.status = 'ACTIVE'
      AND cp.publication_status = 'PUBLISHED'
      AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
      AND (cp.effective_to IS NULL OR cp.effective_to > v_at)
      AND pr.status = 'ACTIVE';
END;
$function$;

-- ============================================================================
-- 3. Public Provider Function (LOCKED OPTION 2)
-- ============================================================================

CREATE OR REPLACE FUNCTION provider.read_public_provider(
    p_provider_id uuid,
    p_channel_code text
)
RETURNS TABLE (
    provider_id uuid,
    display_name text,
    provider_type text,
    status text,
    created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
DECLARE
    v_at timestamptz := statement_timestamp();
    v_channel_id uuid;
BEGIN
    IF p_provider_id IS NULL THEN
        RETURN;
    END IF;

    IF p_channel_code IS NULL OR btrim(p_channel_code) = '' THEN
        RETURN;
    END IF;

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
        pr.id AS provider_id,
        pr.display_name,
        pr.provider_type,
        pr.status,
        pr.created_at
    FROM provider.provider_profiles pr
    WHERE pr.id = p_provider_id
      AND pr.status = 'ACTIVE'
      AND EXISTS (
          SELECT 1
          FROM listing.channel_publications cp
          JOIN listing.channels ch
            ON ch.id = cp.channel_id
          WHERE cp.provider_profile_id = pr.id
            AND cp.channel_id = v_channel_id
            AND cp.channel_code = p_channel_code
            AND cp.publication_status = 'PUBLISHED'
            AND ch.id = v_channel_id
            AND ch.code = p_channel_code
            AND ch.status = 'ACTIVE'
            AND (cp.effective_from IS NULL OR cp.effective_from <= v_at)
            AND (cp.effective_to IS NULL OR cp.effective_to > v_at)
      );
END;
$function$;

-- ============================================================================
-- 4. Function Ownership
-- ============================================================================

ALTER FUNCTION listing.read_public_listings(text, uuid, timestamptz, uuid, integer) OWNER TO vind_db_owner;
ALTER FUNCTION listing.read_public_listing(uuid, text) OWNER TO vind_db_owner;
ALTER FUNCTION provider.read_public_provider(uuid, text) OWNER TO vind_db_owner;

-- ============================================================================
-- 5. Function ACL
-- ============================================================================

REVOKE ALL ON FUNCTION listing.read_public_listings(text, uuid, timestamptz, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION listing.read_public_listings(text, uuid, timestamptz, uuid, integer) FROM vind_importer;
GRANT EXECUTE ON FUNCTION listing.read_public_listings(text, uuid, timestamptz, uuid, integer) TO vind_app_runtime;

REVOKE ALL ON FUNCTION listing.read_public_listing(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION listing.read_public_listing(uuid, text) FROM vind_importer;
GRANT EXECUTE ON FUNCTION listing.read_public_listing(uuid, text) TO vind_app_runtime;

REVOKE ALL ON FUNCTION provider.read_public_provider(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION provider.read_public_provider(uuid, text) FROM vind_importer;
GRANT EXECUTE ON FUNCTION provider.read_public_provider(uuid, text) TO vind_app_runtime;

-- ============================================================================
-- 6. Public Discovery Indexes
-- ============================================================================

CREATE INDEX channel_publications_public_channel_page_idx
ON listing.channel_publications (
    channel_id,
    created_at DESC,
    id DESC
)
WHERE publication_status = 'PUBLISHED';

CREATE INDEX channel_publications_public_provider_channel_page_idx
ON listing.channel_publications (
    provider_profile_id,
    channel_id,
    created_at DESC,
    id DESC
)
WHERE publication_status = 'PUBLISHED';
