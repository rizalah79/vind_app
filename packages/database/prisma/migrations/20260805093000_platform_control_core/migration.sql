-- Platform Control Core
-- SQL-first migration.
-- Do not add BEGIN or COMMIT: transaction is managed by the runner.

SET search_path = pg_catalog;

-- =========================================================
-- Privacy: configuration-driven retention
-- =========================================================

CREATE TABLE privacy.retention_classes (
    code text PRIMARY KEY,
    display_name text NOT NULL,
    description text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT retention_classes_code_format
        CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$')
);

CREATE TABLE privacy.retention_policy_versions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    retention_class_code text NOT NULL
        REFERENCES privacy.retention_classes(code),
    policy_version integer NOT NULL,
    jurisdiction_code text NOT NULL DEFAULT 'GLOBAL',
    disposal_action text NOT NULL,
    retention_seconds bigint,
    grace_seconds bigint,
    legal_hold_supported boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'DRAFT',
    effective_from timestamptz NOT NULL,
    effective_to timestamptz,
    policy_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by text NOT NULL DEFAULT SESSION_USER,

    CONSTRAINT retention_policy_version_positive
        CHECK (policy_version > 0),

    CONSTRAINT retention_policy_action_valid
        CHECK (
            disposal_action IN (
                'DELETE',
                'ANONYMIZE',
                'ARCHIVE',
                'REVIEW',
                'KEEP'
            )
        ),

    CONSTRAINT retention_policy_status_valid
        CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),

    CONSTRAINT retention_policy_duration_valid
        CHECK (
            retention_seconds IS NULL
            OR retention_seconds >= 0
        ),

    CONSTRAINT retention_policy_grace_valid
        CHECK (
            grace_seconds IS NULL
            OR grace_seconds >= 0
        ),

    CONSTRAINT retention_policy_effective_range
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        ),

    CONSTRAINT retention_policy_version_unique
        UNIQUE (
            retention_class_code,
            jurisdiction_code,
            policy_version
        )
);

ALTER TABLE privacy.retention_policy_versions
    ADD CONSTRAINT retention_policy_no_active_overlap
    EXCLUDE USING gist (
        retention_class_code WITH =,
        jurisdiction_code WITH =,
        tstzrange(
            effective_from,
            COALESCE(
                effective_to,
                'infinity'::timestamptz
            ),
            '[)'
        ) WITH &&
    )
    WHERE (status = 'ACTIVE');

CREATE TABLE privacy.retention_assignments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target_schema text NOT NULL,
    target_relation text NOT NULL,
    aggregate_type text NOT NULL DEFAULT '*',
    policy_version_id bigint NOT NULL
        REFERENCES privacy.retention_policy_versions(id),
    effective_from timestamptz NOT NULL,
    effective_to timestamptz,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by text NOT NULL DEFAULT SESSION_USER,

    CONSTRAINT retention_assignment_identifier_format
        CHECK (
            target_schema ~ '^[a-z][a-z0-9_]*$'
            AND target_relation ~ '^[a-z][a-z0-9_]*$'
        ),

    CONSTRAINT retention_assignment_effective_range
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        )
);

ALTER TABLE privacy.retention_assignments
    ADD CONSTRAINT retention_assignment_no_active_overlap
    EXCLUDE USING gist (
        target_schema WITH =,
        target_relation WITH =,
        aggregate_type WITH =,
        tstzrange(
            effective_from,
            COALESCE(
                effective_to,
                'infinity'::timestamptz
            ),
            '[)'
        ) WITH &&
    )
    WHERE (is_active);

INSERT INTO privacy.retention_classes (
    code,
    display_name,
    description
)
VALUES
    ('REF', 'Reference', 'Reference and master configuration'),
    ('PRIV', 'Privacy', 'Consent, preference, and privacy records'),
    ('EPH', 'Ephemeral', 'Expiry-driven operational records'),
    ('CASE', 'Case', 'Inquiry, quote, and case lifecycle records'),
    ('OPS', 'Operational', 'General operational records'),
    ('MEDIA', 'Media', 'Media rights, use, and retirement records'),
    ('FIN', 'Finance', 'Financial and legal evidence'),
    ('SEC', 'Security', 'Security, audit, and access evidence'),
    ('LEGACY', 'Legacy', 'Immutable legacy-reference evidence')
