-- Migration Chain Compatibility Fix for DB-DEC-021 Function Default Conflict
-- Target: Remove legacy verification.read_evidence(uuid, text) created with DEFAULT parameter in 20260809090000
-- before 20260809100000 attempts to recreate it without parameter default.
-- On existing database baselines where 20260809100000 is already recorded, this migration NO-OPs.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.vind_schema_migrations
        WHERE migration_name LIKE '%20260809100000%'
    ) THEN
        DROP FUNCTION IF EXISTS verification.read_evidence(uuid, text);
    END IF;
END
$$;
