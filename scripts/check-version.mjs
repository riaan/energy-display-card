// Usage: node scripts/check-version.mjs vX.Y.Z
// Fails when the release tag differs from VERSION in dist/energy-display-card.js
// or when CHANGELOG.md has no section for that version.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] || process.env.TAG;
if (!tag) {
  console.error("Usage: node scripts/check-version.mjs vX.Y.Z");
  process.exit(2);
}
const version = tag.replace(/^v/, "");

const js = readFileSync(join(root, "dist", "energy-display-card.js"), "utf8");
const m = js.match(/const VERSION = "([^"]+)"/);
if (!m) {
  console.error('Could not find `const VERSION = "..."` in dist/energy-display-card.js');
  process.exit(1);
}

const errors = [];
if (m[1] !== version) errors.push(`Tag "${tag}" (${version}) does not match VERSION "${m[1]}" in dist/energy-display-card.js`);

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^##\\s*\\[?${escaped}\\]?(\\s|$)`, "m").test(changelog)) errors.push(`CHANGELOG.md has no section for ${version}`);

if (errors.length) {
  errors.forEach((e) => console.error(`✗ ${e}`));
  process.exit(1);
}
console.log(`✓ ${tag} matches VERSION and CHANGELOG.md`);