ON CONFLICT (code) DO NOTHING;

-- =========================================================
-- Access: role, capability, role-capability
-- =========================================================

CREATE TABLE access.roles (
    code text PRIMARY KEY,
    display_name text NOT NULL,
    description text,
    role_scope text NOT NULL,
    is_system boolean NOT NULL DEFAULT true,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT roles_code_format
        CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),

    CONSTRAINT roles_scope_valid
        CHECK (
            role_scope IN (
                'SYSTEM',
                'ORGANIZATION',
                'WORKSPACE',
                'CASE',
                'RESOURCE',
                'CONTENT',
                'FINANCE'
            )
        )
);

CREATE TABLE access.capabilities (
    code text PRIMARY KEY,
    domain_code text NOT NULL,
    action_code text NOT NULL,
    description text NOT NULL,
    is_sensitive boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT capabilities_code_format
        CHECK (
            code ~ '^[a-z][a-z0-9_.:-]{2,127}$'
        ),

    CONSTRAINT capabilities_domain_format
        CHECK (
            domain_code ~ '^[a-z][a-z0-9_]{1,31}$'
        )
);

CREATE TABLE access.role_capabilities (
    role_code text NOT NULL
        REFERENCES access.roles(code)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    capability_code text NOT NULL
        REFERENCES access.capabilities(code)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    effect text NOT NULL DEFAULT 'ALLOW',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by text NOT NULL DEFAULT SESSION_USER,

    PRIMARY KEY (role_code, capability_code),

    CONSTRAINT role_capability_effect_valid
        CHECK (effect IN ('ALLOW', 'DENY'))
);

CREATE INDEX role_capabilities_capability_idx
    ON access.role_capabilities(capability_code);

INSERT INTO access.roles (
    code,
    display_name,
    description,
    role_scope
)
VALUES
    (
        'OWNER',
        'Owner',
        'Sahabat organization owner',
        'ORGANIZATION'
    ),
    (
        'ADMIN',
        'Admin',
        'Sahabat organization administrator',
        'ORGANIZATION'
    ),
    (
        'OPERATIONS_STAFF',
        'Operations Staff',
        'Sahabat operational staff',
        'ORGANIZATION'
    ),
    (
        'ACCOUNTING',
        'Accounting',
        'Sahabat accounting role',
        'FINANCE'
    ),
    (
        'CONTENT_MANAGER',
        'Content Manager',
        'Sahabat content management role',
        'CONTENT'
    )
ON CONFLICT (code) DO NOTHING;

-- =========================================================
-- Security request context
-- =========================================================

