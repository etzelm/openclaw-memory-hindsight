import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBankExport,
  createHttpExportSource,
  type ExportSource,
  parseMemoryPage,
  renderMemories,
  slugify,
  writeBankExport,
} from "./export.js";
import { createFakeHindsight } from "./test-helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-export-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function memorySource(
  perType: Record<string, number>,
  mental = 0,
): ExportSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listMemories(_bank, type, page) {
      calls.push(`${type}:${page.offset}:${page.limit}`);
      const total = perType[type] ?? 0;
      const count = Math.max(0, Math.min(page.limit, total - page.offset));
      return {
        total,
        items: Array.from({ length: count }, (_, i) => ({
          id: `${type}-${page.offset + i}`,
          text: `${type} fact ${page.offset + i}`,
          date: `2026-11-${String(10 - ((page.offset + i) % 9)).padStart(2, "0")}T00:00:00Z`,
          tags: [],
        })),
      };
    },
    async listMentalModels(_bank, page) {
      const count = Math.max(0, Math.min(page.limit, mental - page.offset));
      return {
        total: mental,
        items: Array.from({ length: count }, (_, i) => ({
          id: `mm-${page.offset + i}`,
          name: i === 0 ? "Mitchell's preferences" : "Mitchell's preferences",
          content: "Prefers TypeScript.",
          tags: [],
        })),
      };
    },
  };
}

describe("parseMemoryPage", () => {
  it("keeps items with an id and text and reads the API field names", () => {
    expect(
      parseMemoryPage({
        total: 3,
        items: [
          {
            id: "a",
            text: "fact",
            occurred_start: "2026-11-01T00:00:00Z",
            document_id: "memory/x.md",
            tags: ["source:memory-file", 3],
            state: "valid",
          },
          { id: "b" },
          { text: "no id" },
        ],
      }),
    ).toEqual({
      total: 3,
      items: [
        {
          id: "a",
          text: "fact",
          date: "2026-11-01T00:00:00Z",
          documentId: "memory/x.md",
          tags: ["source:memory-file"],
          state: "valid",
        },
      ],
    });
    expect(parseMemoryPage(null)).toEqual({ items: [], total: 0 });
  });
});

describe("renderMemories", () => {
  it("one line per memory, oldest first, with provenance, and no raw HTML", () => {
    const md = renderMemories("World facts", "main", [
      { id: "2", text: "later\nfact", date: "2026-11-02", tags: ["t"], documentId: "d" },
      { id: "1", text: "<b>earlier</b>", date: "2026-11-01", tags: [], state: "invalidated" },
    ]);
    expect(md.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- &lt;b&gt;earlier&lt;/b&gt; (2026-11-01; state: invalidated; id:1)",
      "- later fact (2026-11-02; doc:d; tags: t; id:2)",
    ]);
  });
});

describe("buildBankExport", () => {
  it("pages through every type and writes an index", async () => {
    const source = memorySource({ world: 450, experience: 1, observation: 0 });
    const { files, summary } = await buildBankExport({ source, bankId: "main" });
    expect(source.calls.filter((c) => c.startsWith("world"))).toEqual([
      "world:0:200",
      "world:200:200",
      "world:400:200",
    ]);
    expect(files.map((f) => f.rel)).toEqual([
      "INDEX.md",
      "facts.md",
      "experiences.md",
      "observations.md",
    ]);
    expect(summary.types[0]).toEqual({
      type: "world",
      file: "facts.md",
      count: 450,
      total: 450,
      truncated: false,
    });
    expect(files[0]!.content).toContain("- [World facts](facts.md): 450");
  });

  it("stops at maxItems and says so in the index", async () => {
    const { files, summary } = await buildBankExport({
      source: memorySource({ world: 30 }),
      bankId: "main",
      types: ["world"],
      maxItems: 10,
    });
    expect(summary.types[0]).toMatchObject({ count: 10, total: 30, truncated: true });
    expect(files[0]!.content).toContain("10 of 30 (truncated at --max-items)");
  });

  it("exports mental models with unique file names when asked", async () => {
    const { files } = await buildBankExport({
      source: memorySource({}, 2),
      bankId: "main",
      types: ["world"],
      mentalModels: true,
    });
    expect(files.map((f) => f.rel)).toEqual([
      "INDEX.md",
      "facts.md",
      "mental-models/mitchell-s-preferences.md",
      "mental-models/mitchell-s-preferences-mm-1.md",
    ]);
  });
});

describe("createHttpExportSource", () => {
  it("calls the list endpoints with type, limit, offset and the bearer token", async () => {
    const fake = createFakeHindsight({
      "GET /v1/default/banks/main%3A%3Aconv/memories/list": () => ({
        json: { items: [{ id: "a", text: "x" }], total: 1, limit: 200, offset: 0 },
      }),
      "GET /v1/default/banks/main/mental-models": () => ({ json: { items: [], total: 0 } }),
    });
    const source = createHttpExportSource({
      apiUrl: "http://h.test/",
      apiToken: "tok",
      fetch: fake.fetch,
    });
    expect(
      (await source.listMemories("main::conv", "world", { limit: 200, offset: 0 })).items,
    ).toHaveLength(1);
    await source.listMentalModels("main", { limit: 5, offset: 10 });
    expect(fake.requests.map((r) => r.url)).toEqual([
      "http://h.test/v1/default/banks/main%3A%3Aconv/memories/list?type=world&limit=200&offset=0",
      "http://h.test/v1/default/banks/main/mental-models?limit=5&offset=10",
    ]);
    expect(fake.requests[0]!.auth).toBe("Bearer tok");
  });

  it("reports the status only on an error", async () => {
    const source = createHttpExportSource({
      apiUrl: "http://h.test",
      fetch: async () => new Response("secret body", { status: 500 }),
    });
    await expect(source.listMemories("main", "world", { limit: 1, offset: 0 })).rejects.toThrow(
      "Hindsight memory list failed: HTTP 500",
    );
  });
});

describe("writeBankExport", () => {
  it("writes under <out>/<bank slug>/ and refuses a non-empty target without overwrite", async () => {
    const files = [
      { rel: "INDEX.md", content: "i" },
      { rel: "mental-models/a.md", content: "a" },
    ];
    const target = await writeBankExport({ outDir: dir, bankId: "main::conv::ab", files });
    expect(target).toBe(path.join(dir, "main-conv-ab"));
    expect(await fs.readFile(path.join(target, "mental-models", "a.md"), "utf8")).toBe("a");
    await expect(writeBankExport({ outDir: dir, bankId: "main::conv::ab", files })).rejects.toThrow(
      "not empty",
    );
    await writeBankExport({ outDir: dir, bankId: "main::conv::ab", files, overwrite: true });
  });

  it("never writes outside the target", async () => {
    await expect(
      writeBankExport({
        outDir: dir,
        bankId: "main",
        files: [{ rel: "../escape.md", content: "x" }],
      }),
    ).rejects.toThrow("refusing to write outside");
  });

  it("slugify falls back for names with no safe characters", () => {
    expect(slugify("!!!", "fallback")).toBe("fallback");
  });
});
