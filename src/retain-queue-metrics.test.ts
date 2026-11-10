import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HindsightHttpError } from "./client.js";
import type { DropReason, ReplayOutcome } from "./metrics.js";
import { RetainQueue, RetainQueueRunner, retainQueuePath } from "./retain-queue.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-queue-metrics-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function entry(bankId: string, documentId: string, content = `text of ${documentId}`) {
  return { bankId, documentId, item: { content, document_id: documentId } };
}

function makeQueue(
  limits = { maxItems: 100, maxAgeMs: 60_000 },
  opts: { now?: () => number; maxBytes?: number } = {},
) {
  const drops: Array<[string, DropReason]> = [];
  const queue = new RetainQueue({
    filePath: retainQueuePath(stateDir),
    limits: () => limits,
    logger: {},
    onDrop: (bankId, reason) => drops.push([bankId, reason]),
    ...opts,
  });
  queue.load();
  return { queue, drops };
}

describe("RetainQueue drop reporting", () => {
  it("reports each item the maxItems bound drops, with its bank", () => {
    const { queue, drops } = makeQueue({ maxItems: 2, maxAgeMs: 60_000 });
    queue.enqueue(entry("a", "1"));
    queue.enqueue(entry("b", "2"));
    queue.enqueue(entry("c", "3"));
    expect(drops).toEqual([["a", "limit"]]);
    expect(queue.list().map((e) => e.bankId)).toEqual(["b", "c"]);
  });

  it("reports expired items on prune", () => {
    let now = 1_000;
    const { queue, drops } = makeQueue({ maxItems: 10, maxAgeMs: 100 }, { now: () => now });
    queue.enqueue(entry("a", "1"));
    queue.enqueue(entry("b", "2"));
    now += 101;
    expect(queue.prune()).toBe(2);
    expect(drops).toEqual([
      ["a", "limit"],
      ["b", "limit"],
    ]);
  });

  it("refuses an item too large to queue without reporting it (the caller may send it live)", () => {
    const { queue, drops } = makeQueue(undefined, { maxBytes: 200 });
    const big = entry("a", "1", "x".repeat(500));
    expect(queue.isTooLarge(big)).toBe(true);
    expect(queue.isTooLarge(entry("a", "2"))).toBe(false);
    expect(queue.enqueue(big)).toBe(false);
    expect(drops).toEqual([]);
  });

  it("reports a prune drop once when the rewrite fails and the fallback append prunes again", () => {
    const { queue, drops } = makeQueue({ maxItems: 2, maxAgeMs: 60_000 });
    queue.enqueue(entry("a", "1"));
    queue.enqueue(entry("b", "2"));
    const file = retainQueuePath(stateDir);
    mkdirSync(`${file}.tmp`);
    try {
      expect(queue.enqueue(entry("c", "3"))).toBe(true);
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    expect(drops).toEqual([["a", "limit"]]);
  });

  it("reports items a restart drops while loading", () => {
    const first = makeQueue({ maxItems: 10, maxAgeMs: 60_000 });
    first.queue.enqueue(entry("a", "1"));
    first.queue.enqueue(entry("b", "2"));
    const restarted = makeQueue({ maxItems: 1, maxAgeMs: 60_000 });
    expect(restarted.drops).toEqual([["a", "limit"]]);
  });

  it("counts queued items per bank", () => {
    const { queue } = makeQueue();
    queue.enqueue(entry("a", "1"));
    queue.enqueue(entry("a", "2"));
    queue.enqueue(entry("b", "3"));
    expect(queue.depthByBank()).toEqual(
      new Map([
        ["a", 2],
        ["b", 1],
      ]),
    );
  });

  it("does not report after configure() drops the observer", () => {
    const { queue, drops } = makeQueue({ maxItems: 1, maxAgeMs: 60_000 });
    queue.configure({ limits: () => ({ maxItems: 1, maxAgeMs: 60_000 }), logger: {} });
    queue.enqueue(entry("a", "1"));
    queue.enqueue(entry("b", "2"));
    expect(drops).toEqual([]);
  });
});

function makeRunner(send: (bankId: string) => Promise<void>) {
  const { queue } = makeQueue();
  const replays: Array<[string, ReplayOutcome]> = [];
  const drops: Array<[string, DropReason]> = [];
  const runner = new RetainQueueRunner(queue, {
    send: (e) => send(e.bankId),
    logger: {},
    onReplay: (bankId, outcome) => replays.push([bankId, outcome]),
    onDrop: (bankId, reason) => drops.push([bankId, reason]),
    baseDelayMs: 60_000,
  });
  return { queue, runner, replays, drops };
}

describe("RetainQueueRunner replay reporting", () => {
  it("reports delivered items and a 4xx rejection as a drop", async () => {
    const { queue, runner, replays, drops } = makeRunner(async (bankId) => {
      if (bankId === "bad") {
        throw new HindsightHttpError("unprocessable", 422);
      }
    });
    queue.enqueue(entry("a", "1"));
    queue.enqueue(entry("bad", "2"));
    queue.enqueue(entry("b", "3"));
    await runner.flush();
    runner.stop();
    expect(replays).toEqual([
      ["a", "delivered"],
      ["b", "delivered"],
    ]);
    expect(drops).toEqual([["bad", "rejected"]]);
    expect(queue.size()).toBe(0);
  });

  it("reports a deferred replay and keeps the item", async () => {
    const { queue, runner, replays, drops } = makeRunner(async () => {
      throw new TypeError("fetch failed");
    });
    queue.enqueue(entry("a", "1"));
    await runner.flush();
    runner.stop();
    expect(replays).toEqual([["a", "deferred"]]);
    expect(drops).toEqual([]);
    expect(queue.size()).toBe(1);
  });

  it("reports nothing for a send interrupted by stop", async () => {
    let release: (() => void) | undefined;
    const { queue, runner, replays } = makeRunner(
      () =>
        new Promise<void>((_resolve, reject) => {
          release = () => reject(new DOMException("stopped", "AbortError"));
        }),
    );
    queue.enqueue(entry("a", "1"));
    const pass = runner.flush();
    // send runs synchronously up to its first await, so the pending request exists now.
    expect(release).toBeTypeOf("function");
    runner.stop();
    release?.();
    await pass;
    expect(replays).toEqual([]);
  });
});
