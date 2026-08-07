\set ON_ERROR_STOP on

-- DB-DEC-021-A01 structural verifier.
-- Read-only verification: no schema/data mutation.

SET search_path = pg_catalog;

DO $block$
DECLARE
    v_failures integer := 0;
    v_count integer;
    v_text text;
BEGIN
    -- -----------------------------------------------------
    -- scoped_assignments PERSON shape
    -- -----------------------------------------------------

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'access'
          AND table_name = 'scoped_assignments'
          AND column_name = 'person_id'
          AND is_nullable = 'YES'
          AND udt_name = 'uuid'
    ) THEN
        RAISE WARNING 'A01: access.scoped_assignments.person_id missing or invalid';
        v_failures := v_failures + 1;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'access'
          AND table_name = 'scoped_assignments'
          AND column_name IN ('membership_id', 'organization_id')
          AND is_nullable <> 'YES'
    ) THEN
        RAISE WARNING 'A01: membership_id / organization_id must be nullable for PERSON scope';
        v_failures := v_failures + 1;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_class rt ON rt.oid = c.confrelid
        JOIN pg_namespace rn ON rn.oid = rt.relnamespace
        WHERE n.nspname = 'access'
          AND t.relname = 'scoped_assignments'
          AND c.contype = 'f'
          AND c.conname = 'scoped_assignments_person_fk'
          AND rn.nspname = 'party'
          AND rt.relname = 'persons'
    ) THEN
        RAISE WARNING 'A01: scoped_assignments.person_id FK to party.persons missing';
        v_failures := v_failures + 1;
    END IF;

    SELECT pg_get_constraintdef(c.oid)
    INTO v_text
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'access'
      AND t.relname = 'scoped_assignments'
      AND c.conname = 'scoped_assignments_scope_valid';

    IF v_text IS NULL
       OR v_text NOT ILIKE '%PERSON%'
       OR v_text NOT ILIKE '%ORGANIZATION%'
       OR v_text NOT ILIKE '%WORKSPACE%'
       OR v_text NOT ILIKE '%person_id IS NOT NULL%'
       OR v_text NOT ILIKE '%membership_id IS NULL%' THEN
        RAISE WARNING 'A01: exact PERSON/ORGANIZATION/WORKSPACE scope constraint missing';
        v_failures := v_failures + 1;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'access'
          AND t.relname = 'scoped_assignments'
          AND c.contype = 'x'
          AND c.conname = 'scoped_assignments_person_no_overlap'
    ) THEN
        RAISE WARNING 'A01: PERSON active-period exclusion constraint missing';
        v_failures := v_failures + 1;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'access'
          AND tablename = 'scoped_assignments'
          AND indexname = 'scoped_assignments_person_idx'
    ) THEN
        RAISE WARNING 'A01: PERSON scoped-assignment index missing';
        v_failures := v_failures + 1;
    END IF;

    -- Existing ORGANIZATION / WORKSPACE protections must remain.
    SELECT count(*)
    INTO v_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'access'
      AND t.relname = 'scoped_assignments'
      AND c.conname IN (
          'scoped_assignments_org_no_overlap',
          'scoped_assignments_workspace_no_overlap'
      );

    IF v_count <> 2 THEN
        RAISE WARNING 'A01: existing ORGANIZATION/WORKSPACE overlap protections changed';
        v_failures := v_failures + 1;
    END IF;

    -- -----------------------------------------------------
    -- validator + capability resolver
    -- -----------------------------------------------------

    IF to_regprocedure(
        'access.validate_scoped_assignment()'
    ) IS NULL THEN
        RAISE WARNING 'A01: revised scoped-assignment validator missing';
        v_failures := v_failures + 1;
    END IF;

    IF to_regprocedure(
        'access.current_actor_has_capability_for_scope(text,text,uuid,uuid,uuid)'
    ) IS NULL THEN
        RAISE WARNING 'A01: canonical scoped capability resolver missing';
        v_failures := v_failures + 1;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(
                p.proacl,
                acldefault('f', p.proowner)
            )
        ) acl
        WHERE n.nspname = 'access'
          AND p.proname = 'current_actor_has_capability_for_scope'
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
    ) THEN
        RAISE WARNING 'A01: capability resolver is executable by PUBLIC';
        v_failures := v_failures + 1;
    END IF;

    -- -----------------------------------------------------
    -- locked capabilities
    -- -----------------------------------------------------

    SELECT count(*)
    INTO v_count
    FROM access.capabilities
    WHERE (code, domain_code, action_code, is_sensitive, is_active) IN (
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
    );

    IF v_count <> 4 THEN
        RAISE WARNING 'A01: locked sensitive capability definitions are incomplete or divergent';
        v_failures := v_failures + 1;
    END IF;

    SELECT count(*)
    INTO v_count
    FROM access.roles
    WHERE code IN ('MODERATOR', 'OPERATIONS_ADMIN')
      AND is_active = true;

    IF v_count <> 2 THEN
        RAISE WARNING 'A01: MODERATOR and OPERATIONS_ADMIN must exist and be active';
        v_failures := v_failures + 1;
    END IF;

    SELECT count(*)
    INTO v_count
    FROM access.role_capabilities
    WHERE (role_code, capability_code, effect) IN (
        ('OWNER', 'provider.status.transition', 'ALLOW'),
        ('OWNER', 'provider.management_authority.manage', 'ALLOW'),
        ('OWNER', 'listing.publication.transition', 'ALLOW'),
        ('ADMIN', 'provider.status.transition', 'ALLOW'),
        ('ADMIN', 'listing.publication.transition', 'ALLOW'),
        ('CONTENT_MANAGER', 'listing.publication.transition', 'ALLOW'),
        ('MODERATOR', 'verification.evidence.read', 'ALLOW'),
        ('OPERATIONS_ADMIN', 'verification.evidence.read', 'ALLOW'),
        ('OPERATIONS_ADMIN', 'provider.status.transition', 'ALLOW')
    );

    IF v_count <> 9 THEN
        RAISE WARNING 'A01: locked least-privilege role mappings are incomplete';
        v_failures := v_failures + 1;
    END IF;

    IF EXISTS (
        SELECT 1
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
              OR
              (rc.role_code = 'MODERATOR'
               AND rc.capability_code = 'verification.evidence.read'
               AND rc.effect = 'ALLOW')
              OR
              (rc.role_code = 'OPERATIONS_ADMIN'
               AND rc.capability_code IN (
                   'verification.evidence.read',
                   'provider.status.transition'
               )
               AND rc.effect = 'ALLOW')
          )
    ) THEN
        RAISE WARNING 'A01: forbidden sensitive capability mapping exists';
        v_failures := v_failures + 1;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.role_capabilities
        WHERE role_code IN ('OWNER', 'ADMIN')
          AND capability_code = 'verification.evidence.read'
    ) THEN
        RAISE WARNING 'A01: OWNER/ADMIN must not receive verification.evidence.read';
        v_failures := v_failures + 1;
    END IF;

    -- -----------------------------------------------------
    -- RLS
    -- -----------------------------------------------------

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'access'
          AND c.relname = 'scoped_assignments'
          AND c.relrowsecurity = true
    ) THEN
        RAISE WARNING 'A01: RLS is not enabled on access.scoped_assignments';
        v_failures := v_failures + 1;
    END IF;

    SELECT qual
    INTO v_text
    FROM pg_policies
    WHERE schemaname = 'access'
      AND tablename = 'scoped_assignments'
      AND policyname = 'scoped_assignments_runtime_select';

    IF v_text IS NULL
       OR v_text NOT ILIKE '%PERSON%'
       OR v_text NOT ILIKE '%current_actor_person_id%'
       OR v_text NOT ILIKE '%current_organization_id%' THEN
        RAISE WARNING 'A01: runtime SELECT policy lacks PERSON self-scope and organization regression path';
        v_failures := v_failures + 1;
    END IF;

    SELECT qual
    INTO v_text
    FROM pg_policies
    WHERE schemaname = 'access'
      AND tablename = 'scoped_assignments'
      AND policyname = 'scoped_assignments_runtime_write';

    IF v_text IS NULL
       OR v_text ILIKE '%current_actor_person_id%'
       OR v_text NOT ILIKE '%current_organization_id%' THEN
        RAISE WARNING 'A01: runtime write policy must preserve organization/workspace behavior without direct PERSON self-assignment';
        v_failures := v_failures + 1;
    END IF;

    -- -----------------------------------------------------
    -- no unexpected Access tables
    -- -----------------------------------------------------

    SELECT count(*)
    INTO v_count
    FROM information_schema.tables
    WHERE table_schema = 'access'
      AND table_type = 'BASE TABLE';

    IF v_count <> 6 THEN
        RAISE WARNING 'A01: unexpected Access table count; expected existing 6 tables, found %', v_count;
        v_failures := v_failures + 1;
    END IF;

    IF v_failures > 0 THEN
        RAISE EXCEPTION
            'DB-DEC-021-A01 structural verification FAILED with % issue(s)',
            v_failures
            USING ERRCODE = 'P0001';
    END IF;

    RAISE NOTICE 'DB-DEC-021-A01 structural verification PASS';
END;
$block$;
