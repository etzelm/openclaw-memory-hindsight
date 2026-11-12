import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// chmod failures cannot be produced with file modes when tests run as root, so inject them.
const fsState = vi.hoisted(() => ({
  failChmod: false,
  failAppend: false,
  shortWrite: false,
  calls: [] as string[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    chmodSync: (...args: Parameters<typeof real.chmodSync>) => {
      if (fsState.failChmod) {
        throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
      }
      return real.chmodSync(...args);
    },
    // A nearly full disk: one write stores only part of the text and reports no error.
    writeSync: (fd: number, data: unknown, ...rest: unknown[]) => {
      if (fsState.shortWrite && typeof data === "string") {
        return real.writeSync(fd, data.slice(0, Math.floor(data.length / 2)));
      }
      return (real.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
    },
    appendFileSync: (...args: Parameters<typeof real.appendFileSync>) => {
      if (fsState.failAppend) {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
          code: "ENOSPC",
        });
      }
      return real.appendFileSync(...args);
    },
    fsyncSync: (fd: number) => {
      fsState.calls.push("fsync");
      return real.fsyncSync(fd);
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      fsState.calls.push("rename");
      return real.renameSync(...args);
    },
  };
});

const { RetainQueue, retainQueuePath } = await import("./retain-queue.js");

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-queue-fs-"));
});
afterEach(() => {
  fsState.failChmod = false;
  fsState.failAppend = false;
  fsState.shortWrite = false;
  fsState.calls = [];
  rmSync(stateDir, { recursive: true, force: true });
});

describe("RetainQueue with a failing chmod", () => {
  it("keeps an appended item when chmod fails after the append", () => {
    const file = retainQueuePath(stateDir);
    const queue = new RetainQueue({
      filePath: file,
      limits: () => ({ maxItems: 10, maxAgeMs: 60_000 }),
      logger: {},
    });
    queue.load();
    queue.enqueue({ bankId: "dev", documentId: "a", item: { content: "a", document_id: "a" } });
    fsState.failChmod = true;
    expect(
      queue.enqueue({ bankId: "dev", documentId: "b", item: { content: "b", document_id: "b" } }),
    ).toBe(true);
    const inFile = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { documentId: string }).documentId);
    expect(queue.list().map((e) => e.documentId)).toEqual(inFile);
    expect(inFile).toEqual(["a", "b"]);
  });
});

describe("RetainQueue rewrite durability", () => {
  it("fsyncs the temp file before the rename, then the directory", () => {
    const file = retainQueuePath(stateDir);
    const queue = new RetainQueue({
      filePath: file,
      limits: () => ({ maxItems: 10, maxAgeMs: 60_000 }),
      logger: {},
    });
    queue.load();
    queue.enqueue({ bankId: "dev", documentId: "a", item: { content: "a", document_id: "a" } });
    queue.enqueue({ bankId: "dev", documentId: "b", item: { content: "b", document_id: "b" } });
    fsState.calls = [];
    // A replace rewrites the file.
    queue.enqueue({ bankId: "dev", documentId: "a", item: { content: "a2", document_id: "a" } });
    expect(fsState.calls).toEqual(["fsync", "rename", "fsync"]);
    expect(readFileSync(file, "utf8")).toContain('"a2"');
  });
});

const newQueue = (maxBytes?: number) => {
  const queue = new RetainQueue({
    filePath: retainQueuePath(stateDir),
    limits: () => ({ maxItems: 10, maxAgeMs: 60_000 }),
    logger: {},
    ...(maxBytes ? { maxBytes } : {}),
  });
  queue.load();
  return queue;
};
const item = (documentId: string, content = documentId) => ({
  bankId: "dev",
  documentId,
  item: { content, document_id: documentId },
});

describe("RetainQueue on a nearly full disk", () => {
  it("never replaces the queue file with a partly written rewrite", () => {
    const queue = newQueue();
    for (const id of ["a", "b", "c", "d"]) {
      queue.enqueue(item(id));
    }
    fsState.shortWrite = true;
    let wrote: boolean | undefined;
    try {
      // A replace rewrites the whole file.
      wrote = queue.enqueue(item("a", "a2"));
    } catch {
      wrote = false;
    }
    fsState.shortWrite = false;
    const restarted = newQueue();
    // Whatever the queue reported, a restart must find every item it still holds.
    expect(wrote).toBe(true);
    expect(restarted.list()).toEqual(queue.list());
    expect(restarted.size()).toBe(4);
  });

  it("retries a tombstone whose append failed on the next attempt", () => {
    const queue = newQueue(1_000);
    queue.enqueue(item("a", "v1"));
    queue.enqueue(item("b"));
    // Replay delivered v1 of "a" but has not saved yet.
    queue.remove(queue.peek()!, { persist: false });
    fsState.failAppend = true;
    expect(queue.enqueue(item("a", "x".repeat(1_000)))).toBe(false);
    fsState.failAppend = false;
    expect(queue.enqueue(item("a", "x".repeat(1_000)))).toBe(false);
    // Crash before replay's save: the file's v1 must not come back.
    expect(
      newQueue(1_000)
        .list()
        .map((e) => e.documentId),
    ).toEqual(["b"]);
  });
});
