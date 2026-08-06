-- Explicit SMK Slice 1 cleanup.
-- Transaction and confirmation are managed by src/seed-smk.ts.

SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';

CREATE TEMP TABLE smk_s1_account_ids
ON COMMIT DROP
AS
SELECT DISTINCT a.id
FROM identity.accounts a
JOIN identity.identity_links il
  ON il.account_id = a.id
JOIN party.persons p
  ON p.id = il.person_id
WHERE a.seed_key LIKE 'smk:s1:%'
  AND il.seed_key LIKE 'smk:s1:%'
  AND p.seed_key LIKE 'smk:s1:%'
  AND p.is_synthetic = true;

DELETE FROM access.pic_assignments pa
USING
    access.scoped_assignments sa,
    access.memberships m,
    organization.organizations o
WHERE pa.scoped_assignment_id = sa.id
  AND sa.membership_id = m.id
  AND m.organization_id = o.id
  AND pa.seed_key LIKE 'smk:s1:%'
  AND sa.seed_key LIKE 'smk:s1:%'
  AND m.seed_key LIKE 'smk:s1:%'
  AND o.seed_key LIKE 'smk:s1:%'
  AND o.is_synthetic = true;

DELETE FROM access.scoped_assignments sa
USING
    access.memberships m,
    organization.organizations o
WHERE sa.membership_id = m.id
  AND m.organization_id = o.id
  AND sa.seed_key LIKE 'smk:s1:%'
  AND m.seed_key LIKE 'smk:s1:%'
  AND o.seed_key LIKE 'smk:s1:%'
  AND o.is_synthetic = true;

DELETE FROM access.memberships m
USING
    party.persons p,
    organization.organizations o
WHERE m.person_id = p.id
  AND m.organization_id = o.id
  AND m.seed_key LIKE 'smk:s1:%'
  AND p.seed_key LIKE 'smk:s1:%'
  AND o.seed_key LIKE 'smk:s1:%'
  AND p.is_synthetic = true
  AND o.is_synthetic = true;

DELETE FROM identity.identity_links il
USING party.persons p
WHERE il.person_id = p.id
  AND il.account_id IN (
      SELECT id
      FROM smk_s1_account_ids
  )
  AND il.seed_key LIKE 'smk:s1:%'
  AND p.seed_key LIKE 'smk:s1:%'
  AND p.is_synthetic = true;

DELETE FROM identity.accounts a
WHERE a.id IN (
    SELECT id
    FROM smk_s1_account_ids
)
AND a.seed_key LIKE 'smk:s1:%';

DELETE FROM party.consumer_profiles cp
USING party.persons p
WHERE cp.person_id = p.id
  AND cp.seed_key LIKE 'smk:s1:%'
  AND p.seed_key LIKE 'smk:s1:%'
  AND cp.is_synthetic = true
  AND p.is_synthetic = true;

DELETE FROM party.contact_points cp
USING party.persons p
WHERE cp.person_id = p.id
  AND cp.seed_key LIKE 'smk:s1:%'
  AND p.seed_key LIKE 'smk:s1:%'
  AND cp.is_synthetic = true
  AND p.is_synthetic = true;

DELETE FROM party.persons p
WHERE p.seed_key LIKE 'smk:s1:%'
  AND p.is_synthetic = true;

DELETE FROM organization.workspaces w
USING organization.organizations o
WHERE w.organization_id = o.id
  AND w.seed_key LIKE 'smk:s1:%'
  AND o.seed_key LIKE 'smk:s1:%'
  AND o.is_synthetic = true;

DELETE FROM geo.locations l
USING organization.organizations o
WHERE l.organization_id = o.id
  AND l.seed_key LIKE 'smk:s1:%'
  AND o.seed_key LIKE 'smk:s1:%'
  AND l.is_synthetic = true
  AND o.is_synthetic = true;

DELETE FROM organization.organizations o
WHERE o.seed_key LIKE 'smk:s1:%'
  AND o.is_synthetic = true;