\set ON_ERROR_STOP on

-- S1 Foundation & Access Closure structural verifier.

DO $verify$
DECLARE
    v_count integer;
    v_expected integer;
BEGIN
    IF current_database() <> 'vind_app_dev' THEN
        RAISE EXCEPTION 'Unexpected database: %', current_database();
    END IF;

    IF to_regclass('provider.provider_profiles') IS NOT NULL THEN
        RAISE EXCEPTION 'S2 provider table must not exist in S1';
    END IF;

    SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'access'
      AND table_name = 'scoped_assignments'
      AND column_name = 'provider_id';

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'provider_id must not exist in S1';
    END IF;

    IF to_regnamespace('configuration') IS NULL THEN
        RAISE EXCEPTION 'configuration schema missing';
    END IF;

    IF to_regclass('configuration.settings') IS NULL
       OR to_regclass('access.platform_assignments') IS NULL
       OR to_regclass('access.service_principal_grants') IS NULL
       OR to_regclass('privacy.consent_receipts') IS NULL
       OR to_regclass('privacy.subject_requests') IS NULL THEN
        RAISE EXCEPTION 'Required S1 table missing';
    END IF;

    SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'access'
      AND table_name = 'roles'
      AND column_name = 'authority_plane'
      AND is_nullable = 'NO';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'roles.authority_plane missing/not NOT NULL';
    END IF;

    SELECT count(*) INTO v_count
    FROM access.roles
    WHERE authority_plane = 'PLATFORM'
      AND code IN (
        'SUPER_ADMIN',
        'OPERATIONS_ADMIN',
        'MODERATOR',
        'SUPPORT_AGENT',
        'ADS_OPERATOR',
        'FINANCE_MAKER',
        'FINANCE_CHECKER',
        'SECURITY_AUDITOR',
        'REPORT_VIEWER'
      );

    IF v_count <> 9 THEN
        RAISE EXCEPTION 'Expected nine PLATFORM roles, got %', v_count;
    END IF;

    SELECT count(*) INTO v_count
    FROM access.roles
    WHERE authority_plane = 'SAHABAT'
      AND code IN (
        'OWNER',
        'ADMIN',
        'OPERATIONS_STAFF',
        'ACCOUNTING',
        'CONTENT_MANAGER'
      );

    IF v_count <> 5 THEN
        RAISE EXCEPTION 'Expected five baseline SAHABAT roles, got %', v_count;
    END IF;

    SELECT count(*) INTO v_count
    FROM access.capabilities
    WHERE code IN (
        'provider.status.transition',
        'provider.management_authority.manage',
        'listing.publication.transition',
        'verification.evidence.read'
    )
      AND is_sensitive = true
      AND is_active = true;

    IF v_count <> 4 THEN
        RAISE EXCEPTION 'Locked sensitive capability set mismatch';
    END IF;

    SELECT count(*) INTO v_count
    FROM access.role_capabilities
    WHERE role_code IN (
        'OWNER',
        'ADMIN',
        'CONTENT_MANAGER',
        'OPERATIONS_STAFF',
        'ACCOUNTING',
        'SUPER_ADMIN',
        'OPERATIONS_ADMIN',
        'MODERATOR',
        'SUPPORT_AGENT',
        'ADS_OPERATOR',
        'FINANCE_MAKER',
        'FINANCE_CHECKER',
        'SECURITY_AUDITOR',
        'REPORT_VIEWER'
    )
      AND capability_code IN (
        'provider.status.transition',
        'provider.management_authority.manage',
        'listing.publication.transition',
        'verification.evidence.read'
      );

    IF v_count <> 9 THEN
        RAISE EXCEPTION 'Expected exactly nine locked routine mappings, got %', v_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.role_capabilities
        WHERE role_code IN ('OWNER', 'ADMIN')
          AND capability_code = 'verification.evidence.read'
    ) THEN
        RAISE EXCEPTION 'OWNER/ADMIN evidence read mapping forbidden';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.role_capabilities
        WHERE role_code = 'SUPER_ADMIN'
          AND capability_code IN (
            'provider.status.transition',
            'provider.management_authority.manage',
            'listing.publication.transition',
            'verification.evidence.read'
          )
    ) THEN
        RAISE EXCEPTION 'SUPER_ADMIN routine mapping forbidden';
    END IF;

    SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'access'
      AND table_name = 'scoped_assignments'
      AND column_name IN (
        'subject_person_id',
        'scope_person_id'
      );

    IF v_count <> 2 THEN
        RAISE EXCEPTION 'scoped_assignments S1 person columns missing';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM access.scoped_assignments
        WHERE scope_type = 'PROVIDER'
    ) THEN
        RAISE EXCEPTION 'PROVIDER assignment must remain absent in S1';
    END IF;

    SELECT count(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'access'
      AND t.relname = 'scoped_assignments'
      AND c.conname IN (
        'scoped_assignments_scope_valid',
        'scoped_assignments_person_no_overlap',
        'scoped_assignments_org_no_overlap',
        'scoped_assignments_workspace_no_overlap'
      );

    IF v_count <> 4 THEN
        RAISE EXCEPTION 'scoped assignment constraint set incomplete';
    END IF;

    SELECT count(*) INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN (
        'access',
        'privacy',
        'configuration'
    )
      AND c.relname IN (
        'scoped_assignments',
        'platform_assignments',
        'service_principal_grants',
        'consent_receipts',
        'subject_requests',
        'settings'
      )
      AND c.relrowsecurity = true;

    IF v_count <> 6 THEN
        RAISE EXCEPTION 'Required S1 RLS set incomplete: %', v_count;
    END IF;

    IF has_table_privilege(
        'vind_app_runtime',
        'access.scoped_assignments',
        'INSERT'
    )
       OR has_table_privilege(
        'vind_app_runtime',
        'access.scoped_assignments',
        'UPDATE'
    )
       OR has_table_privilege(
        'vind_app_runtime',
        'access.scoped_assignments',
        'DELETE'
    ) THEN
        RAISE EXCEPTION 'Runtime direct scoped assignment write must be denied';
    END IF;

    IF has_table_privilege(
        'vind_app_runtime',
        'access.platform_assignments',
        'INSERT'
    )
       OR has_table_privilege(
        'vind_app_runtime',
        'access.platform_assignments',
        'UPDATE'
    )
       OR has_table_privilege(
        'vind_app_runtime',
        'access.platform_assignments',
        'DELETE'
    ) THEN
        RAISE EXCEPTION 'Runtime direct platform assignment write must be denied';
    END IF;

    IF has_table_privilege(
        'vind_app_runtime',
        'access.service_principal_grants',
        'SELECT'
    )
       OR has_table_privilege(
        'vind_app_runtime',
        'access.service_principal_grants',
        'INSERT'
    )
       OR has_table_privilege(
        'vind_app_runtime',
        'access.service_principal_grants',
        'UPDATE'
    )
       OR has_table_privilege(
        'vind_app_runtime',
        'access.service_principal_grants',
        'DELETE'
    ) THEN
        RAISE EXCEPTION 'Runtime raw service grant access forbidden';
    END IF;

    IF has_table_privilege(
        'vind_app_runtime',
        'configuration.settings',
        'SELECT'
    )
       OR has_table_privilege(
        'vind_app_runtime',
        'configuration.settings',
        'UPDATE'
    ) THEN
        RAISE EXCEPTION 'Runtime raw configuration access forbidden';
    END IF;

    SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema IN ('party', 'organization', 'identity')
      AND table_name IN ('persons', 'organizations', 'accounts')
      AND column_name IN (
        'data_origin_code',
        'source_import_batch_id',
        'source_reference'
      );

    IF v_count <> 9 THEN
        RAISE EXCEPTION 'Data-origin column inventory mismatch: %', v_count;
    END IF;

    IF EXISTS (
        SELECT 1 FROM party.persons WHERE data_origin_code IS NULL
    )
       OR EXISTS (
        SELECT 1 FROM organization.organizations WHERE data_origin_code IS NULL
    )
       OR EXISTS (
        SELECT 1 FROM identity.accounts WHERE data_origin_code IS NULL
    ) THEN
        RAISE EXCEPTION 'Unreconciled data origin rows';
    END IF;

    SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (
        n.nspname = 'security'
        AND p.proname IN (
            'clear_request_context',
            'set_request_context_v2',
            'current_channel_id',
            'current_region_id',
            'record_data_access'
        )
    )
    OR (
        n.nspname = 'access'
        AND p.proname IN (
            'has_local_capability',
            'has_platform_capability',
            'has_service_capability',
            'validate_scoped_assignment',
            'validate_platform_assignment',
            'validate_service_principal_grant'
        )
    )
    OR (
        n.nspname = 'configuration'
        AND p.proname = 'get_effective_setting'
    );

    IF v_count <> 12 THEN
        RAISE EXCEPTION 'Required S1 function inventory mismatch: %', v_count;
    END IF;

    SELECT count(*) INTO v_count
    FROM staging.import_batches
    WHERE false;
END;
$verify$;

SELECT 'S1_STRUCTURAL_VERIFIER_PASS' AS result;
