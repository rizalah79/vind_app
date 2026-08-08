-- Structural verifier: DB-DEC-021 Provider, Catalog, Media Rights,
-- Verification, and Channel Publication Core
--
-- Target migration directory:
--   20260809090000_provider_catalog_media_publication_core
-- Expected migration.sql SHA-256:
--   ac8170de7f98920324fb3839a211c29a0e9cd788d3ee85459b75afb012134ce7
--
-- IMPORTANT:
-- - This verifier is read-only against persistent database objects.
-- - It creates no persistent table, function, trigger, policy, or data.
-- - It accumulates all detected structural failures and raises one final error.

SET search_path = pg_catalog;
SET statement_timeout = '60s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '60s';

DO $verify$
DECLARE
    v_failures text[] := ARRAY[]::text[];
    v_expected_tables text[] := ARRAY[
        'provider.provider_profiles',
        'provider.provider_workspace_links',
        'provider.capability_definitions',
        'provider.provider_capabilities',
        'verification.verification_cases',
        'verification.verification_evidence',
        'catalog.offerings',
        'catalog.resources',
        'catalog.offering_resources',
        'catalog.packages',
        'catalog.package_items',
        'media.media_assets',
        'media.media_rights',
        'media.media_links',
        'listing.channel_publications'
    ];
    v_expected_migration_name constant text :=
        '20260809090000_provider_catalog_media_publication_core';
    v_expected_checksum constant text :=
        'ac8170de7f98920324fb3839a211c29a0e9cd788d3ee85459b75afb012134ce7';
    v_table text;
    v_schema text;
    v_relation text;
    v_definition text;
    v_unexpected text;
    v_count integer;
    v_record record;
