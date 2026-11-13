import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const section = changelog.split(/^## 0\.9\.0 /m)[1]!.split(/^## /m)[0]!;
const part = (name: string) => section.split(`### ${name}\n`)[1]?.split(/^### /m)[0] ?? "";
/** Paragraph-level bullets of one part, each joined to one line. */
const bullets = (text: string) =>
  text
    .split(/\n(?=- )/)
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.startsWith("- "));

/** Every config key 0.9.0 adds over 0.8.0, with its default as the CHANGELOG writes it. */
const NEW_KEYS: Record<string, string> = {
  memoryPromptSection: "`false`",
  agents: "`{}`",
  recallEarlyStart: "`false`",
  recallStaleOnTimeout: "`0`",
  recallSkipEntities: "`true`",
};

describe("CHANGELOG 0.9.0 (release prep)", () => {
  // Only a dated heading: the date may move with the soak (RELEASING.md), and the tag build's
  // release-metadata.test.ts checks that it is within the tag window.
  it("keeps a dated 0.9.0 heading", () => {
    expect(changelog).toMatch(/^## 0\.9\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
  });

  it("names every new key with its default in the upgrade notes", () => {
    const notes = bullets(part("Upgrade notes"));
    const missing = Object.entries(NEW_KEYS).filter(
      ([key, def]) => !notes.some((b) => b.includes(`\`${key}\``) && b.includes(def)),
    );
    expect(missing).toEqual([]);
  });

  it("says the default auto-recall request changed, and how to get the 0.8.0 one back", () => {
    const notes = bullets(part("Upgrade notes")).join("\n");
    expect(notes).toContain("include: {entities: null}");
    expect(notes).toContain("`recallSkipEntities: false`");
  });

  it("lists the new CLI subcommands, the reflect parameter and the README move", () => {
    const added = part("Added");
    for (const text of [
      "`agents`",
      "`recallEarlyStart`",
      "`recallStaleOnTimeout`",
      "`recallSkipEntities`",
      "`openclaw hindsight recall",
      "`openclaw hindsight queue",
      "`hindsight_reflect`",
    ]) {
      expect({ text, found: added.includes(text) }).toEqual({ text, found: true });
    }
    expect(section).toContain("docs/offline-retain-queue.md");
  });
});

describe("CHANGELOG 0.9.0 and docs (0.9.0 review P1-1, P2-9)", () => {
  it("says why recallHistoryPattern skips the deprecation notice, citing SUPPORT.md", () => {
    const note = bullets(part("Upgrade notes")).find((b) => b.includes("`recallHistoryPattern`"));
    expect(note).toBeDefined();
    for (const text of ["SUPPORT.md", "Deprecations", "security", "deprecation notice"]) {
      expect({ text, found: note!.includes(text) }).toEqual({ text, found: true });
    }
    expect(note).toMatch(/catastrophic backtracking/);
    expect(note).toMatch(/hang every reply/);
    // The cited exception exists.
    const support = readFileSync(new URL("../SUPPORT.md", import.meta.url), "utf8");
    expect(support).toMatch(/^## Deprecations$/m);
    expect(support.replace(/\s+/g, " ")).toContain(
      "A security problem can shorten the notice when keeping the old behavior is the risk.",
    );
  });

  it("the latency levers paragraph names recallSkipEntities as on by default", () => {
    const docs = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");
    const levers = docs.split("Latency levers")[1]!.split("\n\n")[0]!.replace(/\s+/g, " ");
    expect(levers).not.toContain("all off by default");
    expect(levers).toMatch(/`recallSkipEntities` \(on by default\)/);
  });

  it("no doc says an early recall needs the run to match, or that every turn after a restart is cold", () => {
    const files = ["../CHANGELOG.md", "../docs/configuration.md", "../openclaw.plugin.json"];
    for (const file of files) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\s+/g, " ");
      expect({
        file,
        run: /when the (turn's )?run, (the )?bank and (the )?request/.test(text),
      }).toEqual({ file, run: false });
      expect({ file, restart: text.includes("every turn after a restart") }).toEqual({
        file,
        restart: false,
      });
    }
  });
});
