import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hindsightConfigSchema } from "./config.js";
import { HindsightMetrics } from "./metrics.js";
import { RetainQueue } from "./retain-queue.js";
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
