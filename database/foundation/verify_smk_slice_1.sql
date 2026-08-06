\set ON_ERROR_STOP on

SELECT
    'organizations' AS entity,
    count(*) AS row_count
FROM organization.organizations
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'workspaces',
    count(*)
FROM organization.workspaces
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'locations',
    count(*)
FROM geo.locations
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'persons',
    count(*)
FROM party.persons
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'contact_points',
    count(*)
FROM party.contact_points
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'consumer_profiles',
    count(*)
FROM party.consumer_profiles
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'accounts',
    count(*)
FROM identity.accounts
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'identity_links',
    count(*)
FROM identity.identity_links
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'memberships',
    count(*)
FROM access.memberships
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'scoped_assignments',
    count(*)
FROM access.scoped_assignments
WHERE seed_key LIKE 'smk:s1:%'

UNION ALL

SELECT
    'pic_assignments',
    count(*)
FROM access.pic_assignments
WHERE seed_key LIKE 'smk:s1:%'

ORDER BY entity;

SELECT
    count(*) FILTER (
        WHERE is_synthetic = false
           OR contactable = true
    ) AS invalid_persons
FROM party.persons
WHERE seed_key LIKE 'smk:s1:%';

SELECT
    count(*) FILTER (
        WHERE is_synthetic = false
           OR organization_type <> 'SYNTHETIC_DEMO'
    ) AS invalid_organizations
FROM organization.organizations
WHERE seed_key LIKE 'smk:s1:%';

SELECT
    count(*) FILTER (
        WHERE is_synthetic = false
           OR contactable = true
           OR (
               contact_type = 'EMAIL'
               AND normalized_value NOT LIKE '%.invalid'
           )
           OR (
               contact_type = 'PHONE'
               AND normalized_value NOT LIKE 'otp-sim:%'
           )
    ) AS invalid_contact_points
FROM party.contact_points
WHERE seed_key LIKE 'smk:s1:%';

SELECT
    o.seed_key AS organization_key,
    count(DISTINCT w.id) AS workspace_count,
    count(DISTINCT l.id) AS location_count,
    count(DISTINCT m.id) AS membership_count,
    count(DISTINCT sa.id) AS assignment_count,
    count(DISTINCT pa.id) AS pic_count
FROM organization.organizations o
LEFT JOIN organization.workspaces w
  ON w.organization_id = o.id
 AND w.seed_key LIKE 'smk:s1:%'
LEFT JOIN geo.locations l
  ON l.organization_id = o.id
 AND l.seed_key LIKE 'smk:s1:%'
LEFT JOIN access.memberships m
  ON m.organization_id = o.id
 AND m.seed_key LIKE 'smk:s1:%'
LEFT JOIN access.scoped_assignments sa
  ON sa.organization_id = o.id
 AND sa.seed_key LIKE 'smk:s1:%'
LEFT JOIN access.pic_assignments pa
  ON pa.scoped_assignment_id = sa.id
 AND pa.seed_key LIKE 'smk:s1:%'
WHERE o.seed_key LIKE 'smk:s1:%'
GROUP BY o.seed_key
ORDER BY o.seed_key;

SELECT
    code,
    status
FROM listing.channels
WHERE code IN ('VINDZAM', 'VINDLOKA')
ORDER BY code;