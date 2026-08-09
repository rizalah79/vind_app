-- 20260809220000_dummy_ready_security_final

-- 1. Remove silent provider provenance default
ALTER TABLE provider.provider_profiles ALTER COLUMN data_origin_code DROP DEFAULT;

-- 2. Security Invoker Trigger Guards with strict current_user = 'vind_db_owner' boundary
CREATE OR REPLACE FUNCTION provider.prevent_direct_provider_status_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = provider, security, pg_catalog
AS $function$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF current_user <> 'vind_db_owner' OR current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'Direct update on protected status column of provider.provider_profiles is denied. Must use provider.execute_provider_status_command.'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION provider.prevent_direct_workspace_link_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = provider, security, pg_catalog
AS $function$
BEGIN
    IF current_user <> 'vind_db_owner' OR current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Direct modification of provider.provider_workspace_links is denied.'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION listing.prevent_direct_publication_status_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = listing, security, pg_catalog
AS $function$
BEGIN
    IF OLD.publication_status IS DISTINCT FROM NEW.publication_status THEN
        IF current_user <> 'vind_db_owner' OR current_setting('vind.command_execution_active', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'Direct update on protected publication_status column of listing.channel_publications is denied. Must use listing.execute_publication_command.'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

-- 3. Explicit Privilege Revocations for vind_app_runtime
REVOKE INSERT, UPDATE, DELETE ON provider.provider_profiles FROM vind_app_runtime;
REVOKE INSERT, UPDATE, DELETE ON provider.provider_workspace_links FROM vind_app_runtime;
REVOKE INSERT, UPDATE, DELETE ON listing.channel_publications FROM vind_app_runtime;
REVOKE INSERT, UPDATE, DELETE, SELECT ON verification.verification_evidence FROM vind_app_runtime;
REVOKE INSERT, UPDATE, DELETE ON access.scoped_assignments FROM vind_app_runtime;
REVOKE INSERT, UPDATE, DELETE ON access.platform_assignments FROM vind_app_runtime;
REVOKE INSERT, UPDATE, DELETE ON access.service_principal_grants FROM vind_app_runtime;
REVOKE INSERT, UPDATE, DELETE ON configuration.settings FROM vind_app_runtime;

-- 4. Explicit Privilege Revocations for vind_importer
REVOKE INSERT, UPDATE, DELETE ON access.roles FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON access.capabilities FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON access.role_capabilities FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON access.memberships FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON access.scoped_assignments FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON access.platform_assignments FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON access.service_principal_grants FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON configuration.settings FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON provider.provider_workspace_links FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON provider.provider_profiles FROM vind_importer;
REVOKE INSERT, UPDATE, DELETE ON listing.channel_publications FROM vind_importer;
