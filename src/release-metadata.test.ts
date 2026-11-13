import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

/** RELEASING.md step 1: the version, the CHANGELOG section and the SECURITY.md table agree. */
describe("release metadata", () => {
  const { version } = JSON.parse(read("package.json")) as { version: string };

  it("package.json and package-lock.json carry the same version", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect([lock.version, lock.packages[""]?.version]).toEqual([version, version]);
  });

  it("the newest CHANGELOG section is this version, with a date", () => {
    const heading = /^## (\S+) \((\d{4}-\d{2}-\d{2})\)$/m.exec(read("CHANGELOG.md"));
    expect(heading?.[1]).toBe(version);
  });

  // F8: which date, not only that there is one.
  it("the newest CHANGELOG date is a real day, not before the previous release", () => {
    const headings = [...read("CHANGELOG.md").matchAll(/^## \S+ \((\d{4}-\d{2}-\d{2})\)$/gm)];
    const [newest, previous] = headings.map((m) => m[1]!);
    expect(new Date(`${newest}T00:00:00Z`).toISOString().slice(0, 10)).toBe(newest);
    expect(newest! >= previous!).toBe(true);
  });

  // On the tag build (GitHub release workflow, or a GitLab tag pipeline) the heading must carry
  // the tag day: one day either way covers the maintainer's time zone against UTC.
  it.runIf(process.env.GITHUB_REF_TYPE === "tag" || Boolean(process.env.CI_COMMIT_TAG))(
    "on a tag build the newest CHANGELOG date is the tag day",
    () => {
      const newest = /^## \S+ \((\d{4}-\d{2}-\d{2})\)$/m.exec(read("CHANGELOG.md"))![1]!;
      const offDays = Math.abs(Date.now() - Date.parse(`${newest}T12:00:00Z`)) / 86_400_000;
      expect(offDays).toBeLessThanOrEqual(1.5);
    },
  );

  it("SECURITY.md names this version as the latest release", () => {
    expect(read("SECURITY.md")).toContain(`| Latest release (${version} today) |`);
  });
});
