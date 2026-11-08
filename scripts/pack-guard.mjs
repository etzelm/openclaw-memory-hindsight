// Fails when an `npm pack --json` file list carries tests, helpers or local state,
// or when a file every release needs is missing from the pack.
// Usage: node scripts/pack-guard.mjs pack.json
import { readFileSync } from "node:fs";

// Match whole path segments, so names like tokenizer.js or src-map.js are not rejected.
// Secret-like names only count when they carry a key/credential extension.
export const FORBIDDEN =
  /(^|\/)[^/]*\.test\.|(^|\/)test-helpers|^src\/|(^|\/)\.env|(^|\/)[^/]*(secret|token)[^/]*\.(json|txt|key|pem)$/i;

export const REQUIRED = [
  "CHANGELOG.md",
  "README.md",
  "LICENSE",
  "openclaw.plugin.json",
  "package.json",
  "dist/index.js",
];

export function check(files) {
  return {
    bad: files.filter((p) => FORBIDDEN.test(p)),
    missing: REQUIRED.filter((p) => !files.includes(p)),
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const [report] = process.argv.slice(2);
  if (!report) {
    console.error("usage: node scripts/pack-guard.mjs <npm-pack.json>");
    process.exit(2);
  }
  const files = JSON.parse(readFileSync(report, "utf8"))[0].files.map((f) => f.path);
  console.log(files.join("\n"));
  const { bad, missing } = check(files);
  if (bad.length) console.error("forbidden in pack:", bad);
  if (missing.length) console.error("missing from pack:", missing);
  if (bad.length || missing.length) process.exit(1);
}
