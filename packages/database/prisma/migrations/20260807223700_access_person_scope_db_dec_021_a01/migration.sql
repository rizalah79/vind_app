-- DB-DEC-021-A01 Access Dependency
-- Additive SQL-first migration.
-- Do not add BEGIN or COMMIT: transaction is managed by the custom migration runner.
--
-- Scope:
--   - PERSON scope support in access.scoped_assignments
--   - locked sensitive capabilities + least-privilege mappings
--   - PERSON self-scope read/authorization support
--   - preserve ORGANIZATION / WORKSPACE behavior
--
-- Historical migrations are immutable and must not be edited.

SET search_path = pg_catalog;

-- =========================================================
-- access.scoped_assignments: PERSON scope
-- =========================================================

ALTER TABLE access.scoped_assignments
    ADD COLUMN person_id uuid;

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_person_fk
    FOREIGN KEY (person_id)
    REFERENCES party.persons(id)
    ON DELETE RESTRICT;

-- PERSON scope intentionally has no organization membership.
ALTER TABLE access.scoped_assignments
    ALTER COLUMN membership_id DROP NOT NULL;

ALTER TABLE access.scoped_assignments
    ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE access.scoped_assignments
    DROP CONSTRAINT scoped_assignments_scope_valid;

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_scope_valid
    CHECK (
        (
            scope_type = 'PERSON'
            AND person_id IS NOT NULL
            AND membership_id IS NULL
            AND organization_id IS NULL
            AND workspace_id IS NULL
        )
        OR
        (
            scope_type = 'ORGANIZATION'
            AND person_id IS NULL
            AND membership_id IS NOT NULL
            AND organization_id IS NOT NULL
            AND workspace_id IS NULL
        )
        OR
        (
            scope_type = 'WORKSPACE'
            AND person_id IS NULL
            AND membership_id IS NOT NULL
            AND organization_id IS NOT NULL
            AND workspace_id IS NOT NULL
        )
    );

CREATE INDEX scoped_assignments_person_idx
    ON access.scoped_assignments(person_id, status)
    WHERE person_id IS NOT NULL;

ALTER TABLE access.scoped_assignments
    ADD CONSTRAINT scoped_assignments_person_no_overlap
    EXCLUDE USING gist (
        person_id WITH =,
        role_code WITH =,
        tstzrange(
            effective_from,
            COALESCE(
                effective_to,
                'infinity'::timestamptz
            ),
            '[)'
        ) WITH &&
    )
    WHERE (
        status = 'ACTIVE'
        AND scope_type = 'PERSON'
    );

-- =========================================================
-- Revised cross-table scope validation
-- =========================================================

CREATE OR REPLACE FUNCTION access.validate_scoped_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, access, organization
SET row_security = off
AS $function$
DECLARE
    v_membership_organization_id uuid;
    v_workspace_organization_id uuid;
BEGIN
    -- Exact nullability/XOR shape is enforced by
    -- scoped_assignments_scope_valid. PERSON has no
    -- organization membership to validate.
    IF NEW.scope_type = 'PERSON' THEN
        RETURN NEW;
    END IF;

    IF NEW.scope_type IN ('ORGANIZATION', 'WORKSPACE')
       AND (
           NEW.membership_id IS NULL
           OR NEW.organization_id IS NULL
       ) THEN
        RAISE EXCEPTION
            'Organization/workspace assignment requires membership and organization'
            USING ERRCODE = '23514';
    END IF;

    SELECT organization_id
    INTO v_membership_organization_id
    FROM access.memberships
    WHERE id = NEW.membership_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membership does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF v_membership_organization_id <> NEW.organization_id THEN
        RAISE EXCEPTION
            'Assignment organization differs from membership organization'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.scope_type = 'WORKSPACE' THEN
        SELECT organization_id
        INTO v_workspace_organization_id
        FROM organization.workspaces
        WHERE id = NEW.workspace_id;

        IF NOT FOUND
           OR v_workspace_organization_id <> NEW.organization_id THEN
            RAISE EXCEPTION
                'Assignment workspace does not belong to organization'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION access.validate_scoped_assignment()
FROM PUBLIC;

DROP TRIGGER scoped_assignments_validate_scope
ON access.scoped_assignments;

CREATE TRIGGER scoped_assignments_validate_scope
BEFORE INSERT OR UPDATE OF
    membership_id,
    person_id,
    organization_id,
    workspace_id,
    scope_type
ON access.scoped_assignments
FOR EACH ROW
EXECUTE FUNCTION access.validate_scoped_assignment();

-- =========================================================
-- Locked sensitive Access capabilities
-- =========================================================

DO $block$
DECLARE
    v_conflict text;
