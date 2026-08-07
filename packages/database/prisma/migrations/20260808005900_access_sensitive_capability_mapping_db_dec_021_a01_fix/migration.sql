-- DB-DEC-021-A01 corrective authorization mapping.
-- Additive forward-fix migration. Historical baseline migrations and the
-- already-applied original A01 migration remain immutable.
--
-- Control Tower locked mapping:
--   OWNER: provider.status.transition,
--          provider.management_authority.manage,
--          listing.publication.transition
--   ADMIN: provider.status.transition,
--          listing.publication.transition
--   CONTENT_MANAGER: listing.publication.transition
--   MODERATOR: verification.evidence.read
--   OPERATIONS_ADMIN: verification.evidence.read,
--                     provider.status.transition
--   OPERATIONS_STAFF: none of these four sensitive capabilities
--   ACCOUNTING: none of these four sensitive capabilities
--
-- OWNER and ADMIN MUST NOT receive verification.evidence.read.
-- Absence of ALLOW is the denial model; this migration does not create DENY rows.
--
-- MODERATOR and OPERATIONS_ADMIN are shared-admin/internal operational roles.
-- When absent, they are created with existing role_scope = SYSTEM. If either
-- role already exists, its existing non-authorization metadata is preserved.

SET search_path = pg_catalog;

-- =========================================================
-- Dependency and capability-definition validation
-- =========================================================

DO $block$
DECLARE
    v_conflict text;
BEGIN
    IF to_regprocedure(
        'access.current_actor_has_capability_for_scope(text,text,uuid,uuid,uuid)'
    ) IS NULL THEN
        RAISE EXCEPTION
            'DB-DEC-021-A01 dependency missing: scoped capability resolver'
            USING ERRCODE = '55000';
    END IF;

    SELECT expected.code
    INTO v_conflict
    FROM (
        VALUES
            (
                'provider.status.transition',
                'provider',
                'status_transition',
                true,
                true
            ),
            (
                'provider.management_authority.manage',
                'provider',
                'management_authority_manage',
                true,
                true
            ),
            (
                'listing.publication.transition',
                'listing',
                'publication_transition',
                true,
                true
            ),
            (
                'verification.evidence.read',
                'verification',
                'evidence_read',
                true,
                true
            )
    ) AS expected(
        code,
        domain_code,
        action_code,
        is_sensitive,
        is_active
    )
    LEFT JOIN access.capabilities c
      ON c.code = expected.code
    WHERE c.code IS NULL
       OR c.domain_code <> expected.domain_code
       OR c.action_code <> expected.action_code
       OR c.is_sensitive IS DISTINCT FROM expected.is_sensitive
       OR c.is_active IS DISTINCT FROM expected.is_active
    LIMIT 1;

    IF v_conflict IS NOT NULL THEN
        RAISE EXCEPTION
            'Locked A01 capability definition missing or divergent: %',
            v_conflict
            USING ERRCODE = '23514';
    END IF;
END;
$block$;

-- =========================================================
-- Add internal roles only when absent
-- =========================================================

INSERT INTO access.roles (
    code,
    display_name,
    description,
    role_scope,
    is_system,
    is_active
)
VALUES
    (
        'MODERATOR',
        'Moderator',
        'Shared Admin moderator for restricted verification and moderation workflows',
        'SYSTEM',
        true,
        true
    ),
    (
        'OPERATIONS_ADMIN',
        'Operations Admin',
        'Shared operations administrator for sensitive operational workflows',
        'SYSTEM',
        true,
        true
    )
ON CONFLICT (code) DO NOTHING;

DO $block$
DECLARE
    v_invalid_role text;
BEGIN
    SELECT r.code
    INTO v_invalid_role
    FROM access.roles r
    WHERE r.code IN ('MODERATOR', 'OPERATIONS_ADMIN')
      AND r.is_active IS DISTINCT FROM true
    LIMIT 1;

    IF v_invalid_role IS NOT NULL THEN
        RAISE EXCEPTION
            'Locked A01 internal role exists but is inactive: %',
            v_invalid_role
            USING ERRCODE = '23514';
    END IF;

    IF (
        SELECT count(*)
        FROM access.roles
        WHERE code IN ('MODERATOR', 'OPERATIONS_ADMIN')
    ) <> 2 THEN
        RAISE EXCEPTION
            'MODERATOR and OPERATIONS_ADMIN roles are required for locked A01 mapping'
            USING ERRCODE = '23514';
    END IF;
