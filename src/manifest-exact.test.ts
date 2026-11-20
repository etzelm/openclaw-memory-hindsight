import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA, CONFIG_UI_HINTS } from "./config-schema.js";

// Fable 5.2 review of 0.10.0. P3-6: toEqual ignores key order, so the drift check also compares
// the serialized JSON, which is what scripts/gen-manifest.mjs writes (before oxfmt, which only
// changes whitespace and is covered by format:check). P3-4: dist/config-schema.js stays out of
// the package because no shipped module loads it.

const manifestText = (): string =>
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8");

describe("manifest matches the generator exactly (P3-6)", () => {
  it("configSchema and uiHints serialize to the same JSON, key order included", () => {
    const manifest = JSON.parse(manifestText()) as Record<string, unknown>;
    expect(JSON.stringify(manifest.configSchema)).toBe(JSON.stringify(CONFIG_SCHEMA));
    expect(JSON.stringify(manifest.uiHints)).toBe(JSON.stringify(CONFIG_UI_HINTS));
  });

  it("regenerating the manifest would not change it apart from whitespace", () => {
    const manifest = JSON.parse(manifestText()) as Record<string, unknown>;
    const regenerated = { ...manifest };
    regenerated.uiHints = CONFIG_UI_HINTS;
    regenerated.configSchema = CONFIG_SCHEMA;
    expect(JSON.stringify(regenerated)).toBe(JSON.stringify(manifest));
  });

  it("detects a reordered manifest that toEqual accepts", () => {
    const manifest = JSON.parse(manifestText()) as { configSchema: { properties: object } };
    const reordered = Object.fromEntries(
      Object.entries(manifest.configSchema.properties).toReversed(),
    );
    const drifted = { ...manifest.configSchema, properties: reordered };
    expect(drifted).toEqual(CONFIG_SCHEMA);
    expect(JSON.stringify(drifted)).not.toBe(JSON.stringify(CONFIG_SCHEMA));
  });
});

describe("dist/config-schema.js is not shipped (P3-4)", () => {
  it("is excluded by the package files list", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toContain("!dist/config-schema.js");
  });

  it("is imported by no shipped source module", () => {
    const dir = new URL("./", import.meta.url);
    const importers = readdirSync(dir).filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        name !== "test-helpers.ts" &&
        name !== "config-schema.ts" &&
        readFileSync(new URL(name, dir), "utf8").includes("config-schema"),
    );
    expect(importers).toEqual([]);
  });
});