BEGIN
    RAISE NOTICE 'DB-DEC-021 structural verification started.';

    ---------------------------------------------------------------------------
    -- A. Environment and foundation dependencies
    ---------------------------------------------------------------------------
    IF current_setting('server_version_num')::integer < 180000 THEN
        v_failures := array_append(
            v_failures,
            format('PostgreSQL 18+ required; server_version=%s.', current_setting('server_version'))
        );
    END IF;

    FOREACH v_relation IN ARRAY ARRAY['plpgsql', 'postgis', 'btree_gist']
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_extension WHERE extname = v_relation
        ) THEN
            v_failures := array_append(
                v_failures,
                format('Required extension missing: %s.', v_relation)
            );
        END IF;
    END LOOP;

    FOREACH v_schema IN ARRAY ARRAY[
        'provider', 'verification', 'catalog', 'media', 'listing',
        'organization', 'party', 'access', 'audit', 'integration',
        'privacy', 'security'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_namespace WHERE nspname = v_schema
        ) THEN
            v_failures := array_append(
                v_failures,
                format('Required schema missing: %I.', v_schema)
            );
        END IF;
    END LOOP;

    FOREACH v_table IN ARRAY ARRAY[
        'organization.organizations',
        'organization.workspaces',
        'party.persons',
        'listing.channels',
        'access.capabilities',
        'access.role_capabilities',
        'audit.audit_events',
        'integration.idempotency_keys',
        'integration.outbox_events',
        'privacy.retention_classes',
        'security.data_access_logs'
    ]
    LOOP
        IF to_regclass(v_table) IS NULL THEN
            v_failures := array_append(
                v_failures,
                format('Required foundation relation missing: %s.', v_table)
            );
        END IF;
    END LOOP;

    ---------------------------------------------------------------------------
    -- B. Migration ledger and checksum
    ---------------------------------------------------------------------------
    IF to_regclass('public.vind_schema_migrations') IS NULL THEN
        v_failures := array_append(
            v_failures,
            'Migration ledger public.vind_schema_migrations is missing.'
        );
    ELSE
        SELECT count(*)::integer
        INTO v_count
        FROM public.vind_schema_migrations
        WHERE migration_name = v_expected_migration_name;

        IF v_count <> 1 THEN
            v_failures := array_append(
                v_failures,
                format(
                    'Expected exactly one ledger row for %s; found %s.',
                    v_expected_migration_name,
                    v_count
                )
            );
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.vind_schema_migrations
            WHERE migration_name = v_expected_migration_name
              AND checksum_sha256 IS DISTINCT FROM v_expected_checksum
        ) THEN
            v_failures := array_append(
                v_failures,
                format(
                    'Ledger checksum mismatch for %s; expected %s.',
                    v_expected_migration_name,
                    v_expected_checksum
                )
            );
        END IF;
    END IF;

    ---------------------------------------------------------------------------
    -- C. Exact locked relation inventory
    ---------------------------------------------------------------------------
    FOREACH v_table IN ARRAY v_expected_tables
    LOOP
        IF to_regclass(v_table) IS NULL THEN
            v_failures := array_append(
                v_failures,
                format('Locked DB-DEC-021 relation missing: %s.', v_table)
            );
        END IF;
    END LOOP;

    SELECT count(*)::integer
    INTO v_count
    FROM unnest(v_expected_tables) AS expected(relation_name)
    WHERE to_regclass(expected.relation_name) IS NOT NULL;

    IF v_count <> 15 THEN
        v_failures := array_append(
            v_failures,
            format('Expected 15 locked relations; found %s.', v_count)
        );
    END IF;

    SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
    INTO v_unexpected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname IN ('provider', 'verification', 'catalog', 'media', 'listing')
      AND format('%I.%I', n.nspname, c.relname) <> ALL (
          v_expected_tables || ARRAY['listing.channels']
      );

    IF v_unexpected IS NOT NULL THEN
        v_failures := array_append(
            v_failures,
            format('Unexpected table(s) in DB-DEC-021 schemas: %s.', v_unexpected)
        );
    END IF;

    ---------------------------------------------------------------------------
    -- D. Primary keys and critical columns
    ---------------------------------------------------------------------------
    FOREACH v_table IN ARRAY v_expected_tables
    LOOP
        IF to_regclass(v_table) IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM pg_constraint
               WHERE conrelid = to_regclass(v_table)
                 AND contype = 'p'
           ) THEN
            v_failures := array_append(
                v_failures,
                format('Primary key missing on %s.', v_table)
            );
        END IF;
    END LOOP;

    FOR v_record IN
        SELECT *
        FROM (VALUES
            ('provider', 'provider_profiles', 'id'),
            ('provider', 'provider_profiles', 'owning_organization_id'),
            ('provider', 'provider_profiles', 'owning_person_id'),
            ('provider', 'provider_profiles', 'status'),
            ('provider', 'provider_profiles', 'retention_class_code'),
            ('provider', 'provider_workspace_links', 'provider_profile_id'),
            ('provider', 'provider_workspace_links', 'managing_organization_id'),
            ('provider', 'provider_workspace_links', 'workspace_id'),
            ('provider', 'provider_workspace_links', 'link_status'),
            ('provider', 'provider_workspace_links', 'effective_from'),
            ('provider', 'provider_workspace_links', 'effective_to'),
            ('provider', 'provider_capabilities', 'provider_profile_id'),
            ('provider', 'provider_capabilities', 'capability_definition_id'),
            ('verification', 'verification_cases', 'provider_profile_id'),
            ('verification', 'verification_cases', 'status'),
            ('verification', 'verification_cases', 'verified_at'),
            ('verification', 'verification_cases', 'expires_at'),
            ('verification', 'verification_evidence', 'verification_case_id'),
            ('verification', 'verification_evidence', 'retention_class_code'),
            ('catalog', 'offerings', 'provider_profile_id'),
            ('catalog', 'resources', 'provider_profile_id'),
            ('catalog', 'offering_resources', 'offering_id'),
            ('catalog', 'offering_resources', 'resource_id'),
            ('catalog', 'packages', 'provider_profile_id'),
            ('catalog', 'packages', 'anchor_offering_id'),
            ('catalog', 'package_items', 'package_id'),
            ('catalog', 'package_items', 'offering_id'),
            ('media', 'media_assets', 'owner_provider_profile_id'),
            ('media', 'media_assets', 'status'),
            ('media', 'media_rights', 'media_asset_id'),
            ('media', 'media_rights', 'status'),
            ('media', 'media_links', 'media_asset_id'),
            ('media', 'media_links', 'link_role'),
            ('media', 'media_links', 'link_status'),
            ('listing', 'channel_publications', 'provider_profile_id'),
            ('listing', 'channel_publications', 'offering_id'),
            ('listing', 'channel_publications', 'package_id'),
            ('listing', 'channel_publications', 'channel_id'),
            ('listing', 'channel_publications', 'publication_status')
        ) AS required_columns(schema_name, table_name, column_name)
    LOOP
        IF to_regclass(format('%I.%I', v_record.schema_name, v_record.table_name)) IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM information_schema.columns
               WHERE table_schema = v_record.schema_name
                 AND table_name = v_record.table_name
                 AND column_name = v_record.column_name
           ) THEN
            v_failures := array_append(
                v_failures,
                format(
                    'Required column missing: %I.%I.%I.',
                    v_record.schema_name,
                    v_record.table_name,
                    v_record.column_name
                )
            );
        END IF;
    END LOOP;

    ---------------------------------------------------------------------------
    -- E. Foreign keys
    ---------------------------------------------------------------------------
    FOR v_record IN
        SELECT *
        FROM (VALUES
            ('provider.provider_profiles', 'organization.organizations'),
            ('provider.provider_profiles', 'party.persons'),
            ('provider.provider_profiles', 'privacy.retention_classes'),
            ('provider.provider_workspace_links', 'provider.provider_profiles'),
            ('provider.provider_workspace_links', 'organization.organizations'),
            ('provider.provider_workspace_links', 'organization.workspaces'),
            ('provider.provider_capabilities', 'provider.provider_profiles'),
            ('provider.provider_capabilities', 'provider.capability_definitions'),
            ('verification.verification_cases', 'provider.provider_profiles'),
            ('verification.verification_evidence', 'verification.verification_cases'),
            ('verification.verification_evidence', 'privacy.retention_classes'),
            ('catalog.offerings', 'provider.provider_profiles'),
            ('catalog.resources', 'provider.provider_profiles'),
            ('catalog.offering_resources', 'catalog.offerings'),
            ('catalog.offering_resources', 'catalog.resources'),
            ('catalog.packages', 'provider.provider_profiles'),
            ('catalog.packages', 'catalog.offerings'),
            ('catalog.package_items', 'catalog.packages'),
            ('catalog.package_items', 'catalog.offerings'),
            ('media.media_assets', 'provider.provider_profiles'),
            ('media.media_rights', 'media.media_assets'),
            ('media.media_links', 'media.media_assets'),
            ('media.media_links', 'provider.provider_profiles'),
            ('media.media_links', 'catalog.offerings'),
            ('media.media_links', 'catalog.resources'),
            ('media.media_links', 'catalog.packages'),
            ('media.media_links', 'listing.channel_publications'),
            ('listing.channel_publications', 'provider.provider_profiles'),
            ('listing.channel_publications', 'catalog.offerings'),
            ('listing.channel_publications', 'catalog.packages'),
            ('listing.channel_publications', 'listing.channels')
        ) AS required_fks(source_relation, target_relation)
    LOOP
        IF to_regclass(v_record.source_relation) IS NOT NULL
           AND to_regclass(v_record.target_relation) IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM pg_constraint
               WHERE contype = 'f'
                 AND conrelid = to_regclass(v_record.source_relation)
                 AND confrelid = to_regclass(v_record.target_relation)
           ) THEN
            v_failures := array_append(
                v_failures,
                format(
                    'Required foreign key missing: %s -> %s.',
                    v_record.source_relation,
                    v_record.target_relation
                )
            );
        END IF;
    END LOOP;

    ---------------------------------------------------------------------------
    -- F. Locked CHECK and consistency invariants
    ---------------------------------------------------------------------------
    IF to_regclass('provider.provider_profiles') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conrelid = 'provider.provider_profiles'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%owning_organization_id%'
             AND pg_get_constraintdef(oid) ILIKE '%owning_person_id%'
       ) THEN
        v_failures := array_append(
            v_failures,
            'Provider ownership XOR CHECK is missing.'
        );
    END IF;

    SELECT pg_get_constraintdef(oid)
    INTO v_definition
    FROM pg_constraint
    WHERE conrelid = to_regclass('provider.provider_profiles')
      AND contype = 'c'
      AND conname = 'chk_provider_status';

    IF v_definition IS NULL THEN
        v_failures := array_append(v_failures, 'Provider status CHECK is missing.');
    ELSE
        IF v_definition NOT ILIKE '%DRAFT%'
           OR v_definition NOT ILIKE '%ACTIVE%'
           OR v_definition NOT ILIKE '%SUSPENDED%'
           OR v_definition NOT ILIKE '%ARCHIVED%' THEN
            v_failures := array_append(
                v_failures,
                format(
                    'Provider status CHECK does not match locked DRAFT/ACTIVE/SUSPENDED/ARCHIVED lifecycle: %s.',
                    v_definition
                )
            );
        END IF;
    END IF;

    IF to_regclass('media.media_links') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conrelid = 'media.media_links'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%num_nonnulls%'
             AND pg_get_constraintdef(oid) ILIKE '%provider_profile_id%'
             AND pg_get_constraintdef(oid) ILIKE '%offering_id%'
             AND pg_get_constraintdef(oid) ILIKE '%resource_id%'
             AND pg_get_constraintdef(oid) ILIKE '%package_id%'
             AND pg_get_constraintdef(oid) ILIKE '%channel_publication_id%'
       ) THEN
        v_failures := array_append(
            v_failures,
            'media.media_links exact-one-target XOR CHECK is missing.'
        );
    END IF;

    IF to_regclass('listing.channel_publications') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conrelid = 'listing.channel_publications'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%offering_id%'
             AND pg_get_constraintdef(oid) ILIKE '%package_id%'
       ) THEN
        v_failures := array_append(
            v_failures,
            'listing.channel_publications offering/package target XOR CHECK is missing.'
        );
    END IF;

    FOR v_record IN
        SELECT *
        FROM (VALUES
            ('provider.provider_workspace_links', 'effective_from', 'effective_to'),
            ('media.media_rights', 'effective_from', 'effective_to'),
            ('media.media_links', 'effective_from', 'effective_to'),
            ('listing.channel_publications', 'effective_from', 'effective_to')
        ) AS effective_periods(relation_name, from_column, to_column)
    LOOP
        IF to_regclass(v_record.relation_name) IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM pg_constraint
               WHERE conrelid = to_regclass(v_record.relation_name)
                 AND contype = 'c'
                 AND pg_get_constraintdef(oid) ILIKE '%' || v_record.from_column || '%'
                 AND pg_get_constraintdef(oid) ILIKE '%' || v_record.to_column || '%'
           ) THEN
            v_failures := array_append(
                v_failures,
                format('Effective-period CHECK missing on %s.', v_record.relation_name)
            );
        END IF;
    END LOOP;

    IF to_regclass('verification.verification_cases') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conrelid = 'verification.verification_cases'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%verified_at%'
             AND pg_get_constraintdef(oid) ILIKE '%expires_at%'
       ) THEN
        v_failures := array_append(
            v_failures,
            'Verification effective/expiry-period CHECK is missing.'
        );
    END IF;

    FOREACH v_relation IN ARRAY ARRAY[
        'catalog.trg_offering_resource_provider_consistency',
        'catalog.trg_package_provider_consistency'
    ]
    LOOP
        v_schema := split_part(v_relation, '.', 1);
        v_relation := split_part(v_relation, '.', 2);
        IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE t.tgname = v_relation
              AND n.nspname = v_schema
              AND NOT t.tgisinternal
              AND t.tgenabled <> 'D'
        ) THEN
            v_failures := array_append(
                v_failures,
                format('Cross-provider consistency trigger missing or disabled: %s.', v_relation)
            );
        END IF;
    END LOOP;

    ---------------------------------------------------------------------------
    -- G. Indexes and seed key uniqueness
    ---------------------------------------------------------------------------
    FOR v_record IN
        SELECT *
        FROM (VALUES
            ('provider.provider_profiles', 'seed_key'),
            ('provider.provider_workspace_links', 'seed_key'),
            ('provider.capability_definitions', 'code'),
            ('verification.verification_cases', 'seed_key'),
            ('verification.verification_evidence', 'seed_key'),
            ('catalog.offerings', 'seed_key'),
            ('catalog.resources', 'seed_key'),
            ('catalog.packages', 'seed_key'),
            ('media.media_assets', 'seed_key'),
            ('media.media_rights', 'seed_key'),
            ('media.media_links', 'seed_key'),
            ('listing.channel_publications', 'seed_key')
        ) AS seed_keys(relation_name, column_name)
    LOOP
        IF to_regclass(v_record.relation_name) IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM pg_index i
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
               WHERE i.indrelid = to_regclass(v_record.relation_name)
                 AND i.indisunique
                 AND a.attname = v_record.column_name
           ) THEN
            v_failures := array_append(
                v_failures,
                format(
                    'Unique index/constraint missing for %s.%I.',
                    v_record.relation_name,
                    v_record.column_name
                )
            );
        END IF;
    END LOOP;

    FOR v_record IN
        SELECT *
        FROM (VALUES
            ('provider.provider_capabilities', 'provider_capabilities_unique'),
            ('catalog.offering_resources', 'offering_resources_unique'),
            ('catalog.package_items', 'package_items_unique')
        ) AS required_unique_constraints(relation_name, constraint_name)
    LOOP
        IF to_regclass(v_record.relation_name) IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM pg_constraint
               WHERE conrelid = to_regclass(v_record.relation_name)
                 AND contype = 'u'
                 AND conname = v_record.constraint_name
           ) THEN
            v_failures := array_append(
                v_failures,
                format(
                    'Required unique constraint missing: %s.%I.',
                    v_record.relation_name,
                    v_record.constraint_name
                )
            );
        END IF;
    END LOOP;

    ---------------------------------------------------------------------------
    -- H. RLS, table ownership, policies, and table privileges
    ---------------------------------------------------------------------------
    FOREACH v_table IN ARRAY v_expected_tables
    LOOP
        IF to_regclass(v_table) IS NOT NULL THEN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_class
                WHERE oid = to_regclass(v_table)
                  AND relrowsecurity
            ) THEN
                v_failures := array_append(
                    v_failures,
                    format('RLS is not enabled on %s.', v_table)
                );
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM pg_class
                WHERE oid = to_regclass(v_table)
                  AND relforcerowsecurity
            ) THEN
                v_failures := array_append(
                    v_failures,
                    format('FORCE ROW LEVEL SECURITY is not enabled on %s.', v_table)
                );
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_roles r ON r.oid = c.relowner
                WHERE c.oid = to_regclass(v_table)
                  AND r.rolname IN ('vind_app_runtime', 'vind_importer', 'vind_readonly')
            ) THEN
                v_failures := array_append(
                    v_failures,
                    format('Unsafe table owner on %s.', v_table)
                );
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM pg_policies
                WHERE schemaname = split_part(v_table, '.', 1)
                  AND tablename = split_part(v_table, '.', 2)
                  AND ('vind_importer'::name = ANY(roles))
            ) THEN
                v_failures := array_append(
                    v_failures,
                    format('Importer RLS policy missing on %s.', v_table)
                );
            END IF;

            IF has_table_privilege('vind_app_runtime', v_table, 'SELECT')
               AND v_table <> 'verification.verification_evidence'
               AND NOT EXISTS (
                   SELECT 1
                   FROM pg_policies
                   WHERE schemaname = split_part(v_table, '.', 1)
                     AND tablename = split_part(v_table, '.', 2)
                     AND ('vind_app_runtime'::name = ANY(roles))
               ) THEN
                v_failures := array_append(
                    v_failures,
                    format(
                        'Runtime SELECT exists without a runtime RLS policy on %s.',
                        v_table
                    )
                );
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_class c
                CROSS JOIN LATERAL aclexplode(
                    coalesce(c.relacl, acldefault('r', c.relowner))
                ) AS acl
                WHERE c.oid = to_regclass(v_table)
                  AND acl.grantee = 0
                  AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
            ) THEN
                v_failures := array_append(
                    v_failures,
                    format('PUBLIC has unsafe table privileges on %s.', v_table)
                );
            END IF;
        END IF;
    END LOOP;

    IF to_regclass('verification.verification_evidence') IS NOT NULL
       AND has_table_privilege(
           'vind_app_runtime',
           'verification.verification_evidence',
           'SELECT'
       ) THEN
        v_failures := array_append(
            v_failures,
            'vind_app_runtime must not have direct SELECT on verification.verification_evidence.'
        );
    END IF;

    IF to_regclass('provider.provider_profiles') IS NOT NULL
       AND has_column_privilege(
           'vind_app_runtime',
           'provider.provider_profiles',
           'status',
           'UPDATE'
       ) THEN
        v_failures := array_append(
            v_failures,
            'vind_app_runtime has direct UPDATE privilege on protected provider status.'
        );
    END IF;

    IF to_regclass('listing.channel_publications') IS NOT NULL
       AND has_column_privilege(
           'vind_app_runtime',
           'listing.channel_publications',
           'publication_status',
           'UPDATE'
       ) THEN
        v_failures := array_append(
            v_failures,
            'vind_app_runtime has direct UPDATE privilege on protected publication status.'
        );
    END IF;

    ---------------------------------------------------------------------------
    -- I. Protected-update triggers
    ---------------------------------------------------------------------------
    FOR v_record IN
        SELECT *
        FROM (VALUES
            ('provider.provider_profiles', 'trg_prevent_direct_provider_status_update'),
            ('provider.provider_workspace_links', 'trg_prevent_direct_workspace_link_update'),
            ('listing.channel_publications', 'trg_prevent_direct_publication_status_update')
        ) AS protected_triggers(relation_name, trigger_name)
    LOOP
        IF to_regclass(v_record.relation_name) IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM pg_trigger
               WHERE tgrelid = to_regclass(v_record.relation_name)
                 AND tgname = v_record.trigger_name
                 AND NOT tgisinternal
                 AND tgenabled <> 'D'
           ) THEN
            v_failures := array_append(
                v_failures,
                format(
                    'Protected-update trigger missing or disabled: %s on %s.',
                    v_record.trigger_name,
                    v_record.relation_name
                )
            );
        END IF;
    END LOOP;

    ---------------------------------------------------------------------------
    -- J. SECURITY DEFINER functions, fixed search_path, grants, and dependencies
    ---------------------------------------------------------------------------
    FOR v_record IN
        SELECT *
        FROM (VALUES
            ('provider.execute_provider_status_command(uuid,text,text,text,text)', true),
            ('listing.execute_publication_command(uuid,text,text,text,text)', true),
            ('verification.read_evidence(uuid,text)', true),
            ('provider.prevent_direct_provider_status_update()', true),
            ('provider.prevent_direct_workspace_link_update()', true),
            ('listing.prevent_direct_publication_status_update()', true)
        ) AS required_functions(signature, must_be_security_definer)
    LOOP
        IF to_regprocedure(v_record.signature) IS NULL THEN
            v_failures := array_append(
                v_failures,
                format('Required function missing: %s.', v_record.signature)
            );
        ELSE
            IF v_record.must_be_security_definer
               AND NOT EXISTS (
                   SELECT 1
                   FROM pg_proc
                   WHERE oid = to_regprocedure(v_record.signature)
                     AND prosecdef
               ) THEN
                v_failures := array_append(
                    v_failures,
                    format('Function is not SECURITY DEFINER: %s.', v_record.signature)
                );
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM pg_proc p
                CROSS JOIN LATERAL unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg(setting)
                WHERE p.oid = to_regprocedure(v_record.signature)
                  AND cfg.setting LIKE 'search_path=%'
                  AND cfg.setting LIKE '%pg_catalog%'
            ) THEN
                v_failures := array_append(
                    v_failures,
                    format('Function lacks fixed search_path including pg_catalog: %s.', v_record.signature)
                );
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_proc p
                CROSS JOIN LATERAL aclexplode(
                    coalesce(p.proacl, acldefault('f', p.proowner))
                ) AS acl
                WHERE p.oid = to_regprocedure(v_record.signature)
                  AND acl.grantee = 0
                  AND acl.privilege_type = 'EXECUTE'
            ) THEN
                v_failures := array_append(
                    v_failures,
                    format('PUBLIC EXECUTE must be revoked from %s.', v_record.signature)
                );
            END IF;
        END IF;
    END LOOP;

    FOREACH v_relation IN ARRAY ARRAY[
        'provider.execute_provider_status_command(uuid,text,text,text,text)',
        'listing.execute_publication_command(uuid,text,text,text,text)',
        'verification.read_evidence(uuid,text)'
    ]
    LOOP
        IF to_regprocedure(v_relation) IS NOT NULL
           AND NOT has_function_privilege('vind_app_runtime', v_relation, 'EXECUTE') THEN
            v_failures := array_append(
                v_failures,
                format('vind_app_runtime lacks EXECUTE on %s.', v_relation)
            );
        END IF;
    END LOOP;

    IF to_regprocedure('provider.execute_provider_status_command(uuid,text,text,text,text)') IS NOT NULL THEN
        v_definition := pg_get_functiondef(
            'provider.execute_provider_status_command(uuid,text,text,text,text)'::regprocedure
        );

        FOREACH v_relation IN ARRAY ARRAY[
            'integration.idempotency_keys',
            'audit.audit_events',
            'integration.outbox_events',
            'listing.channel_publications'
        ]
        LOOP
            IF position(lower(v_relation) IN lower(v_definition)) = 0 THEN
                v_failures := array_append(
                    v_failures,
                    format(
                        'Provider status command lacks required dependency/reference: %s.',
                        v_relation
                    )
                );
            END IF;
        END LOOP;

        IF position('capabil' IN lower(v_definition)) = 0
           OR (
               position('current_organization_id' IN lower(v_definition)) = 0
               AND position('provider_workspace_links' IN lower(v_definition)) = 0
           ) THEN
            v_failures := array_append(
                v_failures,
                'Provider status command lacks explicit capability and provider-boundary authorization checks.'
            );
        END IF;
    END IF;

    IF to_regprocedure('listing.execute_publication_command(uuid,text,text,text,text)') IS NOT NULL THEN
        v_definition := pg_get_functiondef(
            'listing.execute_publication_command(uuid,text,text,text,text)'::regprocedure
        );

        FOREACH v_relation IN ARRAY ARRAY[
            'provider.provider_profiles',
            'verification.verification_cases',
            'media.media_links',
            'media.media_assets',
            'media.media_rights',
            'integration.idempotency_keys',
            'audit.audit_events',
            'integration.outbox_events'
        ]
        LOOP
            IF position(lower(v_relation) IN lower(v_definition)) = 0 THEN
                v_failures := array_append(
                    v_failures,
                    format(
                        'Publication command lacks required dependency/reference: %s.',
                        v_relation
                    )
                );
            END IF;
        END LOOP;

        FOREACH v_relation IN ARRAY ARRAY[
            'public_listing',
            'channel_publication_id',
            'link_status',
            'effective_to',
            'approved',
            'active'
        ]
        LOOP
            IF position(lower(v_relation) IN lower(v_definition)) = 0 THEN
                v_failures := array_append(
                    v_failures,
                    format(
                        'Publication command lacks required gate token/reference: %s.',
                        v_relation
                    )
                );
            END IF;
        END LOOP;

        IF position('capabil' IN lower(v_definition)) = 0
           OR (
               position('current_organization_id' IN lower(v_definition)) = 0
               AND position('provider_workspace_links' IN lower(v_definition)) = 0
           ) THEN
            v_failures := array_append(
                v_failures,
                'Publication command lacks explicit capability and provider-boundary authorization checks.'
            );
        END IF;
    END IF;

    IF to_regprocedure('verification.read_evidence(uuid,text)') IS NOT NULL THEN
        v_definition := pg_get_functiondef(
            'verification.read_evidence(uuid,text)'::regprocedure
        );

        IF position('security.data_access_logs' IN lower(v_definition)) = 0 THEN
            v_failures := array_append(
                v_failures,
                'verification.read_evidence does not write security.data_access_logs.'
            );
        END IF;

        IF position('current_actor_person_id' IN lower(v_definition)) = 0 THEN
            v_failures := array_append(
                v_failures,
                'verification.read_evidence lacks authenticated actor check.'
            );
        END IF;

        IF position('capabil' IN lower(v_definition)) = 0
           OR (
               position('current_organization_id' IN lower(v_definition)) = 0
               AND position('provider_profile_id' IN lower(v_definition)) = 0
           ) THEN
            v_failures := array_append(
                v_failures,
                'verification.read_evidence lacks explicit restricted-read capability and tenant-boundary authorization.'
            );
        END IF;
    END IF;

    ---------------------------------------------------------------------------
    -- K. Final result
    ---------------------------------------------------------------------------
    IF cardinality(v_failures) > 0 THEN
        RAISE WARNING 'DB-DEC-021 structural verification found % failure(s).', cardinality(v_failures);
        FOREACH v_relation IN ARRAY v_failures
        LOOP
            RAISE WARNING '%', v_relation;
        END LOOP;

        RAISE EXCEPTION 'DB-DEC-021 structural verification FAILED with % issue(s).', cardinality(v_failures)
            USING ERRCODE = 'P0001';
    END IF;

    RAISE NOTICE 'DB-DEC-021 structural verification PASSED.';
    RAISE NOTICE 'Verified 15 locked relations, constraints, FK topology, RLS, privileges, functions, and migration checksum.';
END;
$verify$;
