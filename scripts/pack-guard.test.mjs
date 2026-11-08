// Run with: node --test scripts/pack-guard.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, REQUIRED } from "./pack-guard.mjs";

const good = [...REQUIRED, "dist/tokenizer.js", "dist/secrets-map.js", "dist/src-map.js"];

test("a complete clean pack passes, including names that merely contain token or secret", () => {
  assert.deepEqual(check(good), { bad: [], missing: [] });
});

test("tests, helpers, src, env files and credential files are rejected", () => {
  const planted = [
    "dist/a.test.js",
    "dist/test-helpers.js",
    "src/index.ts",
    ".env",
    "dist/.env.local",
    "dist/api-token.json",
    "secret.pem",
  ];
  assert.deepEqual(check([...good, ...planted]).bad, planted);
});

test("each required file is reported when missing", () => {
  for (const name of REQUIRED) {
    assert.deepEqual(check(good.filter((p) => p !== name)).missing, [name]);
  }
});
