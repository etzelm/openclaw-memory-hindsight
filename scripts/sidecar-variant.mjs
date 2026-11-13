// Turns a packed plugin directory into the sidecar variant: the same code under the same plugin id,
// with no `kind` in openclaw.plugin.json, so a host that keeps a non-owner `kind: "memory"` plugin
// disabled (every release through 2026.11.x) loads it beside memory-core like any other plugin.
// The variant can never own plugins.slots.memory. Testing only (compat matrix sidecar lane): it
// is not published and not an install route; users need a host with openclaw#198445.
//
// Usage: node scripts/sidecar-variant.mjs <unpacked package dir>
//   Rewrites <dir>/openclaw.plugin.json and <dir>/package.json in place.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VARIANT_NAME = "@etzelm/openclaw-hindsight-sidecar";
export const VARIANT_NOTE =
  "Sidecar build: runs beside memory-core and never owns plugins.slots.memory.";

export function variantManifest(manifest) {
  const { kind: _kind, ...rest } = manifest;
  return {
    ...rest,
    description: `${String(manifest.description ?? "").trim()} ${VARIANT_NOTE}`.trim(),
  };
}

export function variantPackage(pkg) {
  return {
    ...pkg,
    name: VARIANT_NAME,
    description: `${String(pkg.description ?? "").trim()} ${VARIANT_NOTE}`.trim(),
  };
}

function rewrite(file, transform) {
  const before = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify(transform(before), null, 2)}\n`);
}

// Real paths on both sides: run through a symlinked dir, argv[1] and import.meta.url differ.
const invokedDirectly =
  Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: node scripts/sidecar-variant.mjs <unpacked package dir>");
    process.exit(2);
  }
  rewrite(path.join(dir, "openclaw.plugin.json"), variantManifest);
  rewrite(path.join(dir, "package.json"), variantPackage);
  console.log(`sidecar variant written in ${dir}`);
}
