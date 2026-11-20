#!/usr/bin/env node
// Writes openclaw.plugin.json `configSchema` and `uiHints` from src/config-schema.ts (via the
// build in dist/), keeping every other manifest field, then formats the file with oxfmt.
// Run: npm run manifest. src/config-schema.test.ts fails when the manifest is out of date.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const path = `${root}openclaw.plugin.json`;
const { CONFIG_SCHEMA, CONFIG_UI_HINTS } = await import(`${root}dist/config-schema.js`);
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.uiHints = CONFIG_UI_HINTS;
manifest.configSchema = CONFIG_SCHEMA;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
execFileSync(`${root}node_modules/.bin/oxfmt`, ["--write", path], { stdio: "inherit" });
console.log("openclaw.plugin.json: configSchema and uiHints written from src/config-schema.ts");