CREATE OR REPLACE FUNCTION security.set_request_context(
    p_actor_account_key text,
    p_actor_person_key text,
    p_membership_key text,
    p_assignment_key text,
    p_organization_key text,
    p_workspace_key text,
    p_channel_code text,
    p_correlation_id text,
    p_request_id text,
    p_purpose_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, security
AS $function$
BEGIN
    PERFORM set_config(
        'app.actor_account_key',
        COALESCE(p_actor_account_key, ''),
        true
    );

    PERFORM set_config(
        'app.actor_person_key',
        COALESCE(p_actor_person_key, ''),
        true
    );

    PERFORM set_config(
        'app.membership_key',
        COALESCE(p_membership_key, ''),
        true
    );

    PERFORM set_config(
        'app.assignment_key',
        COALESCE(p_assignment_key, ''),
        true
    );

    PERFORM set_config(
        'app.organization_key',
        COALESCE(p_organization_key, ''),
        true
    );

    PERFORM set_config(
        'app.workspace_key',
        COALESCE(p_workspace_key, ''),
        true
    );

    PERFORM set_config(
        'app.channel_code',
        COALESCE(p_channel_code, ''),
        true
    );

    PERFORM set_config(
        'app.correlation_id',
        COALESCE(p_correlation_id, ''),
        true
    );

    PERFORM set_config(
        'app.request_id',
        COALESCE(p_request_id, ''),
        true
    );

    PERFORM set_config(
        'app.purpose_code',
        COALESCE(p_purpose_code, ''),
        true
    );

    PERFORM set_config(
        'app.context_initialized',
        'true',
        true
    );
END;
$function$;

CREATE OR REPLACE FUNCTION security.context_value(
    p_key text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
    SELECT NULLIF(
        current_setting('app.' || p_key, true),
        ''
    );
$function$;

CREATE OR REPLACE FUNCTION security.current_request_context()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, security
AS $function$
    SELECT jsonb_strip_nulls(
        jsonb_build_object(
            'actor_account_key',
                security.context_value('actor_account_key'),
            'actor_person_key',
                security.context_value('actor_person_key'),
            'membership_key',
                security.context_value('membership_key'),
            'assignment_key',
                security.context_value('assignment_key'),
            'organization_key',
                security.context_value('organization_key'),
            'workspace_key',
                security.context_value('workspace_key'),
            'channel_code',
                security.context_value('channel_code'),
            'correlation_id',
                security.context_value('correlation_id'),
            'request_id',
                security.context_value('request_id'),
            'purpose_code',
                security.context_value('purpose_code')
        )
    );
$function$;

-- =========================================================
-- Integration: idempotency and transactional outbox
-- =========================================================

CREATE TABLE integration.idempotency_keys (
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash_sha256 text NOT NULL,
    actor_key text,
    correlation_id text,
    status text NOT NULL DEFAULT 'PROCESSING',
    response_status_code integer,
    response_body jsonb,
    locked_until timestamptz,
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (scope, idempotency_key),

    CONSTRAINT idempotency_scope_not_empty
        CHECK (length(btrim(scope)) > 0),

    CONSTRAINT idempotency_key_length
        CHECK (
            char_length(idempotency_key)
            BETWEEN 1 AND 200
        ),

    CONSTRAINT idempotency_hash_format
        CHECK (
            request_hash_sha256 ~ '^[0-9a-f]{64}$'
        ),

    CONSTRAINT idempotency_status_valid
        CHECK (
            status IN (
                'PROCESSING',
                'SUCCEEDED',
                'FAILED',
                'EXPIRED'
            )
        ),

    CONSTRAINT idempotency_response_status_valid
        CHECK (
            response_status_code IS NULL
            OR response_status_code BETWEEN 100 AND 599
        ),

    CONSTRAINT idempotency_expiry_valid
        CHECK (expires_at > created_at),

    CONSTRAINT idempotency_completed_valid
        CHECK (
            completed_at IS NULL
            OR completed_at >= created_at
        )
);

CREATE INDEX idempotency_expiry_idx
    ON integration.idempotency_keys(
        status,
        expires_at
    );

CREATE TABLE integration.outbox_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_key text NOT NULL UNIQUE,
    aggregate_schema text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_key text NOT NULL,
    aggregate_version bigint NOT NULL,
    event_type text NOT NULL,
    event_version integer NOT NULL DEFAULT 1,
    payload jsonb NOT NULL,
    headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    correlation_id text,
    causation_id text,
    status text NOT NULL DEFAULT 'PENDING',
    attempt_count integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT outbox_event_key_not_empty
        CHECK (length(btrim(event_key)) > 0),

    CONSTRAINT outbox_aggregate_version_valid
        CHECK (aggregate_version >= 0),

    CONSTRAINT outbox_event_version_valid
        CHECK (event_version > 0),

    CONSTRAINT outbox_status_valid
        CHECK (
            status IN (
                'PENDING',
                'PROCESSING',
                'PUBLISHED',
                'FAILED',
                'DEAD_LETTER'
            )
        ),

    CONSTRAINT outbox_attempt_count_valid
        CHECK (attempt_count >= 0),

    CONSTRAINT outbox_published_state_valid
        CHECK (
            published_at IS NULL
            OR status = 'PUBLISHED'
        )
);

CREATE INDEX outbox_dispatch_idx
    ON integration.outbox_events(
        available_at,
        id
    )
    WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX outbox_aggregate_idx
    ON integration.outbox_events(
        aggregate_schema,
        aggregate_type,
        aggregate_key,
        aggregate_version
    );

-- =========================================================
-- Audit and security evidence
-- =========================================================

CREATE TABLE audit.audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type text NOT NULL,
    action_code text NOT NULL,
    actor_account_key text,
    actor_person_key text,
    acting_membership_key text,
    acting_assignment_key text,
    target_schema text NOT NULL,
    target_relation text NOT NULL,
    target_key text NOT NULL,
    reason_code text,
    correlation_id text,
    request_id text,
    before_state jsonb,
    after_state jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    classification_code text NOT NULL,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT audit_target_identifier_format
        CHECK (
            target_schema ~ '^[a-z][a-z0-9_]*$'
            AND target_relation ~ '^[a-z][a-z0-9_]*$'
        )
);

