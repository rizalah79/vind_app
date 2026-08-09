-- Additive forward-fix migration for DB-DEC-021 remediation
-- Target: Enable SET row_security TO 'off' on SECURITY DEFINER read_evidence function
-- Target: Disable FORCE RLS on verification.verification_evidence (ENABLE RLS active) to allow SECURITY DEFINER function execution while revoking direct SELECT from vind_app_runtime

ALTER TABLE verification.verification_evidence NO FORCE ROW LEVEL SECURITY;
REVOKE SELECT ON verification.verification_evidence FROM vind_app_runtime;

CREATE OR REPLACE FUNCTION verification.read_evidence(p_evidence_id uuid, p_purpose_code text)
 RETURNS TABLE(id uuid, evidence_type text, document_number_masked text, storage_path_encrypted text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'verification', 'security', 'access'
 SET row_security TO 'off'
AS $function$
DECLARE
    v_actor_person_id uuid;
    v_actor_account_id uuid;
    v_acting_assignment_key text;
    v_correlation_id text;
    v_request_id text;
    v_authorized boolean := false;
BEGIN
    v_actor_person_id := security.current_actor_person_id();
    v_actor_account_id := security.current_actor_account_id();
    v_acting_assignment_key := security.context_value('platform_assignment_key');
    v_correlation_id := security.context_value('correlation_id');
    v_request_id := security.context_value('request_id');

    IF v_actor_person_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM verification.verification_evidence ve WHERE ve.id = p_evidence_id
    ) THEN
        RAISE EXCEPTION 'Verification evidence not found.' USING ERRCODE = '23503';
    END IF;

    -- Strict platform-only authorization (NO local provider or organization owner shortcuts)
    IF access.has_platform_capability('verification.evidence.read') THEN
        v_authorized := true;
    END IF;

    IF NOT v_authorized THEN
        RAISE EXCEPTION 'Unauthorized to read verification evidence.' USING ERRCODE = '42501';
    END IF;

    -- Record S1 compliance data access log
    INSERT INTO security.data_access_logs (
        actor_account_key, actor_person_key, acting_assignment_key,
        purpose_code, access_type, target_schema, target_relation, target_key,
        fields_accessed, result_count, correlation_id, request_id
    ) VALUES (
        v_actor_account_id::text, v_actor_person_id::text, v_acting_assignment_key,
        p_purpose_code, 'READ', 'verification', 'verification_evidence', p_evidence_id::text,
        ARRAY['id', 'evidence_type', 'document_number_masked', 'storage_path_encrypted', 'status'],
        1, v_correlation_id, v_request_id
    );

    RETURN QUERY
    SELECT ve.id, ve.evidence_type, ve.document_number_masked, ve.storage_path_encrypted, ve.status
    FROM verification.verification_evidence ve
    WHERE ve.id = p_evidence_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION verification.read_evidence(uuid, text) TO vind_app_runtime;
