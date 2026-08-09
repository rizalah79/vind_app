-- Migration: 20260809210000_dummy_ready_closure
-- Purpose: Final Database Dummy-Ready Closure (Importer Least Privilege & Command Guard Escape Prevention)

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';

-- ============================================================================
-- 1. Importer Least-Privilege Remediation
-- ============================================================================

-- Revoke all table-level DML privileges on authority and configuration domains from vind_importer
REVOKE INSERT, UPDATE, DELETE ON access.scoped_assignments FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON access.platform_assignments FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON access.service_principal_grants FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON configuration.settings FROM vind_importer;

-- Drop existing importer policies if present to prevent policy conflicts
DROP POLICY IF EXISTS importer_deny_scoped_assignments ON access.scoped_assignments;
DROP POLICY IF EXISTS importer_deny_platform_assignments ON access.platform_assignments;
DROP POLICY IF EXISTS importer_deny_service_principal_grants ON access.service_principal_grants;
DROP POLICY IF EXISTS importer_deny_configuration_settings ON configuration.settings;

-- Create explicit denial RLS policies for vind_importer on authority & config relations
CREATE POLICY importer_deny_scoped_assignments ON access.scoped_assignments FOR ALL TO vind_importer USING (false) WITH CHECK (false);
CREATE POLICY importer_deny_platform_assignments ON access.platform_assignments FOR ALL TO vind_importer USING (false) WITH CHECK (false);
CREATE POLICY importer_deny_service_principal_grants ON access.service_principal_grants FOR ALL TO vind_importer USING (false) WITH CHECK (false);
CREATE POLICY importer_deny_configuration_settings ON configuration.settings FOR ALL TO vind_importer USING (false) WITH CHECK (false);

-- ============================================================================
-- 2. Command Guard Escape Prevention (Strict Execution Identity Verification)
-- ============================================================================

-- Provider Profiles status update trigger
CREATE OR REPLACE FUNCTION provider.prevent_direct_provider_status_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = provider, security, pg_catalog
AS $function$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on'
           OR current_user <> 'vind_db_owner' THEN
            RAISE EXCEPTION 'Direct update on protected status column of provider.provider_profiles is denied. Must use provider.execute_provider_status_command.'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

-- Provider Workspace Links modification trigger
CREATE OR REPLACE FUNCTION provider.prevent_direct_workspace_link_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = provider, security, pg_catalog
AS $function$
BEGIN
    IF current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on'
       OR current_user <> 'vind_db_owner' THEN
        RAISE EXCEPTION 'Direct modification of provider.provider_workspace_links is denied.'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$function$;

-- Channel Publications status update trigger
CREATE OR REPLACE FUNCTION listing.prevent_direct_publication_status_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = listing, security, pg_catalog
AS $function$
BEGIN
    IF OLD.publication_status IS DISTINCT FROM NEW.publication_status THEN
        IF current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on'
           OR current_user <> 'vind_db_owner' THEN
            RAISE EXCEPTION 'Direct update on protected publication_status column of listing.channel_publications is denied. Must use listing.execute_publication_command.'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;
