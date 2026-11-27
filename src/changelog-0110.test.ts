import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const section = changelog.split(/^## 0\.11\.0 /m)[1]?.split(/^## /m)[0] ?? "";
const part = (name: string) => section.split(`### ${name}\n`)[1]?.split(/^### /m)[0] ?? "";
const oneLine = (text: string) => text.replace(/\s+/g, " ");

describe("CHANGELOG 0.11.0 (release prep)", () => {
  it("has a dated 0.11.0 heading and no Unreleased section below it", () => {
    expect(changelog).toMatch(/^## 0\.11\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
    // Work after the release goes in an Unreleased section above 0.11.0, never inside it.
    expect(changelog.split(/^## 0\.11\.0 /m)[1]).not.toMatch(/^## Unreleased/m);
  });

  // allowMetrics is a plugin entry key, not plugin config: the notes must keep the host
  // requirement and the "as of" check of which OpenClaw releases carry it.
  it("keeps the allowMetrics upgrade notes with a dated host check", () => {
    const notes = oneLine(part("Upgrade notes"));
    expect(notes).toContain("openclaw/openclaw#198455 (merge commit `bd1c54cf`)");
    expect(notes).toMatch(/As of \d{4}-\d{2}-\d{2} no OpenClaw release contains it/);
    expect(notes).toContain('Unrecognized key: "allowMetrics"');
    expect(notes).toContain("`diagnostics-prometheus`");
  });
});
