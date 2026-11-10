import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropReason } from "./metrics.js";

// File modes cannot block writes when tests run as root (CI), so the append failure is injected.
const fsState = vi.hoisted(() => ({ failAppend: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    appendFileSync: (...args: Parameters<typeof real.appendFileSync>) => {
      if (fsState.failAppend) {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
          code: "ENOSPC",
        });
      }
      return real.appendFileSync(...args);
    },
  };
});

const { RetainQueue, retainQueuePath } = await import("./retain-queue.js");

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-queue-metrics-fs-"));
});
afterEach(() => {
  fsState.failAppend = false;
  rmSync(stateDir, { recursive: true, force: true });
});

function entry(bankId: string, documentId: string) {
  return {
    bankId,
    documentId,
    item: { content: `text of ${documentId}`, document_id: documentId },
  };
}

describe("RetainQueue drop reporting when both writes fail", () => {
  it("reports nothing for a prune the failed enqueue undid, and the real drop once later", () => {
    const file = retainQueuePath(stateDir);
    const drops: Array<[string, DropReason]> = [];
    const queue = new RetainQueue({
      filePath: file,
      limits: () => ({ maxItems: 2, maxAgeMs: 60_000 }),
      logger: {},
      onDrop: (bankId, reason) => drops.push([bankId, reason]),
    });
    queue.load();
    queue.enqueue(entry("a", "1"));
    queue.enqueue(entry("b", "2"));
    // The rewrite fails (its temp path is a directory) and so does the fallback append.
    mkdirSync(`${file}.tmp`);
    fsState.failAppend = true;
    try {
      expect(() => queue.enqueue(entry("c", "3"))).toThrow("EISDIR");
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
      fsState.failAppend = false;
    }
    expect(queue.list().map((e) => e.documentId)).toEqual(["1", "2"]);
    expect(drops).toEqual([]);
    expect(queue.enqueue(entry("d", "4"))).toBe(true);
    expect(drops).toEqual([["a", "limit"]]);
  });
});