CREATE INDEX audit_events_target_idx
    ON audit.audit_events(
        target_schema,
        target_relation,
        target_key,
        occurred_at DESC
    );

CREATE INDEX audit_events_correlation_idx
    ON audit.audit_events(correlation_id)
    WHERE correlation_id IS NOT NULL;

CREATE TABLE security.security_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type text NOT NULL,
    severity text NOT NULL,
    actor_account_key text,
    actor_person_key text,
    subject_key text,
    correlation_id text,
    request_id text,
    source_ip inet,
    user_agent text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT security_event_severity_valid
        CHECK (
            severity IN (
                'INFO',
                'LOW',
                'MEDIUM',
                'HIGH',
                'CRITICAL'
            )
        )
);

CREATE INDEX security_events_subject_idx
    ON security.security_events(
        subject_key,
        occurred_at DESC
    )
    WHERE subject_key IS NOT NULL;

CREATE INDEX security_events_correlation_idx
    ON security.security_events(correlation_id)
    WHERE correlation_id IS NOT NULL;

CREATE TABLE security.data_access_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_account_key text,
    actor_person_key text,
    acting_assignment_key text,
    purpose_code text NOT NULL,
    access_type text NOT NULL,
    target_schema text NOT NULL,
    target_relation text NOT NULL,
    target_key text,
    fields_accessed text[] NOT NULL DEFAULT ARRAY[]::text[],
    result_count integer,
    reason_code text,
    correlation_id text,
    request_id text,
    source_ip inet,
    retention_class_code text NOT NULL DEFAULT 'SEC'
        REFERENCES privacy.retention_classes(code),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT data_access_type_valid
        CHECK (
            access_type IN (
                'READ',
                'SEARCH',
                'EXPORT',
                'ADMIN_VIEW'
            )
        ),

    CONSTRAINT data_access_result_count_valid
        CHECK (
            result_count IS NULL
            OR result_count >= 0
        ),

    CONSTRAINT data_access_target_identifier_format
        CHECK (
            target_schema ~ '^[a-z][a-z0-9_]*$'
            AND target_relation ~ '^[a-z][a-z0-9_]*$'
        )
);

CREATE INDEX data_access_target_idx
    ON security.data_access_logs(
        target_schema,
        target_relation,
        target_key,
        occurred_at DESC
    );

-- =========================================================
-- Staging and import evidence
-- =========================================================

CREATE TABLE staging.import_batches (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_key text NOT NULL UNIQUE,
    dataset_profile_code text NOT NULL,
    environment_code text NOT NULL,
    status text NOT NULL DEFAULT 'REGISTERED',
    initiated_by text NOT NULL DEFAULT SESSION_USER,
    correlation_id text,
    expected_workbook_count integer,
    source_manifest_hash_sha256 text,
    schema_contract_version text NOT NULL,
    dictionary_version text NOT NULL,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT import_batch_profile_valid
        CHECK (
            dataset_profile_code IN (
                'REF',
                'SMK',
                'UAT',
                'NEG',
                'VOL'
            )
        ),

    CONSTRAINT import_batch_status_valid
        CHECK (
            status IN (
                'REGISTERED',
                'VALIDATING',
                'READY',
                'APPLYING',
                'SUCCEEDED',
                'FAILED',
                'CANCELLED'
            )
        ),

    CONSTRAINT import_batch_workbook_count_valid
        CHECK (
            expected_workbook_count IS NULL
            OR expected_workbook_count >= 0
        ),

    CONSTRAINT import_batch_manifest_hash_valid
        CHECK (
            source_manifest_hash_sha256 IS NULL
            OR source_manifest_hash_sha256
                ~ '^[0-9a-f]{64}$'
        ),

    CONSTRAINT import_batch_time_valid
        CHECK (
            completed_at IS NULL
            OR started_at IS NULL
            OR completed_at >= started_at
        )
);

