import { cp, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "media", "synthetic-demo");
const runtimeRoot = path.join(repoRoot, "uploads");
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));

await mkdir(runtimeRoot, { recursive: true });

for (const asset of manifest.assets) {
  const src = path.join(repoRoot, asset.fixture_file);
  const dst = path.join(repoRoot, asset.storage_path);
  const bytes = await readFile(src);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== asset.checksum_sha256) {
    throw new Error(`Checksum mismatch for ${asset.fixture_file}: expected ${asset.checksum_sha256}, got ${hash}`);
  }
  await mkdir(path.dirname(dst), { recursive: true });
  await cp(src, dst);
  console.log(`materialized ${asset.storage_path}`);
}

console.log(`Synthetic demo media ready at ${runtimeRoot}`);
