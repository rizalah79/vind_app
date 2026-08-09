-- SMK Slice 2 (DB-DEC-021 Integrated Synthetic Demo Dataset)
SET search_path = pg_catalog;
SET LOCAL timezone TO 'UTC';

SELECT set_config('vind.command_execution_active', 'on', false);

-- ============================================================================
-- 1. Ensure Channels Exist (Vindzam & Vindloka)
-- ============================================================================

INSERT INTO listing.channels (seed_key, code, display_name, status, retention_class_code)
VALUES
  ('smk:s2:channel:vindzam', 'VINDZAM', 'Vindzam SuperApp Channel', 'ACTIVE', 'OPS'),
  ('smk:s2:channel:vindloka', 'VINDLOKA', 'Vindloka Merchant Portal', 'ACTIVE', 'OPS')
ON CONFLICT (code) DO UPDATE SET status = EXCLUDED.status;

-- ============================================================================
-- 2. Synthetic Organizations (~10 orgs) & Workspaces
-- ============================================================================

INSERT INTO organization.organizations (seed_key, legal_name, display_name, organization_type, is_synthetic, status, data_origin_code, retention_class_code)
VALUES
  ('smk:s2:org:alpha', 'PT Alpha Rental Indonesia', 'Alpha Mobility', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:beta', 'CV Beta Transport Express', 'Beta Express', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:gamma', 'PT Gamma Tour & Travel', 'Gamma Vacations', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:delta', 'PT Delta Logistics Nusantara', 'Delta Cargo', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:epsilon', 'PT Epsilon Villa & Resort', 'Epsilon Sanctuary', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:zeta', 'CV Zeta Mobility Solutions', 'Zeta Rent', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:eta', 'PT Eta Premium Services', 'Eta Exec Services', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:theta', 'PT Theta Heavy Equipment', 'Theta Machinery', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:iota', 'PT Iota Marine & Charter', 'Iota Yachting', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS'),
  ('smk:s2:org:kappa', 'PT Kappa Event & Sound', 'Kappa Production', 'SYNTHETIC_DEMO', true, 'ACTIVE', 'SYNTHETIC_DEMO', 'OPS')
ON CONFLICT (seed_key) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO organization.workspaces (seed_key, organization_id, code, display_name, status, retention_class_code)
SELECT 'smk:s2:ws:alpha_main', o.id, 'WS-ALPHA-HQ', 'Alpha HQ Workspace', 'ACTIVE', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:alpha' UNION ALL
SELECT 'smk:s2:ws:beta_main', o.id, 'WS-BETA-HQ', 'Beta HQ Workspace', 'ACTIVE', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:beta' UNION ALL
SELECT 'smk:s2:ws:gamma_main', o.id, 'WS-GAMMA-HQ', 'Gamma HQ Workspace', 'ACTIVE', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:gamma' UNION ALL
SELECT 'smk:s2:ws:delta_main', o.id, 'WS-DELTA-HQ', 'Delta HQ Workspace', 'ACTIVE', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:delta' UNION ALL
SELECT 'smk:s2:ws:epsilon_main', o.id, 'WS-EPSILON-HQ', 'Epsilon HQ Workspace', 'ACTIVE', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:epsilon'
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

-- ============================================================================
-- 3. Synthetic Persons, Accounts, Identity Links & Memberships (~16 actors)
-- ============================================================================

INSERT INTO party.persons (seed_key, legal_name, display_name, is_synthetic, contactable, status, data_origin_code, retention_class_code)
VALUES
  ('smk:s2:person:owner_alpha', 'Budi Santoso', 'Budi Alpha Owner', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:admin_alpha', 'Siti Rahma', 'Siti Alpha Admin', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:cm_alpha', 'Dewi Lestari', 'Dewi Alpha Content Mgr', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:owner_beta', 'Agus Wijaya', 'Agus Beta Owner', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:owner_gamma', 'Rina Hartati', 'Rina Gamma Owner', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:owner_delta', 'Eko Prasetyo', 'Eko Delta Owner', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:owner_epsilon', 'Maya Putri', 'Maya Epsilon Owner', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:owner_zeta', 'Hendra Kusuma', 'Hendra Zeta Owner', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:owner_eta', 'Fajar Ramadhan', 'Fajar Eta Owner', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:owner_theta', 'Bambang Utomo', 'Bambang Theta Owner', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:indiv_prov_1', 'Iwan Setiawan', 'Iwan Driver Freelance', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:indiv_prov_2', 'Nina Kurnia', 'Nina Guide Solo', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:moderator_1', 'Andi Moderasi', 'Andi Moderator Platform', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:ops_admin_1', 'Tri Operasional', 'Tri Ops Admin Platform', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:super_admin', 'Adhi Utama', 'Adhi Super Admin', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:person:outside_actor', 'Joko Outsider', 'Joko Unauthorized Actor', true, false, 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV')
ON CONFLICT (seed_key) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO identity.accounts (seed_key, account_type, status, data_origin_code, retention_class_code)
VALUES
  ('smk:s2:acc:owner_alpha', 'HUMAN', 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:acc:admin_alpha', 'HUMAN', 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:acc:cm_alpha', 'HUMAN', 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:acc:owner_beta', 'HUMAN', 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:acc:moderator_1', 'HUMAN', 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:acc:ops_admin_1', 'HUMAN', 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:acc:super_admin', 'HUMAN', 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV'),
  ('smk:s2:acc:outsider', 'HUMAN', 'ACTIVE', 'SYNTHETIC_DEMO', 'PRIV')
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

INSERT INTO identity.identity_links (seed_key, account_id, person_id, issuer, subject, assurance_level, status, is_primary, retention_class_code)
SELECT 'smk:s2:ilink:owner_alpha', a.id, p.id, 'vind:auth', 'budi.alpha', 'VERIFIED', 'ACTIVE', true, 'PRIV' FROM identity.accounts a JOIN party.persons p ON p.seed_key = 'smk:s2:person:owner_alpha' WHERE a.seed_key = 'smk:s2:acc:owner_alpha' UNION ALL
SELECT 'smk:s2:ilink:admin_alpha', a.id, p.id, 'vind:auth', 'siti.alpha', 'VERIFIED', 'ACTIVE', true, 'PRIV' FROM identity.accounts a JOIN party.persons p ON p.seed_key = 'smk:s2:person:admin_alpha' WHERE a.seed_key = 'smk:s2:acc:admin_alpha' UNION ALL
SELECT 'smk:s2:ilink:cm_alpha', a.id, p.id, 'vind:auth', 'dewi.alpha', 'VERIFIED', 'ACTIVE', true, 'PRIV' FROM identity.accounts a JOIN party.persons p ON p.seed_key = 'smk:s2:person:cm_alpha' WHERE a.seed_key = 'smk:s2:acc:cm_alpha' UNION ALL
SELECT 'smk:s2:ilink:owner_beta', a.id, p.id, 'vind:auth', 'agus.beta', 'VERIFIED', 'ACTIVE', true, 'PRIV' FROM identity.accounts a JOIN party.persons p ON p.seed_key = 'smk:s2:person:owner_beta' WHERE a.seed_key = 'smk:s2:acc:owner_beta' UNION ALL
SELECT 'smk:s2:ilink:moderator_1', a.id, p.id, 'vind:auth', 'andi.mod', 'STRONG', 'ACTIVE', true, 'PRIV' FROM identity.accounts a JOIN party.persons p ON p.seed_key = 'smk:s2:person:moderator_1' WHERE a.seed_key = 'smk:s2:acc:moderator_1' UNION ALL
SELECT 'smk:s2:ilink:ops_admin_1', a.id, p.id, 'vind:auth', 'tri.ops', 'STRONG', 'ACTIVE', true, 'PRIV' FROM identity.accounts a JOIN party.persons p ON p.seed_key = 'smk:s2:person:ops_admin_1' WHERE a.seed_key = 'smk:s2:acc:ops_admin_1' UNION ALL
SELECT 'smk:s2:ilink:super_admin', a.id, p.id, 'vind:auth', 'adhi.super', 'STRONG', 'ACTIVE', true, 'PRIV' FROM identity.accounts a JOIN party.persons p ON p.seed_key = 'smk:s2:person:super_admin' WHERE a.seed_key = 'smk:s2:acc:super_admin' UNION ALL
SELECT 'smk:s2:ilink:outsider', a.id, p.id, 'vind:auth', 'joko.out', 'BASIC', 'ACTIVE', true, 'PRIV' FROM identity.accounts a JOIN party.persons p ON p.seed_key = 'smk:s2:person:outside_actor' WHERE a.seed_key = 'smk:s2:acc:outsider'
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

INSERT INTO access.memberships (seed_key, person_id, organization_id, status, retention_class_code)
SELECT 'smk:s2:mem:owner_alpha', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:alpha' WHERE p.seed_key = 'smk:s2:person:owner_alpha' UNION ALL
SELECT 'smk:s2:mem:admin_alpha', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:alpha' WHERE p.seed_key = 'smk:s2:person:admin_alpha' UNION ALL
SELECT 'smk:s2:mem:cm_alpha', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:alpha' WHERE p.seed_key = 'smk:s2:person:cm_alpha' UNION ALL
SELECT 'smk:s2:mem:owner_beta', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:beta' WHERE p.seed_key = 'smk:s2:person:owner_beta' UNION ALL
SELECT 'smk:s2:mem:owner_gamma', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:gamma' WHERE p.seed_key = 'smk:s2:person:owner_gamma' UNION ALL
SELECT 'smk:s2:mem:owner_delta', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:delta' WHERE p.seed_key = 'smk:s2:person:owner_delta' UNION ALL
SELECT 'smk:s2:mem:owner_epsilon', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:epsilon' WHERE p.seed_key = 'smk:s2:person:owner_epsilon' UNION ALL
SELECT 'smk:s2:mem:owner_zeta', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:zeta' WHERE p.seed_key = 'smk:s2:person:owner_zeta' UNION ALL
SELECT 'smk:s2:mem:owner_eta', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:eta' WHERE p.seed_key = 'smk:s2:person:owner_eta' UNION ALL
SELECT 'smk:s2:mem:owner_theta', p.id, o.id, 'ACTIVE', 'OPS' FROM party.persons p JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:theta' WHERE p.seed_key = 'smk:s2:person:owner_theta'
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

-- ============================================================================
-- 4. Provider Profiles & Workspace Links (~14 profiles)
-- ============================================================================

INSERT INTO provider.provider_profiles (seed_key, owning_organization_id, owning_person_id, provider_type, status, legal_name, display_name, data_origin_code, retention_class_code)
SELECT 'smk:s2:prov:alpha_car', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'PT Alpha Rental Indonesia', 'Alpha Car Rental', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:alpha' UNION ALL
SELECT 'smk:s2:prov:alpha_bus', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'PT Alpha Bus Pariwisata', 'Alpha Luxury Bus', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:alpha' UNION ALL
SELECT 'smk:s2:prov:beta_van', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'CV Beta Transport Express', 'Beta Travel Van', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:beta' UNION ALL
SELECT 'smk:s2:prov:beta_draft', o.id, NULL::uuid, 'COMPANY', 'DRAFT', 'CV Beta Logistik Baru', 'Beta Draft Cargo', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:beta' UNION ALL
SELECT 'smk:s2:prov:gamma_tour', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'PT Gamma Tour & Travel', 'Gamma Island Tours', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:gamma' UNION ALL
SELECT 'smk:s2:prov:delta_cargo', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'PT Delta Logistics Nusantara', 'Delta Trucking Services', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:delta' UNION ALL
SELECT 'smk:s2:prov:epsilon_villa', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'PT Epsilon Villa & Resort', 'Epsilon Luxury Villas', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:epsilon' UNION ALL
SELECT 'smk:s2:prov:zeta_scooter', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'CV Zeta Mobility Solutions', 'Zeta Scooter Rental', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:zeta' UNION ALL
SELECT 'smk:s2:prov:eta_limo', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'PT Eta Premium Services', 'Eta Exec Services', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:eta' UNION ALL
SELECT 'smk:s2:prov:theta_crane', o.id, NULL::uuid, 'COMPANY', 'ACTIVE', 'PT Theta Heavy Equipment', 'Theta Crane & Excavator', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:theta' UNION ALL
SELECT 'smk:s2:prov:iota_yacht', o.id, NULL::uuid, 'COMPANY', 'SUSPENDED', 'PT Iota Marine & Charter', 'Iota Yacht Charters', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:iota' UNION ALL
SELECT 'smk:s2:prov:kappa_sound', o.id, NULL::uuid, 'COMPANY', 'ARCHIVED', 'PT Kappa Event & Sound', 'Kappa Stage & Lighting', 'SYNTHETIC_DEMO', 'OPS' FROM organization.organizations o WHERE o.seed_key = 'smk:s2:org:kappa' UNION ALL
SELECT 'smk:s2:prov:indiv_iwan', NULL::uuid, p.id, 'INDIVIDUAL', 'ACTIVE', 'Iwan Setiawan', 'Iwan Personal Driver', 'SYNTHETIC_DEMO', 'OPS' FROM party.persons p WHERE p.seed_key = 'smk:s2:person:indiv_prov_1' UNION ALL
SELECT 'smk:s2:prov:indiv_nina', NULL::uuid, p.id, 'INDIVIDUAL', 'ACTIVE', 'Nina Kurnia', 'Nina Licensed Local Guide', 'SYNTHETIC_DEMO', 'OPS' FROM party.persons p WHERE p.seed_key = 'smk:s2:person:indiv_prov_2'
ON CONFLICT (seed_key) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO provider.provider_workspace_links (seed_key, provider_profile_id, managing_organization_id, workspace_id, link_status)
SELECT 'smk:s2:link:alpha_car_ws', pr.id, o.id, w.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:alpha' JOIN organization.workspaces w ON w.seed_key = 'smk:s2:ws:alpha_main' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:link:beta_van_ws', pr.id, o.id, w.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN organization.organizations o ON o.seed_key = 'smk:s2:org:beta' JOIN organization.workspaces w ON w.seed_key = 'smk:s2:ws:beta_main' WHERE pr.seed_key = 'smk:s2:prov:beta_van'
ON CONFLICT (seed_key) DO UPDATE SET link_status = EXCLUDED.link_status;

INSERT INTO provider.capability_definitions (code, display_name, description, status)
VALUES
  ('CAP-CAR-RENTAL', 'Car Rental Operator', 'Authority to manage car rental fleet', 'ACTIVE'),
  ('CAP-BUS-CHARTER', 'Bus Charter Operator', 'Authority to operate tourist bus fleet', 'ACTIVE'),
  ('CAP-VILLA-STAY', 'Villa Hospitality Provider', 'Authority to manage villa accommodations', 'ACTIVE'),
  ('CAP-HEAVY-EQUIP', 'Heavy Equipment Operator', 'Authority to operate construction machinery', 'ACTIVE')
ON CONFLICT (code) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO provider.provider_capabilities (provider_profile_id, capability_definition_id, status)
SELECT pr.id, cd.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN provider.capability_definitions cd ON cd.code = 'CAP-CAR-RENTAL' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT pr.id, cd.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN provider.capability_definitions cd ON cd.code = 'CAP-BUS-CHARTER' WHERE pr.seed_key = 'smk:s2:prov:alpha_bus' UNION ALL
SELECT pr.id, cd.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN provider.capability_definitions cd ON cd.code = 'CAP-VILLA-STAY' WHERE pr.seed_key = 'smk:s2:prov:epsilon_villa' UNION ALL
SELECT pr.id, cd.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN provider.capability_definitions cd ON cd.code = 'CAP-HEAVY-EQUIP' WHERE pr.seed_key = 'smk:s2:prov:theta_crane'
ON CONFLICT (provider_profile_id, capability_definition_id) DO NOTHING;

-- ============================================================================
-- 5. Verification Cases & Restricted Evidence (~13 cases)
-- ============================================================================

INSERT INTO verification.verification_cases (seed_key, provider_profile_id, case_type, status, verified_at, expires_at)
SELECT 'smk:s2:vc:alpha_car', pr.id, 'LEGAL_ENTITY_VERIFICATION', 'APPROVED', clock_timestamp() - interval '30 days', clock_timestamp() + interval '335 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:vc:alpha_bus', pr.id, 'TRANSPORT_LICENSE_VERIFICATION', 'APPROVED', clock_timestamp() - interval '20 days', clock_timestamp() + interval '345 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_bus' UNION ALL
SELECT 'smk:s2:vc:beta_van', pr.id, 'LEGAL_ENTITY_VERIFICATION', 'APPROVED', clock_timestamp() - interval '15 days', clock_timestamp() + interval '350 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:beta_van' UNION ALL
SELECT 'smk:s2:vc:beta_draft', pr.id, 'LEGAL_ENTITY_VERIFICATION', 'SUBMITTED', NULL::timestamptz, NULL::timestamptz FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:beta_draft' UNION ALL
SELECT 'smk:s2:vc:gamma_tour', pr.id, 'TOURISM_LICENSE_VERIFICATION', 'APPROVED', clock_timestamp() - interval '10 days', clock_timestamp() + interval '355 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:gamma_tour' UNION ALL
SELECT 'smk:s2:vc:delta_cargo', pr.id, 'CARGO_PERMIT_VERIFICATION', 'APPROVED', clock_timestamp() - interval '5 days', clock_timestamp() + interval '360 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:delta_cargo' UNION ALL
SELECT 'smk:s2:vc:epsilon_villa', pr.id, 'HOTEL_LICENSE_VERIFICATION', 'APPROVED', clock_timestamp() - interval '40 days', clock_timestamp() + interval '325 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:epsilon_villa' UNION ALL
SELECT 'smk:s2:vc:zeta_scooter', pr.id, 'LEGAL_ENTITY_VERIFICATION', 'APPROVED', clock_timestamp() - interval '25 days', clock_timestamp() + interval '340 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:zeta_scooter' UNION ALL
SELECT 'smk:s2:vc:eta_limo', pr.id, 'VIP_PERMIT_VERIFICATION', 'APPROVED', clock_timestamp() - interval '12 days', clock_timestamp() + interval '353 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:eta_limo' UNION ALL
SELECT 'smk:s2:vc:theta_crane', pr.id, 'SAFETY_CERT_VERIFICATION', 'APPROVED', clock_timestamp() - interval '18 days', clock_timestamp() + interval '347 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:theta_crane' UNION ALL
SELECT 'smk:s2:vc:iota_yacht', pr.id, 'MARITIME_PERMIT_VERIFICATION', 'REJECTED', NULL::timestamptz, NULL::timestamptz FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:iota_yacht' UNION ALL
SELECT 'smk:s2:vc:indiv_iwan', pr.id, 'SIM_A_DRIVER_VERIFICATION', 'APPROVED', clock_timestamp() - interval '8 days', clock_timestamp() + interval '357 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:indiv_iwan' UNION ALL
SELECT 'smk:s2:vc:indiv_nina', pr.id, 'GUIDE_BADGE_VERIFICATION', 'APPROVED', clock_timestamp() - interval '14 days', clock_timestamp() + interval '351 days' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:indiv_nina'
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

INSERT INTO verification.verification_evidence (seed_key, verification_case_id, evidence_type, document_number_masked, storage_path_encrypted, checksum_sha256, status, retention_class_code)
SELECT 'smk:s2:ve:alpha_nib', vc.id, 'NIB', '9120************', 'vault/enc/alpha_nib.enc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ACTIVE', 'PRIV' FROM verification.verification_cases vc WHERE vc.seed_key = 'smk:s2:vc:alpha_car' UNION ALL
SELECT 'smk:s2:ve:alpha_npwp', vc.id, 'NPWP', '01.345.***.*-***.***', 'vault/enc/alpha_npwp.enc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ACTIVE', 'PRIV' FROM verification.verification_cases vc WHERE vc.seed_key = 'smk:s2:vc:alpha_car' UNION ALL
SELECT 'smk:s2:ve:beta_nib', vc.id, 'NIB', '8120************', 'vault/enc/beta_nib.enc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ACTIVE', 'PRIV' FROM verification.verification_cases vc WHERE vc.seed_key = 'smk:s2:vc:beta_van' UNION ALL
SELECT 'smk:s2:ve:gamma_siup', vc.id, 'SIUP', '503/************', 'vault/enc/gamma_siup.enc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ACTIVE', 'PRIV' FROM verification.verification_cases vc WHERE vc.seed_key = 'smk:s2:vc:gamma_tour' UNION ALL
SELECT 'smk:s2:ve:delta_permit', vc.id, 'PERMIT', 'SK-DLG-********', 'vault/enc/delta_permit.enc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ACTIVE', 'PRIV' FROM verification.verification_cases vc WHERE vc.seed_key = 'smk:s2:vc:delta_cargo' UNION ALL
SELECT 'smk:s2:ve:epsilon_hotel', vc.id, 'HOTEL_PERMIT', 'SK-EPS-********', 'vault/enc/epsilon_hotel.enc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ACTIVE', 'PRIV' FROM verification.verification_cases vc WHERE vc.seed_key = 'smk:s2:vc:epsilon_villa' UNION ALL
SELECT 'smk:s2:ve:iwan_ktp', vc.id, 'KTP', '3273************', 'vault/enc/iwan_ktp.enc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ACTIVE', 'PRIV' FROM verification.verification_cases vc WHERE vc.seed_key = 'smk:s2:vc:indiv_iwan' UNION ALL
SELECT 'smk:s2:ve:iwan_sim', vc.id, 'SIM_A', '9201************', 'vault/enc/iwan_sim.enc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ACTIVE', 'PRIV' FROM verification.verification_cases vc WHERE vc.seed_key = 'smk:s2:vc:indiv_iwan'
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

-- ============================================================================
-- 6. Catalog Offerings, Resources, Packages & Items (~12 offerings)
-- ============================================================================

INSERT INTO catalog.offerings (seed_key, provider_profile_id, offering_code, title, description, status)
SELECT 'smk:s2:offering:xenia', pr.id, 'OFF-XENIA-MPV', 'Sewa Daihatsu Xenia 2021 MPV', 'Mobil MPV 7 seater nyaman rute Jawa & Bali', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:offering:innova', pr.id, 'OFF-INNOVA-REB', 'Sewa Toyota Innova Reborn 2022', 'Premium MPV 7 seater untuk perjalanan bisnis/keluarga', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:offering:alphard', pr.id, 'OFF-ALPHARD-VIP', 'Sewa Toyota Alphard Transformer 2023', 'Luxury MPV VIP khusus wedding & VIP executive', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:offering:bus_medium', pr.id, 'OFF-BUS-MED-35', 'Sewa Medium Bus Pariwisata 35 Seat', 'Bus pariwisata AC, TV, Reclining Seat', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_bus' UNION ALL
SELECT 'smk:s2:offering:hiace', pr.id, 'OFF-HIACE-COMM', 'Sewa Toyota Hiace Commuter 15 Seat', 'Van komuter irit untuk travel grup/keluarga', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:beta_van' UNION ALL
SELECT 'smk:s2:offering:bali_tour', pr.id, 'OFF-BALI-DAYTOUR', 'Paket Day Tour Bali Selatan 10 Jam', 'Tur Kuta, Uluwatu, Pandawa + makan siang', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:gamma_tour' UNION ALL
SELECT 'smk:s2:offering:blind_van', pr.id, 'OFF-BLINDVAN-LOG', 'Sewa GranMax BlindVan Logistik', 'Armada kurir barang/logistik perkotaan', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:delta_cargo' UNION ALL
SELECT 'smk:s2:offering:villa_pool', pr.id, 'OFF-VILLA-BALI-3B', 'Sewa Villa 3 Bedroom Private Pool Seminyak', 'Luxury villa private pool dekat pantai Seminyak', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:epsilon_villa' UNION ALL
SELECT 'smk:s2:offering:nmax', pr.id, 'OFF-NMAX-SCOOTER', 'Sewa Yamaha NMAX 155cc Automatic', 'Motor matic bongsor nyaman keliling kota', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:zeta_scooter' UNION ALL
SELECT 'smk:s2:offering:camry', pr.id, 'OFF-CAMRY-SEDAN', 'Sewa Toyota Camry Hybrid VIP Sedan', 'Sedan eksekutif berkelas untuk tamu kenegaraan/VIP', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:eta_limo' UNION ALL
SELECT 'smk:s2:offering:excavator', pr.id, 'OFF-EXCAVATOR-CAT', 'Sewa Excavator Caterpillar CAT320', 'Alat berat konstruksi/proyek galian', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:theta_crane' UNION ALL
SELECT 'smk:s2:offering:iwan_driver', pr.id, 'OFF-IWAN-DRIVER', 'Jasa Supir Pribadi Profesional Harian', 'Driver berpengalaman rute Jabodetabek & Luar Kota', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:indiv_iwan'
ON CONFLICT (seed_key) DO UPDATE SET title = EXCLUDED.title;

INSERT INTO catalog.resources (seed_key, provider_profile_id, resource_code, title, resource_type, status)
SELECT 'smk:s2:res:xenia_unit1', pr.id, 'RES-XENIA-01', 'Daihatsu Xenia B 1234 ABC Silver', 'VEHICLE', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:res:innova_unit1', pr.id, 'RES-INNOVA-01', 'Toyota Innova Reborn B 5678 DEF Hitam', 'VEHICLE', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:res:alphard_unit1', pr.id, 'RES-ALPHARD-01', 'Toyota Alphard B 1 VIP Putih', 'VEHICLE', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:res:villa_unit1', pr.id, 'RES-VILLA-01', 'Villa Seminyak Suite 1', 'PROPERTY', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:epsilon_villa' UNION ALL
SELECT 'smk:s2:res:nmax_unit1', pr.id, 'RES-NMAX-01', 'Yamaha NMAX DK 9999 AB Hitam', 'VEHICLE', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:zeta_scooter'
ON CONFLICT (seed_key) DO UPDATE SET title = EXCLUDED.title;

INSERT INTO catalog.offering_resources (offering_id, resource_id, quantity)
SELECT o.id, r.id, 1 FROM catalog.offerings o JOIN catalog.resources r ON r.seed_key = 'smk:s2:res:xenia_unit1' WHERE o.seed_key = 'smk:s2:offering:xenia' UNION ALL
SELECT o.id, r.id, 1 FROM catalog.offerings o JOIN catalog.resources r ON r.seed_key = 'smk:s2:res:innova_unit1' WHERE o.seed_key = 'smk:s2:offering:innova' UNION ALL
SELECT o.id, r.id, 1 FROM catalog.offerings o JOIN catalog.resources r ON r.seed_key = 'smk:s2:res:alphard_unit1' WHERE o.seed_key = 'smk:s2:offering:alphard' UNION ALL
SELECT o.id, r.id, 1 FROM catalog.offerings o JOIN catalog.resources r ON r.seed_key = 'smk:s2:res:villa_unit1' WHERE o.seed_key = 'smk:s2:offering:villa_pool' UNION ALL
SELECT o.id, r.id, 1 FROM catalog.offerings o JOIN catalog.resources r ON r.seed_key = 'smk:s2:res:nmax_unit1' WHERE o.seed_key = 'smk:s2:offering:nmax'
ON CONFLICT (offering_id, resource_id) DO NOTHING;

INSERT INTO catalog.packages (seed_key, provider_profile_id, package_code, title, anchor_offering_id, status)
SELECT 'smk:s2:pkg:xenia_driver', pr.id, 'PKG-XENIA-DRV', 'Paket Xenia All-In + Supir + BBM 12 Jam', o.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:xenia' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:pkg:innova_vip', pr.id, 'PKG-INNOVA-VIP', 'Paket Innova Reborn Exec + Supir Jas', o.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:innova' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:pkg:villa_bbq', pr.id, 'PKG-VILLA-BBQ', 'Paket Menginap Villa 3D2N + Seafood BBQ', o.id, 'ACTIVE' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:villa_pool' WHERE pr.seed_key = 'smk:s2:prov:epsilon_villa'
ON CONFLICT (seed_key) DO UPDATE SET title = EXCLUDED.title;

INSERT INTO catalog.package_items (package_id, offering_id, quantity, is_optional)
SELECT p.id, o.id, 1, false FROM catalog.packages p JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:xenia' WHERE p.seed_key = 'smk:s2:pkg:xenia_driver' UNION ALL
SELECT p.id, o.id, 1, false FROM catalog.packages p JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:innova' WHERE p.seed_key = 'smk:s2:pkg:innova_vip' UNION ALL
SELECT p.id, o.id, 1, false FROM catalog.packages p JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:villa_pool' WHERE p.seed_key = 'smk:s2:pkg:villa_bbq'
ON CONFLICT (package_id, offering_id) DO NOTHING;

-- ============================================================================
-- 7. Geo Regions & Spatial Points (~20 spatial locations across Indonesia)
-- ============================================================================

INSERT INTO geo.regions (seed_key, region_type, country_code, code, display_name, status, retention_class_code)
VALUES
  ('smk:s2:geo:jkt_pusat', 'CITY', 'ID', 'ID-JKT-PUS', 'Jakarta Pusat', 'ACTIVE', 'REF'),
  ('smk:s2:geo:jkt_selatan', 'CITY', 'ID', 'ID-JKT-SEL', 'Jakarta Selatan', 'ACTIVE', 'REF'),
  ('smk:s2:geo:jkt_barat', 'CITY', 'ID', 'ID-JKT-BAR', 'Jakarta Barat', 'ACTIVE', 'REF'),
  ('smk:s2:geo:jkt_timur', 'CITY', 'ID', 'ID-JKT-TIM', 'Jakarta Timur', 'ACTIVE', 'REF'),
  ('smk:s2:geo:jkt_utara', 'CITY', 'ID', 'ID-JKT-UTA', 'Jakarta Utara', 'ACTIVE', 'REF'),
  ('smk:s2:geo:bandung', 'CITY', 'ID', 'ID-BDG-KTA', 'Kota Bandung', 'ACTIVE', 'REF'),
  ('smk:s2:geo:surabaya', 'CITY', 'ID', 'ID-SBY-KTA', 'Kota Surabaya', 'ACTIVE', 'REF'),
  ('smk:s2:geo:bali_badung', 'REGENCY', 'ID', 'ID-BAL-BDG', 'Badung (Kuta/Seminyak)', 'ACTIVE', 'REF'),
  ('smk:s2:geo:bali_denpasar', 'CITY', 'ID', 'ID-BAL-DPS', 'Kota Denpasar', 'ACTIVE', 'REF'),
  ('smk:s2:geo:yogyakarta', 'CITY', 'ID', 'ID-YOG-KTA', 'Kota Yogyakarta', 'ACTIVE', 'REF'),
  ('smk:s2:geo:semarang', 'CITY', 'ID', 'ID-SMG-KTA', 'Kota Semarang', 'ACTIVE', 'REF'),
  ('smk:s2:geo:medan', 'CITY', 'ID', 'ID-MDN-KTA', 'Kota Medan', 'ACTIVE', 'REF'),
  ('smk:s2:geo:makassar', 'CITY', 'ID', 'ID-MKS-KTA', 'Kota Makassar', 'ACTIVE', 'REF'),
  ('smk:s2:geo:palembang', 'CITY', 'ID', 'ID-PLM-KTA', 'Kota Palembang', 'ACTIVE', 'REF'),
  ('smk:s2:geo:balikpapan', 'CITY', 'ID', 'ID-BKP-KTA', 'Kota Balikpapan', 'ACTIVE', 'REF'),
  ('smk:s2:geo:lombok', 'REGENCY', 'ID', 'ID-LMB-BAR', 'Lombok Barat / Senggigi', 'ACTIVE', 'REF'),
  ('smk:s2:geo:manado', 'CITY', 'ID', 'ID-MND-KTA', 'Kota Manado', 'ACTIVE', 'REF'),
  ('smk:s2:geo:solo', 'CITY', 'ID', 'ID-SLO-KTA', 'Kota Surakarta / Solo', 'ACTIVE', 'REF'),
  ('smk:s2:geo:malang', 'CITY', 'ID', 'ID-MLG-KTA', 'Kota Malang', 'ACTIVE', 'REF'),
  ('smk:s2:geo:labuan_bajo', 'REGENCY', 'ID', 'ID-LBJ-MGG', 'Labuan Bajo / Manggarai Barat', 'ACTIVE', 'REF')
ON CONFLICT (seed_key) DO UPDATE SET display_name = EXCLUDED.display_name;

-- ============================================================================
-- 8. Channel Publications (~15 channel publications across Vindzam & Vindloka)
-- ============================================================================

INSERT INTO listing.channel_publications (seed_key, provider_profile_id, offering_id, package_id, channel_id, channel_code, publication_status, effective_from)
SELECT 'smk:s2:pub:xenia_zam', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '20 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:xenia' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:pub:xenia_loka', pr.id, o.id, NULL::uuid, ch.id, 'VINDLOKA', 'PUBLISHED', clock_timestamp() - interval '20 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:xenia' JOIN listing.channels ch ON ch.code = 'VINDLOKA' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:pub:innova_zam', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '15 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:innova' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:pub:alphard_zam', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '10 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:alphard' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:pub:bus_zam', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '18 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:bus_medium' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:alpha_bus' UNION ALL
SELECT 'smk:s2:pub:hiace_zam', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '14 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:hiace' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:beta_van' UNION ALL
SELECT 'smk:s2:pub:bali_tour_zam', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '8 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:bali_tour' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:gamma_tour' UNION ALL
SELECT 'smk:s2:pub:villa_zam', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '30 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:villa_pool' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:epsilon_villa' UNION ALL
SELECT 'smk:s2:pub:nmax_zam', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '22 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:nmax' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:zeta_scooter' UNION ALL
SELECT 'smk:s2:pub:camry_loka', pr.id, o.id, NULL::uuid, ch.id, 'VINDLOKA', 'PUBLISHED', clock_timestamp() - interval '11 days' FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:camry' JOIN listing.channels ch ON ch.code = 'VINDLOKA' WHERE pr.seed_key = 'smk:s2:prov:eta_limo' UNION ALL
SELECT 'smk:s2:pub:pkg_xenia_zam', pr.id, NULL::uuid, pkg.id, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '16 days' FROM provider.provider_profiles pr JOIN catalog.packages pkg ON pkg.seed_key = 'smk:s2:pkg:xenia_driver' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:pub:pkg_innova_zam', pr.id, NULL::uuid, pkg.id, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '12 days' FROM provider.provider_profiles pr JOIN catalog.packages pkg ON pkg.seed_key = 'smk:s2:pkg:innova_vip' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:pub:pkg_villa_zam', pr.id, NULL::uuid, pkg.id, ch.id, 'VINDZAM', 'PUBLISHED', clock_timestamp() - interval '25 days' FROM provider.provider_profiles pr JOIN catalog.packages pkg ON pkg.seed_key = 'smk:s2:pkg:villa_bbq' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:epsilon_villa' UNION ALL
SELECT 'smk:s2:pub:beta_draft_pub', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'DRAFT', NULL::timestamptz FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:blind_van' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:beta_draft' UNION ALL
SELECT 'smk:s2:pub:iota_suspended_pub', pr.id, o.id, NULL::uuid, ch.id, 'VINDZAM', 'SUSPENDED', NULL::timestamptz FROM provider.provider_profiles pr JOIN catalog.offerings o ON o.seed_key = 'smk:s2:offering:excavator' JOIN listing.channels ch ON ch.code = 'VINDZAM' WHERE pr.seed_key = 'smk:s2:prov:iota_yacht'
ON CONFLICT (seed_key) DO UPDATE SET publication_status = EXCLUDED.publication_status;

-- ============================================================================
-- 9. Media Assets, Media Rights & Links
-- ============================================================================

INSERT INTO media.media_assets (seed_key, owner_provider_profile_id, media_type, file_name, file_size_bytes, mime_type, checksum_sha256, storage_path, status)
SELECT 'smk:s2:media:xenia_front', pr.id, 'IMAGE', 'xenia-front.jpg', 2048576, 'image/jpeg', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'uploads/xenia_front.jpg', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:media:xenia_interior', pr.id, 'IMAGE', 'xenia-interior.jpg', 1848576, 'image/jpeg', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'uploads/xenia_interior.jpg', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:media:innova_front', pr.id, 'IMAGE', 'innova-front.jpg', 2548576, 'image/jpeg', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'uploads/innova_front.jpg', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:media:alphard_front', pr.id, 'IMAGE', 'alphard-front.jpg', 3048576, 'image/jpeg', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'uploads/alphard_front.jpg', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car' UNION ALL
SELECT 'smk:s2:media:villa_pool', pr.id, 'IMAGE', 'villa-pool.jpg', 4048576, 'image/jpeg', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'uploads/villa_pool.jpg', 'ACTIVE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:epsilon_villa' UNION ALL
SELECT 'smk:s2:media:unsafe_media', pr.id, 'IMAGE', 'suspicious.jpg', 548576, 'image/jpeg', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'uploads/suspicious.jpg', 'UNSAFE' FROM provider.provider_profiles pr WHERE pr.seed_key = 'smk:s2:prov:alpha_car'
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

INSERT INTO media.media_rights (seed_key, media_asset_id, rights_type, status, effective_from)
SELECT 'smk:s2:rights:xenia_front', ma.id, 'OWNERSHIP', 'ACTIVE', clock_timestamp() - interval '60 days' FROM media.media_assets ma WHERE ma.seed_key = 'smk:s2:media:xenia_front' UNION ALL
SELECT 'smk:s2:rights:xenia_interior', ma.id, 'OWNERSHIP', 'ACTIVE', clock_timestamp() - interval '60 days' FROM media.media_assets ma WHERE ma.seed_key = 'smk:s2:media:xenia_interior' UNION ALL
SELECT 'smk:s2:rights:innova_front', ma.id, 'OWNERSHIP', 'ACTIVE', clock_timestamp() - interval '60 days' FROM media.media_assets ma WHERE ma.seed_key = 'smk:s2:media:innova_front' UNION ALL
SELECT 'smk:s2:rights:alphard_front', ma.id, 'OWNERSHIP', 'ACTIVE', clock_timestamp() - interval '60 days' FROM media.media_assets ma WHERE ma.seed_key = 'smk:s2:media:alphard_front' UNION ALL
SELECT 'smk:s2:rights:villa_pool', ma.id, 'OWNERSHIP', 'ACTIVE', clock_timestamp() - interval '60 days' FROM media.media_assets ma WHERE ma.seed_key = 'smk:s2:media:villa_pool'
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

INSERT INTO media.media_links (seed_key, media_asset_id, channel_publication_id, link_role, link_status)
SELECT 'smk:s2:mlink:xenia_pub_front', ma.id, cp.id, 'PUBLIC_LISTING', 'ACTIVE' FROM media.media_assets ma JOIN listing.channel_publications cp ON cp.seed_key = 'smk:s2:pub:xenia_zam' WHERE ma.seed_key = 'smk:s2:media:xenia_front' UNION ALL
SELECT 'smk:s2:mlink:xenia_pub_int', ma.id, cp.id, 'PUBLIC_LISTING', 'ACTIVE' FROM media.media_assets ma JOIN listing.channel_publications cp ON cp.seed_key = 'smk:s2:pub:xenia_zam' WHERE ma.seed_key = 'smk:s2:media:xenia_interior' UNION ALL
SELECT 'smk:s2:mlink:innova_pub_front', ma.id, cp.id, 'PUBLIC_LISTING', 'ACTIVE' FROM media.media_assets ma JOIN listing.channel_publications cp ON cp.seed_key = 'smk:s2:pub:innova_zam' WHERE ma.seed_key = 'smk:s2:media:innova_front' UNION ALL
SELECT 'smk:s2:mlink:alphard_pub_front', ma.id, cp.id, 'PUBLIC_LISTING', 'ACTIVE' FROM media.media_assets ma JOIN listing.channel_publications cp ON cp.seed_key = 'smk:s2:pub:alphard_zam' WHERE ma.seed_key = 'smk:s2:media:alphard_front' UNION ALL
SELECT 'smk:s2:mlink:villa_pub_pool', ma.id, cp.id, 'PUBLIC_LISTING', 'ACTIVE' FROM media.media_assets ma JOIN listing.channel_publications cp ON cp.seed_key = 'smk:s2:pub:villa_zam' WHERE ma.seed_key = 'smk:s2:media:villa_pool'
ON CONFLICT (seed_key) DO UPDATE SET link_status = EXCLUDED.link_status;

-- ============================================================================
-- 10. Access Control Scoped Assignments (with PROVIDER Scope Activation)
-- ============================================================================

INSERT INTO access.scoped_assignments (
  seed_key, subject_person_id, membership_id, role_code, scope_type, organization_id, workspace_id, provider_id, status, retention_class_code
)
SELECT 'smk:s2:assign:budi_alpha_owner', p.id, m.id, 'OWNER', 'PROVIDER', NULL::uuid, NULL::uuid, pr.id, 'ACTIVE', 'PRIV' FROM party.persons p JOIN access.memberships m ON m.seed_key = 'smk:s2:mem:owner_alpha' JOIN provider.provider_profiles pr ON pr.seed_key = 'smk:s2:prov:alpha_car' WHERE p.seed_key = 'smk:s2:person:owner_alpha' UNION ALL
SELECT 'smk:s2:assign:siti_alpha_admin', p.id, m.id, 'ADMIN', 'PROVIDER', NULL::uuid, NULL::uuid, pr.id, 'ACTIVE', 'PRIV' FROM party.persons p JOIN access.memberships m ON m.seed_key = 'smk:s2:mem:admin_alpha' JOIN provider.provider_profiles pr ON pr.seed_key = 'smk:s2:prov:alpha_car' WHERE p.seed_key = 'smk:s2:person:admin_alpha' UNION ALL
SELECT 'smk:s2:assign:dewi_alpha_cm', p.id, m.id, 'CONTENT_MANAGER', 'PROVIDER', NULL::uuid, NULL::uuid, pr.id, 'ACTIVE', 'PRIV' FROM party.persons p JOIN access.memberships m ON m.seed_key = 'smk:s2:mem:cm_alpha' JOIN provider.provider_profiles pr ON pr.seed_key = 'smk:s2:prov:alpha_car' WHERE p.seed_key = 'smk:s2:person:cm_alpha' UNION ALL
SELECT 'smk:s2:assign:agus_beta_owner', p.id, m.id, 'OWNER', 'PROVIDER', NULL::uuid, NULL::uuid, pr.id, 'ACTIVE', 'PRIV' FROM party.persons p JOIN access.memberships m ON m.seed_key = 'smk:s2:mem:owner_beta' JOIN provider.provider_profiles pr ON pr.seed_key = 'smk:s2:prov:beta_van' WHERE p.seed_key = 'smk:s2:person:owner_beta' UNION ALL
SELECT 'smk:s2:assign:iwan_indiv_owner', p.id, NULL::uuid, 'OWNER', 'PROVIDER', NULL::uuid, NULL::uuid, pr.id, 'ACTIVE', 'PRIV' FROM party.persons p JOIN provider.provider_profiles pr ON pr.seed_key = 'smk:s2:prov:indiv_iwan' WHERE p.seed_key = 'smk:s2:person:indiv_prov_1'
ON CONFLICT (seed_key) DO UPDATE SET status = EXCLUDED.status;

-- Platform Assignments for Moderator & Operations Admin & Super Admin
INSERT INTO access.platform_assignments (
  assignment_key, subject_person_id, role_code, assignment_mode, reason_code, effective_from, effective_to, approved_by_person_id, approval_reference, status, retention_class_code
)
SELECT 'smk:s2:passign:mod_1', p.id, 'MODERATOR', 'ROUTINE', 'SYSTEM_BOOTSTRAP', clock_timestamp() - interval '30 days', NULL::timestamptz, NULL::uuid, NULL::text, 'ACTIVE', 'PRIV' FROM party.persons p WHERE p.seed_key = 'smk:s2:person:moderator_1' UNION ALL
SELECT 'smk:s2:passign:ops_1', p.id, 'OPERATIONS_ADMIN', 'ROUTINE', 'SYSTEM_BOOTSTRAP', clock_timestamp() - interval '30 days', NULL::timestamptz, NULL::uuid, NULL::text, 'ACTIVE', 'PRIV' FROM party.persons p WHERE p.seed_key = 'smk:s2:person:ops_admin_1' UNION ALL
SELECT 'smk:s2:passign:super_admin', p1.id, 'SUPER_ADMIN', 'BREAK_GLASS', 'BREAK_GLASS_AUTHORIZED', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '23 hours', p2.id, 'INC-2026-0808-BG', 'ACTIVE', 'PRIV' FROM party.persons p1 JOIN party.persons p2 ON p2.seed_key = 'smk:s2:person:ops_admin_1' WHERE p1.seed_key = 'smk:s2:person:super_admin'
ON CONFLICT (assignment_key) DO UPDATE SET status = EXCLUDED.status;