END;
$block$;

-- =========================================================
-- Corrective locked role-capability mappings
-- =========================================================

INSERT INTO access.role_capabilities (
    role_code,
    capability_code,
    effect
)
VALUES
    (
        'MODERATOR',
        'verification.evidence.read',
        'ALLOW'
    ),
    (
        'OPERATIONS_ADMIN',
        'verification.evidence.read',
        'ALLOW'
    ),
    (
        'OPERATIONS_ADMIN',
        'provider.status.transition',
        'ALLOW'
    )
ON CONFLICT (role_code, capability_code) DO NOTHING;

DO $block$
DECLARE
    v_invalid_mapping text;
BEGIN
    -- All nine exact ALLOW mappings across the four locked capabilities
    -- must be present after this forward-fix.
    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('OWNER', 'provider.status.transition'),
                ('OWNER', 'provider.management_authority.manage'),
                ('OWNER', 'listing.publication.transition'),
                ('ADMIN', 'provider.status.transition'),
                ('ADMIN', 'listing.publication.transition'),
                ('CONTENT_MANAGER', 'listing.publication.transition'),
                ('MODERATOR', 'verification.evidence.read'),
                ('OPERATIONS_ADMIN', 'verification.evidence.read'),
                ('OPERATIONS_ADMIN', 'provider.status.transition')
        ) AS expected(role_code, capability_code)
        LEFT JOIN access.role_capabilities rc
          ON rc.role_code = expected.role_code
         AND rc.capability_code = expected.capability_code
         AND rc.effect = 'ALLOW'
        WHERE rc.role_code IS NULL
    ) THEN
        RAISE EXCEPTION
            'One or more locked DB-DEC-021-A01 role-capability mappings are missing'
            USING ERRCODE = '23514';
    END IF;

    -- Exact mapping enforcement for the seven locked roles and four
    -- sensitive capabilities. No additional ALLOW or DENY row is valid.
    SELECT
        rc.role_code || ':' || rc.capability_code || ':' || rc.effect
    INTO v_invalid_mapping
    FROM access.role_capabilities rc
    WHERE rc.role_code IN (
        'OWNER',
        'ADMIN',
        'CONTENT_MANAGER',
        'MODERATOR',
        'OPERATIONS_ADMIN',
        'OPERATIONS_STAFF',
        'ACCOUNTING'
    )
      AND rc.capability_code IN (
        'provider.status.transition',
        'provider.management_authority.manage',
        'listing.publication.transition',
        'verification.evidence.read'
    )
      AND NOT (
          (
              rc.role_code = 'OWNER'
              AND rc.capability_code IN (
                  'provider.status.transition',
                  'provider.management_authority.manage',
                  'listing.publication.transition'
              )
              AND rc.effect = 'ALLOW'
          )
          OR
          (
              rc.role_code = 'ADMIN'
              AND rc.capability_code IN (
                  'provider.status.transition',
                  'listing.publication.transition'
              )
              AND rc.effect = 'ALLOW'
          )
          OR
          (
              rc.role_code = 'CONTENT_MANAGER'
              AND rc.capability_code = 'listing.publication.transition'
              AND rc.effect = 'ALLOW'
          )
          OR
          (
              rc.role_code = 'MODERATOR'
              AND rc.capability_code = 'verification.evidence.read'
              AND rc.effect = 'ALLOW'
          )
          OR
          (
              rc.role_code = 'OPERATIONS_ADMIN'
              AND rc.capability_code IN (
                  'verification.evidence.read',
                  'provider.status.transition'
              )
              AND rc.effect = 'ALLOW'
          )
      )
    LIMIT 1;

    IF v_invalid_mapping IS NOT NULL THEN
        RAISE EXCEPTION
            'Forbidden DB-DEC-021-A01 sensitive capability mapping exists: %',
            v_invalid_mapping
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.role_capabilities
        WHERE role_code IN ('OWNER', 'ADMIN')
          AND capability_code = 'verification.evidence.read'
    ) THEN
        RAISE EXCEPTION
            'OWNER and ADMIN must not receive verification.evidence.read'
            USING ERRCODE = '23514';
    END IF;
END;
$block$;