BEGIN
    -- Fail closed if a locked code already exists with
    -- conflicting semantics. Do not silently overwrite it.
    SELECT c.code
    INTO v_conflict
    FROM access.capabilities c
    JOIN (
        VALUES
            (
                'provider.status.transition',
                'provider',
                'status_transition',
                true
            ),
            (
                'provider.management_authority.manage',
                'provider',
                'management_authority_manage',
                true
            ),
            (
                'listing.publication.transition',
                'listing',
                'publication_transition',
                true
            ),
            (
                'verification.evidence.read',
                'verification',
                'evidence_read',
                true
            )
    ) AS expected(
        code,
        domain_code,
        action_code,
        is_sensitive
    )
      ON expected.code = c.code
    WHERE c.domain_code <> expected.domain_code
       OR c.action_code <> expected.action_code
       OR c.is_sensitive IS DISTINCT FROM expected.is_sensitive
       OR c.is_active IS DISTINCT FROM true
    LIMIT 1;

    IF v_conflict IS NOT NULL THEN
        RAISE EXCEPTION
            'Locked Access capability conflicts with existing definition: %',
            v_conflict
            USING ERRCODE = '23514';
    END IF;
END;
$block$;

INSERT INTO access.capabilities (
    code,
    domain_code,
    action_code,
    description,
    is_sensitive,
    is_active
)
VALUES
    (
        'provider.status.transition',
        'provider',
        'status_transition',
        'Transition provider status through an authorized provider command',
        true,
        true
    ),
    (
        'provider.management_authority.manage',
        'provider',
        'management_authority_manage',
        'Manage provider management-authority state through an authorized command',
        true,
        true
    ),
    (
        'listing.publication.transition',
        'listing',
        'publication_transition',
        'Transition channel publication state through an authorized command',
        true,
        true
    ),
    (
        'verification.evidence.read',
        'verification',
        'evidence_read',
        'Read restricted verification evidence through an authorized audited path',
        true,
        true
    )
ON CONFLICT (code) DO NOTHING;

-- Locked provider-facing least-privilege mappings.
--
-- OWNER:
--   provider.status.transition
--   provider.management_authority.manage
--   listing.publication.transition
--
-- ADMIN:
--   provider.status.transition
--   listing.publication.transition
--
-- CONTENT_MANAGER:
--   listing.publication.transition
--
-- No provider-facing role receives verification.evidence.read
-- in DB-DEC-021-A01.
INSERT INTO access.role_capabilities (
    role_code,
    capability_code,
    effect
)
VALUES
    (
        'OWNER',
        'provider.status.transition',
        'ALLOW'
    ),
    (
        'OWNER',
        'provider.management_authority.manage',
        'ALLOW'
    ),
    (
        'OWNER',
        'listing.publication.transition',
        'ALLOW'
    ),
    (
        'ADMIN',
        'provider.status.transition',
        'ALLOW'
    ),
    (
        'ADMIN',
        'listing.publication.transition',
        'ALLOW'
    ),
    (
        'CONTENT_MANAGER',
        'listing.publication.transition',
        'ALLOW'
    )
ON CONFLICT (role_code, capability_code) DO NOTHING;

DO $block$
DECLARE
    v_invalid_mapping text;
BEGIN
    -- Every expected mapping must exist and be ALLOW.
    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('OWNER', 'provider.status.transition'),
                ('OWNER', 'provider.management_authority.manage'),
                ('OWNER', 'listing.publication.transition'),
                ('ADMIN', 'provider.status.transition'),
                ('ADMIN', 'listing.publication.transition'),
                ('CONTENT_MANAGER', 'listing.publication.transition')
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

    -- The five provider-facing baseline roles may not receive
    -- additional mappings for the four locked sensitive
    -- capabilities.
    SELECT
        rc.role_code || ':' || rc.capability_code || ':' || rc.effect
    INTO v_invalid_mapping
    FROM access.role_capabilities rc
    WHERE rc.role_code IN (
        'OWNER',
        'ADMIN',
        'CONTENT_MANAGER',
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
          (rc.role_code = 'OWNER'
           AND rc.capability_code IN (
               'provider.status.transition',
               'provider.management_authority.manage',
               'listing.publication.transition'
           )
           AND rc.effect = 'ALLOW')
          OR
          (rc.role_code = 'ADMIN'
           AND rc.capability_code IN (
               'provider.status.transition',
               'listing.publication.transition'
           )
           AND rc.effect = 'ALLOW')
          OR
          (rc.role_code = 'CONTENT_MANAGER'
           AND rc.capability_code = 'listing.publication.transition'
           AND rc.effect = 'ALLOW')
      )
    LIMIT 1;

    IF v_invalid_mapping IS NOT NULL THEN
        RAISE EXCEPTION
            'Forbidden DB-DEC-021-A01 provider-facing capability mapping exists: %',
            v_invalid_mapping
            USING ERRCODE = '23514';
    END IF;
END;
$block$;

-- =========================================================
-- Canonical scoped capability resolver
-- =========================================================

