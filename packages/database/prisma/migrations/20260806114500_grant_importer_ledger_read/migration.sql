-- Allow the approved local seed/import runner to verify
-- required migration history.
--
-- Transaction is managed by the custom migration runner.

SET search_path = pg_catalog;

GRANT SELECT
ON TABLE public.vind_schema_migrations
TO vind_importer;