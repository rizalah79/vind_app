# SQL-first migrations

SQL migration files are the database source of truth.

Rules:

1. Do not use `prisma db push`.
2. Do not create business tables without an approved physical-schema slice.
3. Each migration must be reviewed, forward-fix ready, replay tested, and reconciled.
4. PostgreSQL-native features such as RLS, grants, PostGIS, triggers, exclusion
   constraints, audit functions, and outbox behavior must be expressed in reviewed SQL.
5. Legacy `dasar_database.xlsx` must never be imported directly.
6. Stage 1 prohibited capabilities must remain absent.