import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hindsightConfigSchema } from "./config.js";
import { HindsightMetrics } from "./metrics.js";
import { RetainQueue, retainQueuePath } from "./retain-queue.js";
import { createHindsightService } from "./service.js";
import { createFakeHindsight } from "./test-helpers.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-service-metrics-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

function boot(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const config = hindsightConfigSchema.parse({
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
  });
  const metrics = new HindsightMetrics();
  const service = createHindsightService({
    config: () => config,
    logger: {},
    fetch,
    metrics,
    retainQueueRetry: { baseDelayMs: 60_000 },
  });
  service.startRetainQueue(stateDir);
  const drops = () =>
    metrics
      .render()
      .split("\n")
      .filter((l) => l.startsWith("openclaw_hindsight_retain_queue_drops_total"));
  return { service, drops };
}

const item = (id: string) => ({ content: `text ${id}`, document_id: id });
const signal = () => AbortSignal.timeout(5_000);

describe("too_large drops are counted only for lost retains", () => {
  it("counts too_large when the live write fails and the queue refuses the item", async () => {
    let down = true;
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories": () => (down ? { status: 503 } : { json: {} }),
    });
    const { service, drops } = boot(fake.fetch);
    vi.spyOn(RetainQueue.prototype, "enqueue").mockReturnValue(false);
    vi.spyOn(RetainQueue.prototype, "isTooLarge").mockReturnValue(true);
    await expect(service.retainOrQueue("dev", item("a"), signal())).rejects.toThrow("503");
    expect(drops()).toEqual([
      'openclaw_hindsight_retain_queue_drops_total{bank="dev",reason="too_large"} 1',
    ]);
    down = false;
    service.stop();
  });

  it("does not count an oversized item that the queue-first path sends live", async () => {
    let down = true;
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories": () => (down ? { status: 503 } : { json: {} }),
    });
    const { service, drops } = boot(fake.fetch);
    // A real queued item for the bank, so the next retain goes queue-first.
    await expect(service.retainOrQueue("dev", item("a"), signal())).resolves.toBe("queued");
    down = false;
    const enqueue = vi.spyOn(RetainQueue.prototype, "enqueue").mockReturnValue(false);
    vi.spyOn(RetainQueue.prototype, "isTooLarge").mockReturnValue(true);
    await expect(service.retainOrQueue("dev", item("b"), signal())).resolves.toBe("sent");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(drops()).toEqual([]);
    service.stop();
  });

  it("counts too_large when the queue-first path refuses the item and the live write fails", async () => {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories": () => ({ status: 503 }),
    });
    const { service, drops } = boot(fake.fetch);
    await expect(service.retainOrQueue("dev", item("a"), signal())).resolves.toBe("queued");
    vi.spyOn(RetainQueue.prototype, "enqueue").mockReturnValue(false);
    vi.spyOn(RetainQueue.prototype, "isTooLarge").mockReturnValue(true);
    await expect(service.retainOrQueue("dev", item("b"), signal())).rejects.toThrow("503");
    expect(drops()).toEqual([
      'openclaw_hindsight_retain_queue_drops_total{bank="dev",reason="too_large"} 1',
    ]);
    service.stop();
  });
});

describe("turn-triggered replay with rate-limited banks (F3)", () => {
  it("ten turns on one bank send no request to six banks that answered 429", async () => {
    const posts: string[] = [];
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async (url, init) => {
        if (init?.method === "POST" && url.endsWith("/memories")) {
          posts.push(decodeURIComponent(new URL(url).pathname.split("/")[4]!));
          return new Response("", { status: 429 });
        }
        return new Response("{}", { status: 200 });
      },
    );
    const { service } = boot(fetch);
    const banks = ["b0", "b1", "b2", "b3", "b4", "b5"];
    for (const bank of banks) {
      await service.retainOrQueue(
        bank,
        { content: "x", document_id: "d0" },
        AbortSignal.timeout(5_000),
      );
    }
    expect(posts).toEqual(banks);
    // One full pass: each bank refuses once.
    await service.retainQueue()!.flush();
    expect(posts).toHaveLength(12);
    for (let i = 1; i <= 10; i++) {
      // Each queues behind b0 and starts a turn-triggered pass.
      await service.retainOrQueue(
        "b0",
        { content: "x", document_id: `d${i}` },
        AbortSignal.timeout(5_000),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(posts).toHaveLength(12);
    service.stop();
  });
});

function bootFull(maxItems: number) {
  const config = hindsightConfigSchema.parse({
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    retainQueueMaxItems: maxItems,
  });
  const warns: string[] = [];
  const answers: Array<(r: Response) => void> = [];
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (url.includes("/banks/old/")) {
      return new Response("", { status: 503 });
    }
    return new Promise<Response>((resolve) => answers.push(resolve));
  });
  const service = createHindsightService({
    config: () => config,
    logger: { warn: (m: string) => warns.push(m) },
    fetch,
    retainQueueRetry: { baseDelayMs: 60_000 },
  });
  service.startRetainQueue(stateDir);
  const file = retainQueuePath(stateDir);
  const inFile = () =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { documentId?: string })
          .filter((e) => e.documentId)
          .map((e) => e.documentId)
      : [];
  return { service, answers, warns, inFile };
}

describe("parking in-flight writes at stop with a full queue (F4)", () => {
  it("never evicts queued items to park in-flight writes", async () => {
    const { service, answers, warns, inFile } = bootFull(3);
    for (const id of ["o0", "o1", "o2"]) {
      await service.retainOrQueue("old", item(id), signal());
    }
    expect(inFile()).toEqual(["o0", "o1", "o2"]);
    const live = [
      service.retainOrQueue("new", item("n1"), signal()),
      service.retainOrQueue("new", item("n2"), signal()),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    service.stop();
    expect(inFile()).toEqual(["o0", "o1", "o2"]);
    expect(warns).toContain(
      "memory-hindsight: retain queue full at stop; 2 in-flight retain(s) not queued",
    );
    for (const answer of answers) {
      answer(new Response("{}", { status: 200 }));
    }
    await Promise.all(live);
    expect(inFile()).toEqual(["o0", "o1", "o2"]);
  });

  it("still parks in-flight writes while there is room", async () => {
    const { service, inFile } = bootFull(5);
    for (const id of ["o0", "o1", "o2"]) {
      await service.retainOrQueue("old", item(id), signal());
    }
    void service.retainOrQueue("new", item("n1"), signal());
    void service.retainOrQueue("new", item("n2"), signal());
    await new Promise((resolve) => setImmediate(resolve));
    service.stop();
    expect(inFile()).toEqual(["o0", "o1", "o2", "n1", "n2"]);
  });

  it("parks what fits and keeps the rest out, oldest queued items untouched", async () => {
    const { service, warns, inFile } = bootFull(4);
    for (const id of ["o0", "o1", "o2"]) {
      await service.retainOrQueue("old", item(id), signal());
    }
    void service.retainOrQueue("new", item("n1"), signal());
    void service.retainOrQueue("new", item("n2"), signal());
    await new Promise((resolve) => setImmediate(resolve));
    service.stop();
    expect(inFile()).toEqual(["o0", "o1", "o2", "n1"]);
    expect(warns).toContain(
      "memory-hindsight: retain queue full at stop; 1 in-flight retain(s) not queued",
    );
  });
});