CREATE INDEX import_batches_status_idx
    ON staging.import_batches(status, created_at DESC);

CREATE TABLE staging.import_workbooks (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id bigint NOT NULL
        REFERENCES staging.import_batches(id)
        ON DELETE RESTRICT,
    workbook_name text NOT NULL,
    workbook_version text NOT NULL,
    file_size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    expected_sheet_count integer,
    actual_sheet_count integer,
    status text NOT NULL DEFAULT 'REGISTERED',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT import_workbook_file_size_valid
        CHECK (file_size_bytes >= 0),

    CONSTRAINT import_workbook_hash_valid
        CHECK (sha256 ~ '^[0-9a-f]{64}$'),

    CONSTRAINT import_workbook_sheet_counts_valid
        CHECK (
            (expected_sheet_count IS NULL OR expected_sheet_count >= 0)
            AND
            (actual_sheet_count IS NULL OR actual_sheet_count >= 0)
        ),

    CONSTRAINT import_workbook_status_valid
        CHECK (
            status IN (
                'REGISTERED',
                'EXPORTED',
                'VALIDATING',
                'READY',
                'SUCCEEDED',
                'FAILED'
            )
        ),

    CONSTRAINT import_workbook_unique
        UNIQUE (batch_id, workbook_name)
);

CREATE TABLE staging.import_sheets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workbook_id bigint NOT NULL
        REFERENCES staging.import_workbooks(id)
        ON DELETE RESTRICT,
    sheet_name text NOT NULL,
    import_sequence integer NOT NULL,
    csv_sha256 text NOT NULL,
    source_rows integer NOT NULL DEFAULT 0,
    accepted_rows integer NOT NULL DEFAULT 0,
    rejected_rows integer NOT NULL DEFAULT 0,
    quarantined_rows integer NOT NULL DEFAULT 0,
    inserted_rows integer NOT NULL DEFAULT 0,
    updated_rows integer NOT NULL DEFAULT 0,
    unchanged_rows integer NOT NULL DEFAULT 0,
    conflict_rows integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'REGISTERED',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT import_sheet_sequence_valid
        CHECK (import_sequence >= 0),

    CONSTRAINT import_sheet_hash_valid
        CHECK (csv_sha256 ~ '^[0-9a-f]{64}$'),

    CONSTRAINT import_sheet_counts_nonnegative
        CHECK (
            source_rows >= 0
            AND accepted_rows >= 0
            AND rejected_rows >= 0
            AND quarantined_rows >= 0
            AND inserted_rows >= 0
            AND updated_rows >= 0
            AND unchanged_rows >= 0
            AND conflict_rows >= 0
        ),

    CONSTRAINT import_sheet_source_reconciliation
        CHECK (
            accepted_rows
            + rejected_rows
            + quarantined_rows
            <= source_rows
        ),

    CONSTRAINT import_sheet_target_reconciliation
        CHECK (
            inserted_rows
            + updated_rows
            + unchanged_rows
            + conflict_rows
            <= accepted_rows
        ),

    CONSTRAINT import_sheet_status_valid
        CHECK (
            status IN (
                'REGISTERED',
                'LOADED',
                'VALIDATING',
                'READY',
                'APPLYING',
                'SUCCEEDED',
                'FAILED'
            )
        ),

    CONSTRAINT import_sheet_unique
        UNIQUE (workbook_id, sheet_name)
);

