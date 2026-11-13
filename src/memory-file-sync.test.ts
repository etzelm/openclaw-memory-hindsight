import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentHash,
  contentSkipReason,
  inScanSet,
  isoSecond,
  memoryFileItem,
  parseLegacyState,
  pathSkipReason,
  planMemoryFileSync,
  readSyncState,
  scanMemoryFiles,
  syncMemoryFiles,
} from "./memory-file-sync.js";

let dir: string;
let statePath: string;

async function put(rel: string, content: string) {
  const abs = path.join(dir, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-memfile-"));
  statePath = path.join(dir, ".state", "memory-file-sync.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeService() {
  const retained: Array<{ bankId: string; item: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  return {
    retained,
    deleted,
    service: {
      retainOrQueue: vi.fn<
        (bankId: string, item: Record<string, unknown>) => Promise<"sent" | "queued">
      >(async (bankId, item) => {
        retained.push({ bankId, item });
        return "sent" as const;
      }),
      client: {
        deleteDocument: vi.fn<
          (bank: string, id: string) => Promise<{ memoryUnitsDeleted: number } | null>
        >(async (_bank, id) => {
          deleted.push(id);
          return { memoryUnitsDeleted: 1 };
        }),
      },
    },
  };
}

describe("memory file selection (same rules as hindsight-memory-sync.sh)", () => {
  it("skips dreaming output, hidden state, empty files and session stubs", () => {
    expect(pathSkipReason("memory/dreaming/2026-11-01.md")).toBe("dreaming pipeline output");
    expect(pathSkipReason("memory/.state/x.md")).toBe("hidden pipeline state");
    expect(pathSkipReason("memory/.x.md")).toBe("hidden pipeline state");
    expect(pathSkipReason("memory/2026-11-01.md")).toBeNull();
    expect(contentSkipReason(" \n\t\n")).toBe("empty");
    expect(
      contentSkipReason(
        "# Session: 2026-11-01\n\n- **Session Key**: agent:main:main\n- **Session ID**: x\n- **Source**: webchat\n- **Reason**: new\n",
      ),
    ).toBe("session header only");
    expect(contentSkipReason("# Session: x\n- a real note\n")).toBeNull();
  });

  it("scans root files first, then memory/ recursively in byte order", async () => {
    await put("USER.md", "user");
    await put("MEMORY.md", "memory");
    await put("memory/b.md", "b");
    await put("memory/A.md", "a");
    await put("memory/sub/c.md", "c");
    await put("memory/notes.txt", "not markdown");
    await put("memory/dreaming/d.md", "dream");
    await put("other/x.md", "outside memory/");
    const scan = await scanMemoryFiles(dir);
    expect(scan.send.map((f) => f.rel)).toEqual([
      "MEMORY.md",
      "USER.md",
      "memory/A.md",
      "memory/b.md",
      "memory/sub/c.md",
    ]);
    expect(scan.skipped).toEqual([
      { rel: "memory/dreaming/d.md", reason: "dreaming pipeline output" },
    ]);
  });

  it("does not follow symlinks out of the workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hs-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.md"), "secret");
      await fs.mkdir(path.join(dir, "memory"), { recursive: true });
      await fs.symlink(outside, path.join(dir, "memory", "linked"));
      await fs.symlink(path.join(outside, "secret.md"), path.join(dir, "memory", "s.md"));
      expect((await scanMemoryFiles(dir)).send).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("memoryFileItem", () => {
  it("uses the script's document id, tag, metadata and replace mode", () => {
    const mtimeMs = Date.UTC(2026, 10, 2, 3, 4, 5, 678);
    const item = memoryFileItem(
      { rel: "memory/2026-11-01-0720.md", content: "x", mtimeMs, hash: contentHash("x") },
      ["team:ops"],
    );
    expect(item).toMatchObject({
      content: "x",
      document_id: "memory/2026-11-01-0720.md",
      timestamp: "2026-11-02T03:04:05Z",
      tags: ["source:memory-file", "team:ops"],
      update_mode: "replace",
      metadata: { source: "memory-file", path: "memory/2026-11-01-0720.md" },
    });
    // As-of date from the file name, else the mtime.
    expect(item.context).toContain("as of 2026-11-01;");
    expect(
      memoryFileItem({ rel: "MEMORY.md", content: "x", mtimeMs, hash: "h" }).context,
    ).toContain("as of 2026-11-02;");
  });

  it("isoSecond drops milliseconds like date -u", () => {
    expect(isoSecond(Date.UTC(2026, 0, 1, 0, 0, 0, 999))).toBe("2026-01-01T00:00:00Z");
  });
});

describe("planMemoryFileSync and the legacy state", () => {
  it("retains changed files, keeps unchanged ones and deletes vanished ones", () => {
    const scan = {
      send: [
        { rel: "MEMORY.md", content: "m", mtimeMs: 0, hash: "h1" },
        { rel: "memory/a.md", content: "a", mtimeMs: 0, hash: "h2-new" },
      ],
      skipped: [],
    };
    const plan = planMemoryFileSync(scan, {
      "MEMORY.md": "h1",
      "memory/a.md": "h2",
      "memory/gone.md": "h3",
    });
    expect(plan.retain.map((f) => f.rel)).toEqual(["memory/a.md"]);
    expect(plan.unchanged).toEqual(["MEMORY.md"]);
    expect(plan.delete).toEqual(["memory/gone.md"]);
  });

  it("imports only finished entries from the script's TSV", () => {
    const h = "a".repeat(64);
    expect(
      parseLegacyState(
        [
          `MEMORY.md\t${h}\tdone`,
          `memory/x.md\t${h}\tpending:op1`,
          "memory/y.md\tfailed\tfailed",
          `../e.md\t${h}\tdone`,
          "",
        ].join("\n"),
      ),
    ).toEqual({ "MEMORY.md": h });
  });
});

describe("scan set: what may be imported and deleted", () => {
  it("is MEMORY.md, USER.md and memory/**.md only", () => {
    for (const rel of ["MEMORY.md", "USER.md", "memory/a.md", "memory/sub/b.md"]) {
      expect(inScanSet(rel)).toBe(true);
    }
    for (const rel of [
      "worker/memory/2026-11-01.md",
      "lane-blog/memory/x.md",
      "worker/MEMORY.md",
      "memory/../MEMORY.md",
      "memory//a.md",
      "memory/a.txt",
      "openclaw:agent:main:main-abc:run:1",
      "",
    ]) {
      expect(inScanSet(rel)).toBe(false);
    }
  });

  it("imports only scanned paths from the script's state, so sub-agent documents are never deleted", () => {
    const h = "b".repeat(64);
    const legacy = parseLegacyState(
      [
        `MEMORY.md\t${h}\tdone`,
        `memory/gone.md\t${h}\tdone`,
        `worker/memory/2026-11-01.md\t${h}\tdone`,
        `lane-blog/memory/x.md\t${h}\tdone`,
      ].join("\n"),
    );
    expect(Object.keys(legacy)).toEqual(["MEMORY.md", "memory/gone.md"]);
    const plan = planMemoryFileSync({ send: [], skipped: [] }, legacy);
    expect(plan.delete).toEqual(["MEMORY.md", "memory/gone.md"]);
  });

  it("never plans a delete for a state entry outside the scan set", () => {
    const plan = planMemoryFileSync(
      { send: [], skipped: [] },
      { "worker/memory/a.md": "h", "notes/x.md": "h", "memory/a.md": "h" },
    );
    expect(plan.delete).toEqual(["memory/a.md"]);
  });
});

describe("syncMemoryFiles", () => {
  it("sends each file once, then only changes and deletions", async () => {
    await put("MEMORY.md", "rules");
    await put("memory/a.md", "note a");
    const fake = fakeService();
    const first = await syncMemoryFiles({
      service: fake.service,
      workspaceDir: dir,
      bankId: "main",
      statePath,
    });
    expect(first).toMatchObject({ sent: 2, unchanged: 0, deleted: 0, failed: [] });
    expect(fake.retained.map((r) => [r.bankId, r.item.document_id])).toEqual([
      ["main", "MEMORY.md"],
      ["main", "memory/a.md"],
    ]);

    const second = await syncMemoryFiles({
      service: fake.service,
      workspaceDir: dir,
      bankId: "main",
      statePath,
    });
    expect(second).toMatchObject({ sent: 0, unchanged: 2 });

    await put("memory/a.md", "note a, edited");
    await fs.rm(path.join(dir, "MEMORY.md"));
    const third = await syncMemoryFiles({
      service: fake.service,
      workspaceDir: dir,
      bankId: "main",
      statePath,
    });
    expect(third).toMatchObject({ sent: 1, deleted: 1, unchanged: 0 });
    expect(fake.deleted).toEqual(["MEMORY.md"]);
    expect(Object.keys(await readSyncState(statePath))).toEqual(["memory/a.md"]);
  });

  it("keeps a failed file out of the state so the next pass retries it", async () => {
    await put("memory/a.md", "note a");
    const fake = fakeService();
    fake.service.retainOrQueue.mockRejectedValueOnce(new Error("HTTP 422"));
    const run = await syncMemoryFiles({
      service: fake.service,
      workspaceDir: dir,
      bankId: "main",
      statePath,
    });
    expect(run.failed).toEqual([{ rel: "memory/a.md", error: "HTTP 422" }]);
    expect(await readSyncState(statePath)).toEqual({});
    const retry = await syncMemoryFiles({
      service: fake.service,
      workspaceDir: dir,
      bankId: "main",
      statePath,
    });
    expect(retry.sent).toBe(1);
  });

  it("dry run plans without sending or writing state", async () => {
    await put("memory/a.md", "note a");
    const fake = fakeService();
    const run = await syncMemoryFiles({
      service: fake.service,
      workspaceDir: dir,
      bankId: "main",
      statePath,
      dryRun: true,
    });
    expect(run.plan.retain).toHaveLength(1);
    expect(fake.retained).toHaveLength(0);
    await expect(fs.access(statePath)).rejects.toThrow("ENOENT");
  });
});
