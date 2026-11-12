import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HindsightClient, HindsightHttpError } from "./client.js";
import {
  isRetryableRejection,
  isTransportFailure,
  type QueuedRetain,
  RetainQueue,
  RetainQueueRunner,
  retainQueuePath,
} from "./retain-queue.js";

type LogFn = (message: string) => void;

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-queue-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(stateDir, { recursive: true, force: true });
});

function makeQueue(
  limits = { maxItems: 100, maxAgeMs: 60_000 },
  now?: () => number,
  maxBytes?: number,
) {
  const logger = { warn: vi.fn<LogFn>(), info: vi.fn<LogFn>(), debug: vi.fn<LogFn>() };
  const queue = new RetainQueue({
    filePath: retainQueuePath(stateDir),
    limits: () => limits,
    logger,
    ...(now ? { now } : {}),
    ...(maxBytes ? { maxBytes } : {}),
  });
  queue.load();
  return { queue, logger };
}

function readQueueFile(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function entry(bankId: string, documentId: string, content = `text of ${documentId}`) {
  return { bankId, documentId, item: { content, document_id: documentId } };
}

const SMALL_BOUND = 1_000;
const SMALL = { maxItems: 100, maxAgeMs: 60_000 };

/**
 * A copy of the document that fits the queue under SMALL_BOUND but not one more append to the
 * file, so a failed rewrite leaves no room for the fallback append: the only path that still
 * writes a tombstone.
 */
function noRoomFor(bankId: string, documentId: string) {
  const free = SMALL_BOUND - statSync(retainQueuePath(stateDir)).size;
  const base = Buffer.byteLength(
    JSON.stringify({ ...entry(bankId, documentId, ""), queuedAt: Date.now() }),
    "utf8",
  );
  // The line plus its newline takes exactly `free` bytes.
  return entry(bankId, documentId, "x".repeat(free - base - 1));
}

/** One queue file line, as an earlier run wrote it. */
function queueLine(bankId: string, documentId: string, content: string): string {
  return JSON.stringify({
    bankId,
    documentId,
    item: { content, document_id: documentId },
    queuedAt: Date.now(),
  });
}

function drain(queue: RetainQueue): QueuedRetain[] {
  const out: QueuedRetain[] = [];
  for (let next = queue.peek(); next; next = queue.peek()) {
    out.push(next);
    queue.remove(next);
  }
  return out;
}

describe("RetainQueue", () => {
  it("persists under the state dir with mode 600 and survives a restart", () => {
    const { queue } = makeQueue();
    queue.enqueue(entry("dev", "doc-1"));
    queue.enqueue(entry("dev", "doc-2"));
    const file = retainQueuePath(stateDir);
    expect(file).toBe(join(stateDir, "hindsight-native", "retain-queue.jsonl"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);

    const { queue: reopened } = makeQueue();
    expect(drain(reopened).map((e) => [e.bankId, e.documentId])).toEqual([
      ["dev", "doc-1"],
      ["dev", "doc-2"],
    ]);
    expect(existsSync(file)).toBe(false);
  });

  it("replaces a queued item with the same bank and document id instead of adding one", () => {
    const { queue } = makeQueue();
    queue.enqueue(entry("dev", "doc-1", "first"));
    queue.enqueue(entry("dev", "doc-2"));
    queue.enqueue(entry("dev", "doc-1", "second"));
    queue.enqueue(entry("other", "doc-1", "other bank"));
    expect(queue.size()).toBe(3);
    expect(drain(queue).map((e) => [e.bankId, e.documentId, e.item.content])).toEqual([
      ["dev", "doc-1", "second"],
      ["dev", "doc-2", "text of doc-2"],
      ["other", "doc-1", "other bank"],
    ]);
  });

  it("drops the oldest beyond maxItems and expired items, with one warning until it drains", () => {
    let now = 1_000_000;
    const { queue, logger } = makeQueue({ maxItems: 2, maxAgeMs: 10_000 }, () => now);
    queue.enqueue(entry("dev", "a"));
    queue.enqueue(entry("dev", "b"));
    queue.enqueue(entry("dev", "c"));
    queue.enqueue(entry("dev", "d"));
    expect(queue.size()).toBe(2);
    expect(queue.peek()?.documentId).toBe("c");
    now += 10_001;
    expect(queue.prune()).toBe(2);
    expect(queue.size()).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain("retainQueueMaxItems");

    queue.enqueue(entry("dev", "e"));
    drain(queue);
    queue.enqueue(entry("dev", "f"));
    queue.enqueue(entry("dev", "g"));
    queue.enqueue(entry("dev", "h"));
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("drops expired items when an earlier run's file is loaded", () => {
    let now = 5_000_000;
    const { queue } = makeQueue({ maxItems: 10, maxAgeMs: 1_000 }, () => now);
    queue.enqueue(entry("dev", "old"));
    now += 2_000;
    const { queue: reopened, logger } = makeQueue({ maxItems: 10, maxAgeMs: 1_000 }, () => now);
    expect(reopened.size()).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("appends new items and skips a torn line with one warning", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue();
    queue.enqueue(entry("dev", "doc-1"));
    const first = readFileSync(file, "utf8");
    queue.enqueue(entry("dev", "doc-2"));
    expect(readFileSync(file, "utf8").startsWith(first)).toBe(true);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"bankId":"dev","docu`);
    const { queue: reopened, logger } = makeQueue();
    expect(reopened.list().map((e) => e.documentId)).toEqual(["doc-1", "doc-2"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "memory-hindsight: retain queue skipped 1 unreadable line(s)",
    );
    expect(readQueueFile(file)).toHaveLength(2);
  });

  it("never keeps a stale or unsaved item when the queue file cannot be written", () => {
    // Directories in place of files make the writes fail with EISDIR, for root too.
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue(SMALL, undefined, SMALL_BOUND);
    queue.enqueue(entry("dev", "a"));
    const saved = readFileSync(file, "utf8");

    rmSync(file);
    mkdirSync(file);
    expect(() => queue.enqueue(entry("dev", "b"))).toThrow(/EISDIR/);
    expect(queue.list().map((e) => e.documentId)).toEqual(["a"]);
    rmSync(file, { recursive: true });
    writeFileSync(file, saved, { mode: 0o600 });

    mkdirSync(`${file}.tmp`);
    try {
      // The rewrite fails and the newer copy has no room to be appended.
      expect(() => queue.enqueue(noRoomFor("dev", "a"))).toThrow(/EISDIR/);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    // The out-of-date copy is gone from memory (the caller sends the newer one live) ...
    expect(queue.list().map((e) => e.documentId)).toEqual([]);
    // ... and from the file as a restart reads it: a tombstone line hides the stale copy.
    expect(readFileSync(file, "utf8")).toContain('"tombstone"');
    const { queue: restarted } = makeQueue();
    expect(restarted.list()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it("loads a file with a tombstone even while the rewrite still fails", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue(SMALL, undefined, SMALL_BOUND);
    queue.enqueue(entry("dev", "a"));
    queue.enqueue(entry("dev", "b"));
    mkdirSync(`${file}.tmp`);
    try {
      expect(() => queue.enqueue(noRoomFor("dev", "a"))).toThrow(/EISDIR/);
      const { queue: restarted, logger } = makeQueue();
      expect(restarted.list().map((e) => e.documentId)).toEqual(["b"]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not compacted"));
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
  });

  it("keeps a tombstone from hiding a newer copy queued after it", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue(SMALL, undefined, SMALL_BOUND);
    queue.enqueue(entry("dev", "a"));
    mkdirSync(`${file}.tmp`);
    try {
      expect(() => queue.enqueue(noRoomFor("dev", "a"))).toThrow(/EISDIR/);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    queue.enqueue(entry("dev", "a", "newest"));
    const { queue: restarted } = makeQueue();
    expect(restarted.list().map((e) => e.documentId)).toEqual(["a"]);
    expect(restarted.peek()?.item.content).toBe("newest");
  });

  it("appends the newer copy when a replace cannot rewrite the file, and keeps it", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue();
    queue.enqueue(entry("dev", "seed"));
    queue.enqueue(entry("dev", "a", "first"));
    mkdirSync(`${file}.tmp`);
    try {
      // Rewrites fail, appends work, and the same document comes back again and again.
      for (let i = 0; i < 20; i += 1) {
        expect(queue.enqueue(entry("dev", "a", `copy ${i}`))).toBe(true);
      }
      expect(queue.enqueue(entry("other", "z"))).toBe(true);
      expect(queue.list().map((e) => e.documentId)).toEqual(["seed", "a", "z"]);
      expect(readQueueFile(file).some((l) => "tombstone" in l)).toBe(false);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    // A crash now: the next process replays the newest copy once.
    const { queue: crashed } = makeQueue();
    expect(drain(crashed).map((e) => e.item.content)).toEqual([
      "text of seed",
      "copy 19",
      "text of z",
    ]);
  });

  it("keeps memory equal to a restart when a fallback append follows a prune", () => {
    const file = retainQueuePath(stateDir);
    let now = 1_000_000;
    const limits = { maxItems: 3, maxAgeMs: 10_000 };
    const { queue } = makeQueue(limits, () => now);
    for (const id of ["a", "b", "c"]) {
      queue.enqueue(entry("dev", id));
    }
    mkdirSync(`${file}.tmp`);
    try {
      // Over maxItems: the prune drops "a", the rewrite fails, the new item is appended.
      expect(queue.enqueue(entry("dev", "d"))).toBe(true);
      // Replacing an item that is not last moves it to the end, as a restart orders it.
      expect(queue.enqueue(entry("dev", "b", "newer"))).toBe(true);
      expect(queue.list().map((e) => e.documentId)).toEqual(["c", "d", "b"]);
      // Past maxAgeMs: everything queued so far expires.
      now += 10_001;
      expect(queue.enqueue(entry("dev", "e"))).toBe(true);
      expect(queue.list().map((e) => e.documentId)).toEqual(["e"]);
      const { queue: restarted } = makeQueue(limits, () => now);
      expect(restarted.list()).toEqual(queue.list());
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
  });

  it("tombstones items a fallback append prunes, so a later tombstone cannot bring them back", () => {
    const file = retainQueuePath(stateDir);
    const limits = { maxItems: 3, maxAgeMs: 60_000 };
    const { queue } = makeQueue(limits, undefined, SMALL_BOUND);
    for (const id of ["a", "b", "c"]) {
      queue.enqueue(entry("dev", id, `${id}-old`));
    }
    mkdirSync(`${file}.tmp`);
    try {
      // Over maxItems: "a" is pruned while the rewrite fails.
      expect(queue.enqueue(entry("dev", "d"))).toBe(true);
      expect(queue.list().map((e) => e.documentId)).toEqual(["b", "c", "d"]);
      // A replace with no room to append tombstones "b", which lowers the live line count.
      expect(() => queue.enqueue(noRoomFor("dev", "b"))).toThrow(/EISDIR/);
      const { queue: afterTombstone } = makeQueue(limits);
      expect(afterTombstone.list()).toEqual(queue.list());
      // "a" comes back with no room either: it is sent live, so "a-old" must never replay.
      expect(() => queue.enqueue(noRoomFor("dev", "a"))).toThrow(/EISDIR/);
      const { queue: restarted } = makeQueue(limits);
      expect(restarted.list()).toEqual(queue.list());
      expect(restarted.list().map((e) => e.documentId)).toEqual(["c", "d"]);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
  });

  it("stays within the size bound while rewrites fail, then compacts on the next rewrite", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue(SMALL, undefined, SMALL_BOUND);
    queue.enqueue(entry("dev", "seed"));
    mkdirSync(`${file}.tmp`);
    let refused = 0;
    try {
      for (let i = 0; i < 50; i += 1) {
        try {
          queue.enqueue(entry("dev", "a", `copy ${i}`));
        } catch {
          // No room left to append: the caller sends it live.
          refused += 1;
        }
      }
      expect(refused).toBeGreaterThan(0);
      const lines = readQueueFile(file);
      const tombstones = lines.filter((l) => "tombstone" in l);
      // Copies stop at the bound; one tombstone hides the last copy that could not be replaced.
      expect(tombstones).toHaveLength(1);
      const itemBytes = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l && !l.includes('"tombstone"'))
        .reduce((sum, l) => sum + Buffer.byteLength(l, "utf8") + 1, 0);
      expect(itemBytes).toBeLessThanOrEqual(SMALL_BOUND);
      const { queue: crashed } = makeQueue();
      expect(crashed.list().map((e) => e.documentId)).toEqual(["seed"]);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    // The next rewrite writes exactly the queue again.
    queue.enqueue(entry("dev", "b"));
    expect(readQueueFile(file).map((l) => l.documentId)).toEqual(["seed", "b"]);
  });

  it("writes batched removals on a later save when an earlier save failed", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue();
    queue.enqueue(entry("dev", "a"));
    queue.enqueue(entry("dev", "b"));
    queue.remove(queue.peek()!, { persist: false });
    mkdirSync(`${file}.tmp`);
    try {
      expect(() => queue.save()).toThrow(/EISDIR/);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    queue.save();
    expect(readQueueFile(file).map((l) => l.documentId)).toEqual(["b"]);
  });

  it("never replays a delivered copy over a newer one after a failed replay save", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue(SMALL, undefined, SMALL_BOUND);
    queue.enqueue(entry("dev", "a", "v1"));
    queue.enqueue(entry("dev", "b"));
    // Replay delivered v1 of "a"; its batched save fails, so the file still holds v1.
    queue.remove(queue.peek()!, { persist: false });
    mkdirSync(`${file}.tmp`);
    try {
      expect(() => queue.save()).toThrow(/EISDIR/);
      // v2 of "a" can neither be rewritten nor appended: the caller sends it live.
      expect(() => queue.enqueue(noRoomFor("dev", "a"))).toThrow(/EISDIR/);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    expect(queue.list().map((e) => e.documentId)).toEqual(["b"]);
    // Crash before the next save: a restart must not replay v1 over the v2 sent live.
    const { queue: restarted } = makeQueue(SMALL, undefined, SMALL_BOUND);
    expect(restarted.list().map((e) => e.documentId)).toEqual(["b"]);
  });

  it("never replays a delivered copy over a newer one too large to queue", () => {
    const { queue } = makeQueue(SMALL, undefined, SMALL_BOUND);
    queue.enqueue(entry("dev", "a", "v1"));
    queue.enqueue(entry("dev", "b"));
    queue.remove(queue.peek()!, { persist: false });
    // v2 is over the bound, so it is not queued and the caller sends it live.
    expect(queue.enqueue(entry("dev", "a", "x".repeat(SMALL_BOUND)))).toBe(false);
    // Crash before replay's save: the file's v1 must not come back.
    const { queue: restarted } = makeQueue(SMALL, undefined, SMALL_BOUND);
    expect(restarted.list().map((e) => e.documentId)).toEqual(["b"]);
  });

  it("rewrites instead of appending when an append would pass the size bound", () => {
    const file = retainQueuePath(stateDir);
    const queue = new RetainQueue({
      filePath: file,
      limits: () => ({ maxItems: 100, maxAgeMs: 60_000 }),
      logger: {},
      maxBytes: 1_000,
    });
    queue.load();
    for (const id of ["a", "b", "c"]) {
      queue.enqueue(entry("dev", id, "x".repeat(200)));
    }
    // Replay delivered all three; its batched save has not run yet.
    for (let next = queue.peek(); next; next = queue.peek()) {
      queue.remove(next, { persist: false });
    }
    queue.enqueue(entry("dev", "d", "x".repeat(200)));
    queue.enqueue(entry("dev", "e", "x".repeat(200)));
    expect(statSync(file).size).toBeLessThanOrEqual(1_000);
    expect(readQueueFile(file).map((l) => l.documentId)).toEqual(["d", "e"]);
  });

  it("keeps only the newest copy of a document after a crash between replay saves", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue();
    queue.enqueue(entry("dev", "a", "old"));
    queue.enqueue(entry("dev", "b"));
    // Replay delivered "a" and batched the write; a newer "a" is appended behind the old copy.
    queue.remove(queue.peek()!, { persist: false });
    queue.enqueue(entry("dev", "a", "new"));
    expect(readQueueFile(file).map((l) => l.documentId)).toEqual(["a", "b", "a"]);
    // Crash: the next process loads the file.
    const { queue: restarted } = makeQueue();
    expect(restarted.list()).toEqual([
      { bankId: "dev", documentId: "b" },
      { bankId: "dev", documentId: "a" },
    ]);
    expect(drain(restarted).map((e) => e.item.content)).toEqual(["text of b", "new"]);
  });

  it("compacts duplicate copies on load and lets a later tombstone drop every copy", () => {
    const file = retainQueuePath(stateDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${[
        queueLine("dev", "a", "first"),
        queueLine("dev", "a", "second"),
        queueLine("dev", "b", "only"),
        JSON.stringify({ tombstone: { bankId: "dev", documentId: "a" } }),
      ].join("\n")}\n`,
    );
    const { queue } = makeQueue();
    expect(queue.list()).toEqual([{ bankId: "dev", documentId: "b" }]);
    expect(readQueueFile(file).map((l) => l.documentId)).toEqual(["b"]);
  });

  it("keeps a tombstone for one bank from dropping the same document id in another bank", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue(SMALL, undefined, SMALL_BOUND);
    queue.enqueue(entry("bank-a", "x", "a's copy"));
    queue.enqueue(entry("bank-b", "x", "b's copy"));
    mkdirSync(`${file}.tmp`);
    try {
      expect(() => queue.enqueue(noRoomFor("bank-a", "x"))).toThrow(/EISDIR/);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    expect(readQueueFile(file).at(-1)).toEqual({
      tombstone: { bankId: "bank-a", documentId: "x" },
    });
    const { queue: restarted } = makeQueue();
    expect(restarted.list()).toEqual([{ bankId: "bank-b", documentId: "x" }]);
    expect(restarted.peek()?.item.content).toBe("b's copy");
  });

  it("starts an appended item on a new line after a torn last line", () => {
    const file = retainQueuePath(stateDir);
    const { queue } = makeQueue();
    queue.enqueue(entry("dev", "doc-1"));
    writeFileSync(file, `${readFileSync(file, "utf8")}{"bankId":"dev","docu`);
    queue.enqueue(entry("dev", "doc-2"));
    const { queue: reopened } = makeQueue();
    expect(reopened.list().map((e) => e.documentId)).toEqual(["doc-1", "doc-2"]);
  });

  it("bounds the total size, dropping the oldest first", () => {
    const logger = { warn: vi.fn<LogFn>() };
    const queue = new RetainQueue({
      filePath: retainQueuePath(stateDir),
      limits: () => ({ maxItems: 100, maxAgeMs: 60_000 }),
      logger,
      maxBytes: 1_000,
    });
    queue.load();
    for (const id of ["a", "b", "c", "d"]) {
      queue.enqueue(entry("dev", id, "x".repeat(300)));
    }
    expect(queue.list().map((e) => e.documentId)).toEqual(["c", "d"]);
    expect(readFileSync(retainQueuePath(stateDir), "utf8").length).toBeLessThanOrEqual(1_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain("size bound");
  });

  it("counts the size bound in UTF-8 bytes, refuses an item larger than the bound, and prunes on replace", () => {
    const logger = { warn: vi.fn<LogFn>() };
    const file = retainQueuePath(stateDir);
    const queue = new RetainQueue({
      filePath: file,
      limits: () => ({ maxItems: 100, maxAgeMs: 60_000 }),
      logger,
      maxBytes: 2_000,
    });
    queue.load();
    for (const id of ["a", "b", "c", "d", "e"]) {
      queue.enqueue(entry("dev", id, "\u8a18".repeat(200)));
    }
    expect(statSync(file).size).toBeLessThanOrEqual(2_000);
    expect(queue.size()).toBe(2);

    expect(queue.enqueue(entry("dev", "huge", "x".repeat(5_000)))).toBe(false);
    expect(queue.size()).toBe(2);
    // An oversized replacement also removes the out-of-date queued copy.
    const [oldest] = queue.list();
    expect(queue.enqueue(entry("dev", oldest!.documentId, "x".repeat(5_000)))).toBe(false);
    expect(queue.size()).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("too large to queue"));

    const [newest] = queue.list().slice(-1);
    queue.enqueue(entry("dev", newest!.documentId, "y".repeat(1_500)));
    expect(statSync(file).size).toBeLessThanOrEqual(2_000);
    expect(queue.list().map((e) => e.documentId)).toEqual([newest!.documentId]);
  });

  it("warns again for a new outage after pruning emptied the queue", () => {
    let now = 1_000_000;
    const { queue, logger } = makeQueue({ maxItems: 1, maxAgeMs: 1_000 }, () => now);
    queue.enqueue(entry("dev", "a"));
    queue.enqueue(entry("dev", "b"));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    now += 2_000;
    queue.prune();
    expect(queue.size()).toBe(0);
    queue.enqueue(entry("dev", "c"));
    queue.enqueue(entry("dev", "d"));
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("refuses to load, and never overwrites, a queue path it cannot read", () => {
    // A directory at the queue path fails the read with EISDIR, for root too.
    const file = retainQueuePath(stateDir);
    mkdirSync(file, { recursive: true });
    writeFileSync(join(file, "keep"), "x");
    const queue = new RetainQueue({
      filePath: file,
      limits: () => ({ maxItems: 10, maxAgeMs: 60_000 }),
      logger: {},
    });
    expect(() => queue.load()).toThrow(/EISDIR/);
    expect(readFileSync(join(file, "keep"), "utf8")).toBe("x");
  });

  it("stores only bank, document id, payload and time: no URL or token", () => {
    const { queue } = makeQueue();
    queue.enqueue(entry("dev", "doc"));
    const [stored] = readQueueFile(retainQueuePath(stateDir));
    expect(Object.keys(stored!).toSorted()).toEqual(["bankId", "documentId", "item", "queuedAt"]);
  });
});

describe("isTransportFailure", () => {
  it("queues network errors, timeouts and 5xx, never 4xx", () => {
    expect(isTransportFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isTransportFailure(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isTransportFailure(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTransportFailure(new HindsightHttpError("x", 500))).toBe(true);
    expect(isTransportFailure(new HindsightHttpError("x", 503))).toBe(true);
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      expect(isTransportFailure(new HindsightHttpError("x", status))).toBe(false);
    }
    expect(isTransportFailure(new Error("other"))).toBe(false);
    // A refused redirect is a configuration problem, and other TypeErrors are bugs, not outages.
    expect(
      isTransportFailure(
        new TypeError("fetch failed", { cause: new Error("unexpected redirect") }),
      ),
    ).toBe(false);
    expect(isTransportFailure(new TypeError("x is not a function"))).toBe(false);
  });
});

function makeRunner(send: (entry: QueuedRetain) => Promise<void>) {
  const { queue, logger } = makeQueue();
  const runner = new RetainQueueRunner(queue, {
    send,
    logger,
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
  });
  return { queue, runner, logger };
}

describe("RetainQueueRunner", () => {
  it("replays in order and stops at the first transport failure, keeping the rest", async () => {
    const sent: string[] = [];
    const { queue, runner } = makeRunner(async (e) => {
      if (e.documentId === "b") {
        throw new TypeError("fetch failed");
      }
      sent.push(`${e.bankId}/${e.documentId}`);
    });
    queue.enqueue(entry("dev", "a"));
    queue.enqueue(entry("dev", "b"));
    queue.enqueue(entry("dev", "c"));
    await runner.flush();
    runner.stop();
    expect(sent).toEqual(["dev/a"]);
    expect(drain(queue).map((e) => e.documentId)).toEqual(["b", "c"]);
  });

  it("drops an item Hindsight rejects with 4xx and keeps going; keeps it on 401/403/429", async () => {
    const sent: string[] = [];
    let status = 422;
    const { queue, runner, logger } = makeRunner(async (e) => {
      if (e.documentId === "bad") {
        throw new HindsightHttpError("Hindsight retain failed: HTTP " + status, status);
      }
      sent.push(e.documentId);
    });
    queue.enqueue(entry("dev", "bad"));
    queue.enqueue(entry("dev", "good"));
    await runner.flush();
    expect(sent).toEqual(["good"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 422"));

    status = 401;
    queue.enqueue(entry("dev", "bad"));
    queue.enqueue(entry("dev", "later"));
    await runner.flush();
    runner.stop();
    expect(drain(queue).map((e) => e.documentId)).toEqual(["bad", "later"]);
  });

  it("warns once when Hindsight rejects replay with 401/403, again after a delivery", async () => {
    let status = 401;
    const { queue, runner, logger } = makeRunner(async () => {
      if (status) {
        throw new HindsightHttpError(`Hindsight retain failed: HTTP ${status}`, status);
      }
    });
    queue.enqueue(entry("dev", "a"));
    await runner.flush();
    await runner.flush();
    const rejected = () =>
      logger.warn.mock.calls.filter(([m]) => String(m).includes("queued retain not delivered"));
    expect(rejected()).toHaveLength(1);
    status = 0;
    await runner.flush();
    status = 403;
    queue.enqueue(entry("dev", "b"));
    await runner.flush();
    runner.stop();
    expect(rejected()).toHaveLength(2);
  });

  it("drops a queued retain on a bank-missing 404, keeps it on a route 404", async () => {
    const bankMissing = new HindsightHttpError(
      "Hindsight retain failed: HTTP 404",
      404,
      true,
      true,
    );
    const routeMissing = new HindsightHttpError("Hindsight retain failed: HTTP 404", 404, false);
    expect(isRetryableRejection(bankMissing)).toBe(false);
    expect(isRetryableRejection(routeMissing)).toBe(true);
    expect(isTransportFailure(bankMissing)).toBe(false);
    expect(isTransportFailure(routeMissing)).toBe(false);

    let answer: Error | undefined = bankMissing;
    const { queue, runner } = makeRunner(async () => {
      if (answer) {
        throw answer;
      }
    });
    queue.enqueue(entry("gone", "a"));
    await runner.flush();
    expect(queue.size()).toBe(0);
    answer = routeMissing;
    queue.enqueue(entry("dev", "b"));
    await runner.flush();
    runner.stop();
    expect(queue.list().map((e) => e.documentId)).toEqual(["b"]);
  });

  it("through the real client: drops only on an explicit bank-missing 404", async () => {
    const cases: Array<[string, number]> = [
      [JSON.stringify({ detail: "Bank 'b' not found" }), 0],
      [JSON.stringify({ detail: "Not Found" }), 1],
      ["<html>404</html>", 1],
      ["", 1],
    ];
    for (const [body, kept] of cases) {
      const client = new HindsightClient({
        resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
        fetch: async () => new Response(body, { status: 404 }),
      });
      const { queue, runner } = makeRunner((e) => client.retain(e.bankId, e.item));
      queue.enqueue(entry("b", `doc-${kept}-${body.length}`));
      await runner.flush();
      runner.stop();
      expect([body, queue.size()]).toEqual([body, kept]);
      drain(queue);
    }
  });

  it("retries on a timer with doubling backoff up to the cap", async () => {
    vi.useFakeTimers();
    let down = true;
    const send = vi.fn<(e: QueuedRetain) => Promise<void>>(async () => {
      if (down) {
        throw new TypeError("fetch failed");
      }
    });
    const { queue, runner } = makeRunner(send);
    queue.enqueue(entry("dev", "a"));
    await runner.flush();
    expect(send).toHaveBeenCalledTimes(1);
    // Next attempts at +1 s (the base delay), +2 s, +4 s, +4 s (doubled per failure, capped).
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(send).toHaveBeenCalledTimes(4);
    down = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(send).toHaveBeenCalledTimes(5);
    expect(queue.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(5);
    runner.stop();
  });

  it("keeps the item and backs off on a refused redirect or an unexpected error", async () => {
    const errors: unknown[] = [
      new TypeError("fetch failed", { cause: new Error("unexpected redirect") }),
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      new Error("something else"),
      new HindsightHttpError("Hindsight retain failed: HTTP 300", 300),
    ];
    for (const error of errors) {
      vi.useFakeTimers();
      const send = vi.fn<(e: QueuedRetain) => Promise<void>>(async () => {
        throw error;
      });
      const { queue, runner, logger } = makeRunner(send);
      queue.enqueue(entry("dev", "a"));
      queue.enqueue(entry("dev", "b"));
      await runner.flush();
      expect([String(error), queue.list().map((e) => e.documentId)]).toEqual([
        String(error),
        ["a", "b"],
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("queued retain not delivered"),
      );
      expect(vi.getTimerCount()).toBe(1);
      runner.stop();
      drain(queue);
      vi.useRealTimers();
    }
  });

  it("clears the pending retry timer on stop", async () => {
    vi.useFakeTimers();
    const send = vi.fn<(e: QueuedRetain) => Promise<void>>(async () => {
      throw new TypeError("fetch failed");
    });
    const { queue, runner } = makeRunner(send);
    queue.enqueue(entry("dev", "a"));
    await runner.flush();
    expect(vi.getTimerCount()).toBe(1);
    runner.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing after stop", async () => {
    vi.useFakeTimers();
    const send = vi.fn<(e: QueuedRetain) => Promise<void>>(async () => {
      throw new TypeError("fetch failed");
    });
    const { queue, runner } = makeRunner(send);
    queue.enqueue(entry("dev", "a"));
    await runner.flush();
    runner.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await runner.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(1);
  });
});