CREATE TABLE staging.import_row_errors (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sheet_id bigint NOT NULL
        REFERENCES staging.import_sheets(id)
        ON DELETE RESTRICT,
    source_row_number integer NOT NULL,
    rule_code text NOT NULL,
    severity text NOT NULL,
    column_name text,
    value_fingerprint_sha256 text,
    redacted_preview text,
    message text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT import_row_number_valid
        CHECK (source_row_number > 0),

    CONSTRAINT import_error_severity_valid
        CHECK (
            severity IN (
                'INFO',
                'WARNING',
                'ERROR',
                'CRITICAL'
            )
        ),

    CONSTRAINT import_error_value_hash_valid
        CHECK (
            value_fingerprint_sha256 IS NULL
            OR value_fingerprint_sha256
                ~ '^[0-9a-f]{64}$'
        )
);

CREATE INDEX import_row_errors_sheet_idx
    ON staging.import_row_errors(
        sheet_id,
        source_row_number,
        severity
    );

CREATE TABLE staging.import_reconciliations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id bigint NOT NULL
        REFERENCES staging.import_batches(id)
        ON DELETE RESTRICT,
    scope_type text NOT NULL,
    scope_key text NOT NULL,
    metric_code text NOT NULL,
    expected_numeric numeric,
    actual_numeric numeric,
    expected_text text,
    actual_text text,
    matched boolean NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT import_reconciliation_unique
        UNIQUE (
            batch_id,
            scope_type,
            scope_key,
            metric_code
        )
);

CREATE INDEX import_reconciliation_mismatch_idx
    ON staging.import_reconciliations(batch_id)
    WHERE matched = false;

-- =========================================================
-- Privilege model
-- =========================================================

REVOKE ALL ON ALL TABLES
    IN SCHEMA privacy, access, integration, audit, security, staging
    FROM PUBLIC;

REVOKE ALL ON ALL SEQUENCES
    IN SCHEMA privacy, access, integration, audit, security, staging
    FROM PUBLIC;

REVOKE ALL ON ALL FUNCTIONS
    IN SCHEMA security
    FROM PUBLIC;

GRANT USAGE ON SCHEMA
    privacy,
    access,
    integration,
    audit,
    security
TO vind_app_runtime;

GRANT USAGE ON SCHEMA
    privacy,
    access,
    staging
TO vind_importer;

GRANT USAGE ON SCHEMA
    privacy,
    access,
    staging
TO vind_readonly;

GRANT SELECT ON
    privacy.retention_classes,
    privacy.retention_policy_versions,
    privacy.retention_assignments,
    access.roles,
    access.capabilities,
    access.role_capabilities
TO vind_app_runtime, vind_importer, vind_readonly;

GRANT INSERT, UPDATE ON
    privacy.retention_classes,
    privacy.retention_policy_versions,
    privacy.retention_assignments,
    access.roles,
    access.capabilities,
    access.role_capabilities
TO vind_importer;

GRANT USAGE, SELECT ON ALL SEQUENCES
    IN SCHEMA privacy, access
TO vind_importer;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON integration.idempotency_keys
TO vind_app_runtime;

GRANT SELECT, INSERT, UPDATE
    ON integration.outbox_events
TO vind_app_runtime;

GRANT USAGE, SELECT ON ALL SEQUENCES
    IN SCHEMA integration
TO vind_app_runtime;

GRANT INSERT ON audit.audit_events
TO vind_app_runtime;

GRANT INSERT ON
    security.security_events,
    security.data_access_logs
TO vind_app_runtime;

GRANT USAGE, SELECT ON ALL SEQUENCES
    IN SCHEMA audit, security
TO vind_app_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA staging
TO vind_importer;

GRANT USAGE, SELECT ON ALL SEQUENCES
    IN SCHEMA staging
TO vind_importer;

GRANT SELECT ON ALL TABLES
    IN SCHEMA staging
TO vind_readonly;

GRANT EXECUTE ON FUNCTION security.set_request_context(
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text
)
TO vind_app_runtime, vind_importer;

GRANT EXECUTE ON FUNCTION security.context_value(text)
TO vind_app_runtime, vind_importer;

GRANT EXECUTE ON FUNCTION security.current_request_context()
TO vind_app_runtime, vind_importer;