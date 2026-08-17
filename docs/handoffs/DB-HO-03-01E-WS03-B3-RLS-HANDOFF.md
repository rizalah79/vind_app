# DB-HO-03-01E → WS03 B3 Test Harness Handoff

## TITLE
DB-HO-03-01E → WS03 B3 Test Harness Handoff

## PROBLEM
`apps/api/src/b3-real-db-acceptance.test.ts` currently executes raw `migration.sql` files directly in its test `before()` setup hook using `ownerClient` (`vind_db_owner`). Because `b3-real-db-acceptance.test.ts` bypassed the canonical migration runner (`packages/database/src/migrate.ts`), it duplicated legacy replay compatibility logic and locally introduced post-migration `NO FORCE ROW LEVEL SECURITY` calls on application tables (`provider_profiles`, `provider_workspace_links`, `channel_publications`, `offerings`, `packages`).

Those ad-hoc `NO FORCE RLS` overrides must NOT become part of the canonical test or application security pattern.

## DB FIX (WS02 COMPLETE)
In DB-HO-03-01E forward-fix migration `20260817000000_db_ho_03_01e_security_definer_force_rls_forward_fix`, WS02 aligned all 5 DB-HO-03-01 `SECURITY DEFINER` functions to `SET row_security = on`:
1. `listing.read_public_listings(text, uuid, timestamptz, uuid, integer)`
2. `listing.read_public_listing(uuid, text)`
3. `provider.read_public_provider(uuid, text)`
4. `access.has_local_provider_catalog_read(uuid, timestamptz)`
5. `access.has_local_tenant_provider_read(uuid, timestamptz)`

This makes all DB-HO-03-01 functions fully compatible with:
- `FORCE ROW LEVEL SECURITY = true` on all application tables.
- `vind_db_owner = NOBYPASSRLS`.
- `row_security = on` execution under owner policies.

## WS03 REQUIRED CHANGE
Refactor `apps/api/src/b3-real-db-acceptance.test.ts` (or the shared API test harness) to invoke the canonical migration runner (`packages/database/src/migrate.ts` / `npm --workspace @vind/database run migrate`) for database setup rather than manually parsing and executing raw `migration.sql` files.

## WS03 MUST NOT
- Duplicate 03-01B replay compatibility logic inside test setup.
- Execute `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` on application tables.
- Grant `BYPASSRLS` to any role.
- Weaken canonical RLS policies.

## WS03 ACCEPTANCE
- Fresh database setup uses the canonical migration path (`migrate.ts`).
- B3 API acceptance suite passes 19/19 tests.
- Before, during, and after B3 test execution, all application tables retain `FORCE ROW LEVEL SECURITY = true`:
  - `provider.provider_profiles`
  - `provider.provider_workspace_links`
  - `listing.channel_publications`
  - `catalog.offerings`
  - `catalog.packages`
  - `media.media_derivatives`
- `NOBYPASSRLS` remains `true` for `vind_db_owner` and `vind_migrator`.
- No Request Context V2 or public discovery regressions occur.

## DEPENDENCY
WS03 should consume `DB-HO-03-01E` (`20260817000000_db_ho_03_01e_security_definer_force_rls_forward_fix`) after Control Tower approval and merge.

## CURRENT LOCAL API FILE NOTE
`apps/api/src/b3-real-db-acceptance.test.ts` has an unapproved working-tree modification from earlier investigation. That diff is NOT included in the WS02 scope, is NOT staged, and MUST be refactored by WS03 under this handoff specification.
