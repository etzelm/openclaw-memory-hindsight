import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VARIANT_NAME, variantManifest, variantPackage } from "./sidecar-variant.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("drops kind, keeps the plugin id and every other manifest field", () => {
  const manifest = JSON.parse(readFileSync(path.join(here, "..", "openclaw.plugin.json"), "utf8"));
  const variant = variantManifest(manifest);
  assert.equal("kind" in variant, false);
  assert.equal(variant.id, manifest.id);
  assert.deepEqual(variant.contracts, manifest.contracts);
  assert.deepEqual(variant.configSchema, manifest.configSchema);
  assert.match(variant.description, /never owns plugins\.slots\.memory/);
});

test("renames the package and keeps its version and entry points", () => {
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
  const variant = variantPackage(pkg);
  assert.equal(variant.name, VARIANT_NAME);
  assert.equal(variant.version, pkg.version);
  assert.deepEqual(variant.openclaw, pkg.openclaw);
});

test("rewrites an unpacked package in place", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hs-variant-"));
  try {
    writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({ id: "x", kind: "memory" }),
    );
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "a", version: "1.0.0" }));
    execFileSync(process.execPath, [path.join(here, "sidecar-variant.mjs"), dir]);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(dir, "openclaw.plugin.json"), "utf8")).kind,
      undefined,
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name,
      VARIANT_NAME,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewrites when run through a symlinked path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hs-variant-link-"));
  try {
    symlinkSync(here, path.join(dir, "scripts-link"));
    writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({ id: "x", kind: "memory" }),
    );
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "a", version: "1.0.0" }));
    execFileSync(process.execPath, [path.join(dir, "scripts-link", "sidecar-variant.mjs"), dir]);
    assert.equal(
      "kind" in JSON.parse(readFileSync(path.join(dir, "openclaw.plugin.json"), "utf8")),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
