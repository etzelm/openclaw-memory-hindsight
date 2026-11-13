import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminIo } from "./cli-admin.js";
import { createSidecarCommands, syncStatePath } from "./cli-sidecar.js";
import type { HindsightClient } from "./client.js";
import { hindsightConfigSchema } from "./config.js";
import type { ExportSource } from "./export.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hs-cli-sidecar-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(extra: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let exit: number | undefined;
  const io: AdminIo = {
    log: (...a) => out.push(a.join(" ")),
    error: (...a) => err.push(a.join(" ")),
    exit: (code) => {
      exit = code;
    },
    isTTY: false,
    confirm: async () => false,
  };
  const config = hindsightConfigSchema.parse({
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    agentBankMap: { ops: "shared" },
    ...extra,
  });
  const ws = join(dir, "ws");
  const source: ExportSource = {
    listMemories: vi.fn<ExportSource["listMemories"]>(async (_bank, type) => ({
      total: 1,
      items: [{ id: `${type}-1`, text: `${type} fact`, tags: [] }],
    })),
    listMentalModels: vi.fn<ExportSource["listMentalModels"]>(async () => ({
      total: 0,
      items: [],
    })),
  };
  const retained: Array<{ bank: string; id: string }> = [];
  const commands = createSidecarCommands({
    io: () => io,
    parseConfig: () => ({ config }),
    clientFor: () => ({}) as HindsightClient,
    hostConfig: () => ({ agents: { list: [{ id: "main", workspace: ws }] } }),
    stateDir: () => join(dir, "state"),
    exportSource: () => source,
    syncService: () => ({
      retainOrQueue: async (bank, item) => {
        retained.push({ bank, id: item.document_id });
        return "sent";
      },
      client: { deleteDocument: async () => ({ memoryUnitsDeleted: 0 }) },
    }),
  });
  return { commands, out, err, exit: () => exit, source, retained, ws };
}

describe("openclaw hindsight export", () => {
  it("writes the owner bank to <out>/<bank>/ and lists the counts", async () => {
    const h = harness();
    await h.commands.exportBank({ out: join(dir, "out") });
    expect(h.exit()).toBeUndefined();
    expect(readFileSync(join(dir, "out", "main", "facts.md"), "utf8")).toContain("- world fact");
    expect(h.out).toContain("facts.md: 1");
    expect(h.out.at(-1)).toBe(`Exported bank main to ${join(dir, "out", "main")}`);
  });

  it("follows agentBankMap, --bank, --types and --mental-models", async () => {
    const h = harness();
    await h.commands.exportBank({ out: join(dir, "o1"), agent: "ops", types: "observation" });
    expect(vi.mocked(h.source.listMemories).mock.calls.map(([b, t]) => `${b}:${t}`)).toEqual([
      "shared:observation",
    ]);
    await h.commands.exportBank({ out: join(dir, "o2"), bank: "other", mentalModels: true });
    expect(h.source.listMentalModels).toHaveBeenCalledWith("other", { limit: 200, offset: 0 });
  });

  it("refuses bad options with exit 1", async () => {
    for (const [opts, message] of [
      [{}, "--out <dir> is required"],
      [{ out: dir, types: "world,bogus" }, "--types takes"],
      [{ out: dir, maxItems: "0" }, "--max-items must be a positive integer"],
      [{ out: dir, bank: ".." }, "--bank must be a bank id"],
    ] as const) {
      const h = harness();
      await h.commands.exportBank(opts);
      expect(h.exit()).toBe(1);
      expect(h.err.join("\n")).toContain(message);
    }
  });
});

describe("openclaw hindsight sync-memory-files", () => {
  it("sends the workspace memory files to the owner bank and records state", async () => {
    const h = harness();
    mkdirSync(join(h.ws, "memory"), { recursive: true });
    writeFileSync(join(h.ws, "MEMORY.md"), "rules\n");
    writeFileSync(join(h.ws, "memory", "a.md"), "note\n");
    await h.commands.syncFiles({});
    expect(h.retained).toEqual([
      { bank: "main", id: "MEMORY.md" },
      { bank: "main", id: "memory/a.md" },
    ]);
    expect(h.out[0]).toBe("main -> bank main: sent 2, unchanged 0, deleted 0, skipped 0");
    expect(
      Object.keys(JSON.parse(readFileSync(syncStatePath(join(dir, "state"), "main"), "utf8"))),
    ).toEqual(["MEMORY.md", "memory/a.md"]);
  });

  it("imports the script's finished files so unchanged ones are not sent again", async () => {
    const h = harness();
    mkdirSync(h.ws, { recursive: true });
    writeFileSync(join(h.ws, "MEMORY.md"), "rules\n");
    const hash = "1d2a2d3a1b7f45f7e2d6f3d9b1d0a3e7f9a1f3e1c2d4b6a8f0e2c4d6b8a0c2e4";
    const { createHash } = await import("node:crypto");
    const real = createHash("sha256").update("rules\n").digest("hex");
    const tsv = join(dir, "legacy.tsv");
    writeFileSync(tsv, `MEMORY.md\t${real}\tdone\nmemory/gone.md\t${hash}\tdone\n`);
    await h.commands.syncFiles({ importLegacyState: tsv });
    expect(h.out[0]).toBe(`Imported 2 finished files from ${tsv}`);
    // MEMORY.md unchanged since the script sent it; memory/gone.md is no longer in the workspace.
    expect(h.retained).toEqual([]);
    expect(h.out[1]).toBe("main -> bank main: sent 0, unchanged 1, deleted 1, skipped 0");
  });

  it("dry run lists and sends nothing", async () => {
    const h = harness();
    mkdirSync(h.ws, { recursive: true });
    writeFileSync(join(h.ws, "USER.md"), "user\n");
    await h.commands.syncFiles({ dryRun: true });
    expect(h.retained).toEqual([]);
    expect(h.out).toEqual([
      "main -> bank main: would send 1, unchanged 0, would delete 0, skipped 0",
      "  send USER.md",
    ]);
  });
});
