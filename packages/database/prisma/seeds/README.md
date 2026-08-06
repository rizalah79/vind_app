# Database seed profiles

Seed data is not a schema migration.

## SMK Slice 1

Purpose:

- local smoke testing;
- Prisma client testing;
- positive and negative RLS testing;
- deterministic development fixtures.

Safety rules:

1. The runner only accepts database `vind_app_dev`.
2. The runner only accepts localhost on port `5433`.
3. Apply and cleanup use `vind_importer`.
4. Runtime RLS verification uses `vind_app_runtime`.
5. All owned fixture keys use prefix `smk:s1:`.
6. Persons, contact points, organizations, and locations are synthetic.
7. Synthetic email addresses use `.invalid`.
8. Synthetic phone identifiers use `otp-sim:`.
9. Cleanup requires `--confirm-smk-cleanup`.
10. Canonical channels, retention classes, roles, and capabilities are never deleted.