CREATE OR REPLACE FUNCTION access.current_actor_has_capability_for_scope(
    p_capability_code text,
    p_scope_type text,
    p_person_id uuid,
    p_organization_id uuid,
    p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, access, security
SET row_security = off
AS $function$
    WITH target_shape AS (
        SELECT
            CASE
                WHEN p_scope_type = 'PERSON' THEN
                    p_person_id IS NOT NULL
                    AND p_organization_id IS NULL
                    AND p_workspace_id IS NULL
                WHEN p_scope_type = 'ORGANIZATION' THEN
                    p_person_id IS NULL
                    AND p_organization_id IS NOT NULL
                    AND p_workspace_id IS NULL
                WHEN p_scope_type = 'WORKSPACE' THEN
                    p_person_id IS NULL
                    AND p_organization_id IS NOT NULL
                    AND p_workspace_id IS NOT NULL
                ELSE false
            END AS valid
    ),
    actor AS (
        SELECT security.current_actor_person_id() AS person_id
    ),
    matching_assignments AS (
        SELECT sa.role_code
        FROM access.scoped_assignments sa
        CROSS JOIN actor a
        LEFT JOIN access.memberships m
          ON m.id = sa.membership_id
        WHERE a.person_id IS NOT NULL
          AND sa.status = 'ACTIVE'
          AND sa.effective_from <= statement_timestamp()
          AND (
              sa.effective_to IS NULL
              OR sa.effective_to > statement_timestamp()
          )
          AND (
              (
                  p_scope_type = 'PERSON'
                  AND sa.scope_type = 'PERSON'
                  AND sa.person_id = p_person_id
                  AND sa.person_id = a.person_id
              )
              OR
              (
                  p_scope_type = 'ORGANIZATION'
                  AND sa.scope_type = 'ORGANIZATION'
                  AND sa.organization_id = p_organization_id
                  AND m.person_id = a.person_id
                  AND m.status = 'ACTIVE'
                  AND m.effective_from <= statement_timestamp()
                  AND (
                      m.effective_to IS NULL
                      OR m.effective_to > statement_timestamp()
                  )
              )
              OR
              (
                  p_scope_type = 'WORKSPACE'
                  AND sa.scope_type = 'WORKSPACE'
                  AND sa.organization_id = p_organization_id
                  AND sa.workspace_id = p_workspace_id
                  AND m.person_id = a.person_id
                  AND m.status = 'ACTIVE'
                  AND m.effective_from <= statement_timestamp()
                  AND (
                      m.effective_to IS NULL
                      OR m.effective_to > statement_timestamp()
                  )
              )
          )
    ),
    effects AS (
        SELECT rc.effect
        FROM matching_assignments ma
        JOIN access.roles r
          ON r.code = ma.role_code
         AND r.is_active = true
        JOIN access.role_capabilities rc
          ON rc.role_code = ma.role_code
         AND rc.capability_code = p_capability_code
        JOIN access.capabilities c
          ON c.code = rc.capability_code
         AND c.is_active = true
    )
    SELECT
        CASE
            WHEN NOT (SELECT valid FROM target_shape) THEN false
            WHEN EXISTS (
                SELECT 1 FROM effects WHERE effect = 'DENY'
            ) THEN false
            ELSE EXISTS (
                SELECT 1 FROM effects WHERE effect = 'ALLOW'
            )
        END;
$function$;

REVOKE ALL ON FUNCTION
    access.current_actor_has_capability_for_scope(
        text,
        text,
        uuid,
        uuid,
        uuid
    )
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    access.current_actor_has_capability_for_scope(
        text,
        text,
        uuid,
        uuid,
        uuid
    )
TO vind_app_runtime, vind_importer;

-- =========================================================
-- PERSON self-scope RLS support
-- =========================================================

DROP POLICY scoped_assignments_runtime_select
ON access.scoped_assignments;

CREATE POLICY scoped_assignments_runtime_select
ON access.scoped_assignments
FOR SELECT
TO vind_app_runtime
USING (
    (
        scope_type = 'PERSON'
        AND person_id = security.current_actor_person_id()
    )
    OR
    (
        scope_type IN ('ORGANIZATION', 'WORKSPACE')
        AND organization_id = security.current_organization_id()
    )
);

-- Preserve existing organization/workspace write behavior.
-- PERSON self-scope is readable/authorizable by the person,
-- but direct self-assignment is intentionally not permitted.
DROP POLICY scoped_assignments_runtime_write
ON access.scoped_assignments;

CREATE POLICY scoped_assignments_runtime_write
ON access.scoped_assignments
FOR ALL
TO vind_app_runtime
USING (
    scope_type IN ('ORGANIZATION', 'WORKSPACE')
    AND organization_id = security.current_organization_id()
)
WITH CHECK (
    scope_type IN ('ORGANIZATION', 'WORKSPACE')
    AND organization_id = security.current_organization_id()
);
