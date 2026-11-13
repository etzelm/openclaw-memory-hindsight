import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "./config.js";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const manifest = JSON.parse(read("openclaw.plugin.json")) as {
  configSchema: { properties: Record<string, unknown> };
  uiHints: Record<string, { label?: string; help?: string }>;
};
const readme = read("README.md");
const docs = readdirSync(new URL("docs/", root)).filter((name) => name.endsWith(".md"));
const MOVED = [
  "docs/offline-retain-queue.md",
  "docs/host-api-evidence.md",
  "docs/configuration.md",
  "docs/design.md",
];

/** Relative markdown link targets (no scheme, no pure anchor), without their #fragment. */
function relativeLinks(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!)
    .filter((target) => !/^[a-z]+:/i.test(target) && !target.startsWith("#"))
    .map((target) => target.split("#")[0]!);
}

describe("uiHints (Q9)", () => {
  it("has a label and help for every config schema key, and no hint without a key", () => {
    const keys = Object.keys(manifest.configSchema.properties);
    expect(keys.filter((k) => !manifest.uiHints[k]?.label || !manifest.uiHints[k]?.help)).toEqual(
      [],
    );
    expect(Object.keys(manifest.uiHints).filter((k) => !keys.includes(k))).toEqual([]);
  });
});

describe("README split (Q9)", () => {
  it("is install, minimal config and operate, in that order, and short", () => {
    const headings = readme.split("\n").filter((line) => line.startsWith("## "));
    const order = [
      "## Quick start",
      "## Troubleshooting",
      "## Install",
      "## Configuration",
      "## Operate",
    ];
    expect(order.map((h) => headings.indexOf(h))).toEqual(
      order.map((h) => headings.indexOf(h)).toSorted((a, b) => a - b),
    );
    expect(order.filter((h) => !headings.includes(h))).toEqual([]);
    expect(readme.split("\n").length).toBeLessThanOrEqual(400);
  });

  it("moved the deep sections to docs/ and links each one", () => {
    for (const path of MOVED) {
      expect({ path, exists: existsSync(new URL(path, root)) }).toEqual({ path, exists: true });
      expect({ path, linked: readme.includes(`](${path}`) }).toEqual({ path, linked: true });
    }
    expect(readme).not.toContain("### Offline retain queue");
    expect(readme).not.toContain("### Host API evidence");
    expect(read("docs/offline-retain-queue.md")).toContain("# Offline retain queue");
    expect(read("docs/host-api-evidence.md")).toContain("# Host API evidence");
  });

  it("still names every config key in the README table", () => {
    const table = readme.split("\n").filter((line) => line.startsWith("| `"));
    const missing = CONFIG_KEYS.filter(
      (key) => key !== "listToolsWithoutAudience" && !table.some((l) => l.includes(`\`${key}\``)),
    );
    expect(missing).toEqual([]);
  });

  it("quotes only log lines the code writes in the troubleshooting table", () => {
    const section = readme.split("## Troubleshooting")[1]!.split("\n## ")[0]!;
    const quoted = [...section.matchAll(/`(memory-hindsight: [^`]+)`/g)].map((m) => m[1]!);
    expect(quoted.length).toBeGreaterThanOrEqual(5);
    // Each log string in the source, with every ${...} placeholder as a wildcard.
    const sources = ["index.ts", "service.ts"].map((f) => read(`src/${f}`)).join("\n");
    const patterns = [...sources.matchAll(/[`"](memory-hindsight: [^`"]+)[`"]/g)].map(
      (m) =>
        new RegExp(
          `^${m[1]!
            .split(/\$\{[^}]*\}/)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".+")}`,
        ),
    );
    const unknown = quoted.filter((line) => !patterns.some((re) => re.test(line)));
    expect(unknown).toEqual([]);
  });

  it("has no relative link to a missing file in README or docs", () => {
    const broken = [
      ...relativeLinks(readme).map((t) => ({ from: "README.md", to: t })),
      ...docs.flatMap((name) =>
        relativeLinks(read(`docs/${name}`)).map((t) => ({ from: `docs/${name}`, to: `docs/${t}` })),
      ),
    ].filter(({ to }) => !existsSync(new URL(to, root)));
    expect(broken).toEqual([]);
  });
});
