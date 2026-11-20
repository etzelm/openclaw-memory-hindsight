import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA, CONFIG_UI_HINTS } from "./config-schema.js";
import { AGENT_OVERRIDE_KEYS, CONFIG_KEYS } from "./config.js";

type Manifest = {
  configSchema: { properties: Record<string, unknown> } & Record<string, unknown>;
  uiHints: Record<string, unknown>;
};

const manifest = (): Manifest =>
  JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as Manifest;

// src/config-schema.ts is the one source; openclaw.plugin.json is generated from it with
// `npm run manifest`. These fail when someone edits one side only.
describe("one config schema source", () => {
  it("openclaw.plugin.json configSchema is the generated one (run npm run manifest)", () => {
    expect(manifest().configSchema).toEqual(CONFIG_SCHEMA);
  });

  it("openclaw.plugin.json uiHints are the generated ones (run npm run manifest)", () => {
    expect(manifest().uiHints).toEqual(CONFIG_UI_HINTS);
  });

  it("covers exactly the keys the config parser accepts, in the same order as the hints", () => {
    const keys = Object.keys(CONFIG_SCHEMA.properties);
    expect(keys.toSorted()).toEqual([...CONFIG_KEYS].toSorted());
    expect(Object.keys(CONFIG_UI_HINTS)).toEqual(keys);
  });

  it("allows exactly the agent override keys in an agents entry", () => {
    const entry = CONFIG_SCHEMA.properties.agents.additionalProperties;
    expect(Object.keys(entry.properties)).toEqual([...AGENT_OVERRIDE_KEYS]);
    expect(entry.additionalProperties).toBe(false);
  });

  it("detects drift: a changed bound in the manifest no longer matches", () => {
    const drifted = manifest();
    (drifted.configSchema.properties.recallTopK as { maximum: number }).maximum = 51;
    expect(drifted.configSchema).not.toEqual(CONFIG_SCHEMA);
  });
});
