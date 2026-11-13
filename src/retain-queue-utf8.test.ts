import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counts reads of the queue file, so a test can prove a queue step did not re-read it.
const reads = vi.hoisted(() => ({ path: "", count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      if (args[0] === reads.path) {
        reads.count += 1;
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

type Log = (message: string) => void;

const { RetainQueue } = await import("./retain-queue.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hs-utf8-"));
  reads.path = join(dir, "queue.jsonl");
  reads.count = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const newQueue = () =>
  new RetainQueue({
    filePath: reads.path,
    limits: () => ({ maxItems: 100, maxAgeMs: 3_600_000 }),
    logger: { info: vi.fn<Log>(), warn: vi.fn<Log>(), debug: vi.fn<Log>() },
  });

describe("retain queue file with invalid UTF-8 (0.9.0 review P3)", () => {
  it("is not re-read on every queue step", () => {
    const writer = newQueue();
    writer.load();
    writer.enqueue({
      bankId: "dev",
      documentId: "a",
      item: { content: "MARKER", document_id: "a" },
    });
    // A byte that is not UTF-8 inside the item text: the line still parses (as U+FFFD).
    const raw = readFileSync(reads.path);
    const at = raw.indexOf("MARKER");
    expect(at).toBeGreaterThan(0);
    raw[at] = 0xff;
    writeFileSync(reads.path, raw);

    const queue = newQueue();
    queue.load();
    expect(queue.peek()?.documentId).toBe("a");
    const afterFirstStep = reads.count;
    // Each step checks the file size against what it last read; nothing changed on disk.
    queue.peek();
    queue.peek();
    expect(reads.count).toBe(afterFirstStep);
    expect(queue.peek()?.documentId).toBe("a");
  });
});
