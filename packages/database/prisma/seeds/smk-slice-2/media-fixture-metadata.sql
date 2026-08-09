-- SYNTHETIC_DEMO media fixture metadata overlay
-- Keeps schema frozen; updates only deterministic dummy media metadata to match committed fixtures.
SET search_path = pg_catalog;

UPDATE media.media_assets SET file_name = 'xenia_front.jpg', file_size_bytes = 54111, mime_type = 'image/jpeg', checksum_sha256 = '60497f9fecf066680463f9ab6b8f72e1a68a314d660db9d70a89eb5fe12a3514', storage_path = 'uploads/xenia_front.jpg' WHERE seed_key = 'smk:s2:media:xenia_front';
UPDATE media.media_assets SET file_name = 'xenia_interior.jpg', file_size_bytes = 52229, mime_type = 'image/jpeg', checksum_sha256 = '51f96bdefa2563af48c0756f58900c5fedd9e58b63a8e22fddb8a733a0470618', storage_path = 'uploads/xenia_interior.jpg' WHERE seed_key = 'smk:s2:media:xenia_interior';
UPDATE media.media_assets SET file_name = 'innova_front.jpg', file_size_bytes = 52256, mime_type = 'image/jpeg', checksum_sha256 = '7d0c03251955c836c7c395e7f4f6f64d340369458263dfa07d46d5b318a9ab28', storage_path = 'uploads/innova_front.jpg' WHERE seed_key = 'smk:s2:media:innova_front';
UPDATE media.media_assets SET file_name = 'alphard_front.jpg', file_size_bytes = 51396, mime_type = 'image/jpeg', checksum_sha256 = '9336bb22de7230c029f78d6b4168563776c601e26fd8c135802742a220d737c1', storage_path = 'uploads/alphard_front.jpg' WHERE seed_key = 'smk:s2:media:alphard_front';
UPDATE media.media_assets SET file_name = 'villa_pool.jpg', file_size_bytes = 62883, mime_type = 'image/jpeg', checksum_sha256 = 'e679f7a79c798251fc73eb3e7ef66630e40ee6db75d7c64358a38b330ad8becf', storage_path = 'uploads/villa_pool.jpg' WHERE seed_key = 'smk:s2:media:villa_pool';
UPDATE media.media_assets SET file_name = 'suspicious.jpg', file_size_bytes = 50868, mime_type = 'image/jpeg', checksum_sha256 = 'b2353fcb9efa751a191ad304f7edb6404c7d51bf00f956b965f07f1ac857fc60', storage_path = 'uploads/suspicious.jpg' WHERE seed_key = 'smk:s2:media:unsafe_media';
