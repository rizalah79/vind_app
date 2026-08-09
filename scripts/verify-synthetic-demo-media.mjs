import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "media", "synthetic-demo");
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));

let failed = 0;
for (const asset of manifest.assets) {
  const fixturePath = path.join(repoRoot, asset.fixture_file);
  const runtimePath = path.join(repoRoot, asset.storage_path);

  const fixtureBytes = await readFile(fixturePath);
  const fixtureHash = createHash("sha256").update(fixtureBytes).digest("hex");
  if (fixtureHash !== asset.checksum_sha256 || fixtureBytes.length !== asset.file_size_bytes) {
    failed++;
    console.error(`fixture mismatch: ${asset.fixture_file}`);
  }

  try {
    const runtimeBytes = await readFile(runtimePath);
    const runtimeHash = createHash("sha256").update(runtimeBytes).digest("hex");
    if (runtimeHash !== asset.checksum_sha256) {
      failed++;
      console.error(`runtime mismatch: ${asset.storage_path}`);
    }
  } catch {
    failed++;
    console.error(`runtime missing: ${asset.storage_path}`);
  }
}

if (failed) {
  throw new Error(`Synthetic demo media verification failed: ${failed} issue(s)`);
}
console.log(`Synthetic demo media verification PASSED (${manifest.assets.length}/${manifest.assets.length})`);
