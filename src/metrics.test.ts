import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  agentLabel,
  bankLabel,
  createMetricsRouteHandler,
  HindsightMetrics,
  INJECTED_CHARS_BUCKETS,
  INJECTED_COUNT_BUCKETS,
  isTimeoutError,
  MAX_SERIES_PER_FAMILY,
  RECALL_SKIP_REASONS,
} from "./metrics.js";

function sampleLines(text: string): string[] {
  return text.split("\n").filter((line) => line && !line.startsWith("#"));
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      res.body = body;
    },
  };
  return { res, headers };
}

function call(
  handler: ReturnType<typeof createMetricsRouteHandler>,
  method: string,
): ReturnType<typeof fakeResponse> & { handled: boolean } {
  const out = fakeResponse();
  // SAFETY: the handler reads only req.method and calls only setHeader/end/statusCode.
  const handled = handler({ method } as IncomingMessage, out.res as unknown as ServerResponse);
  return { ...out, handled };
}

describe("metric labels", () => {
  it("folds conversation banks into one label per owner bank", () => {
    expect(bankLabel("dev")).toBe("dev");
    expect(bankLabel("dev::conv::0123456789abcdef")).toBe("dev::conv");
    expect(bankLabel("shared::conv::fedcba9876543210")).toBe("shared::conv");
    expect(bankLabel(undefined)).toBe("unknown");
    expect(bankLabel("")).toBe("unknown");
  });

  it("never lets session-shaped or free-text values through", () => {
    expect(agentLabel("dev")).toBe("dev");
    expect(agentLabel(" Dev ")).toBe("dev");
    // Label-safe but not an agent id: never attributed to the default agent.
    expect(agentLabel(":-:")).toBe("unknown");
    expect(agentLabel(undefined)).toBe("unknown");
    expect(agentLabel("agent:dev:telegram:direct:42")).toBe("unknown");
    expect(agentLabel("two words")).toBe("unknown");
    expect(bankLabel('a"b\nc')).toBe("unknown");
  });

  it("recognizes only AbortSignal.timeout errors as timeouts", () => {
    expect(isTimeoutError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isTimeoutError(new DOMException("a", "AbortError"))).toBe(false);
    expect(isTimeoutError(new Error("boom"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});

describe("HindsightMetrics.render", () => {
  it("prints HELP and TYPE for every family even with no samples", () => {
    const text = new HindsightMetrics().render();
    for (const [name, type] of [
      ["recall_total", "counter"],
      ["recall_duration_seconds", "histogram"],
      ["retain_total", "counter"],
      ["retain_duration_seconds", "histogram"],
      ["retain_queue_depth", "gauge"],
      ["retain_queue_replays_total", "counter"],
      ["retain_queue_drops_total", "counter"],
    ]) {
      expect(text).toContain(`# TYPE openclaw_hindsight_${name} ${type}\n`);
    }
    expect(sampleLines(text)).toEqual([]);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("counts recalls by outcome with agent and bank labels and a latency histogram", () => {
    const metrics = new HindsightMetrics();
    metrics.recordRecall("dev", "dev", "injected", 40);
    metrics.recordRecall("dev", "dev", "injected", 300);
    metrics.recordRecall("dev", "dev::conv::0123456789abcdef", "empty", 20);
    metrics.recordRecall("dev", "dev", "timeout", 10_000);
    metrics.recordRecall("dev", "dev", "error", 5);
    const lines = sampleLines(metrics.render());
    expect(lines).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="injected"} 2',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev::conv",outcome="empty"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="timeout"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="error"} 1',
    );
    const h = 'openclaw_hindsight_recall_duration_seconds_bucket{agent="dev",bank="dev",';
    expect(lines).toContain(`${h}le="0.025"} 1`);
    expect(lines).toContain(`${h}le="0.05"} 2`);
    expect(lines).toContain(`${h}le="0.5"} 3`);
    expect(lines).toContain(`${h}le="10"} 4`);
    expect(lines).toContain(`${h}le="+Inf"} 4`);
    expect(lines).toContain(
      'openclaw_hindsight_recall_duration_seconds_count{agent="dev",bank="dev"} 4',
    );
    const sum = lines.find((l) =>
      l.startsWith('openclaw_hindsight_recall_duration_seconds_sum{agent="dev",bank="dev"}'),
    );
    expect(Number(sum?.split(" ")[1])).toBeCloseTo(10.345, 6);
  });

  it("counts retains by outcome and clamps negative durations to zero", () => {
    const metrics = new HindsightMetrics();
    metrics.recordRetain("dev", "dev", "sent", -5);
    metrics.recordRetain("main", "shared", "queued", 31_000);
    const lines = sampleLines(metrics.render());
    expect(lines).toContain(
      'openclaw_hindsight_retain_total{agent="dev",bank="dev",outcome="sent"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_retain_total{agent="main",bank="shared",outcome="queued"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_retain_duration_seconds_bucket{agent="dev",bank="dev",le="0.025"} 1',
    );
    // 31 s is past the largest bucket: only +Inf holds it.
    expect(lines).toContain(
      'openclaw_hindsight_retain_duration_seconds_bucket{agent="main",bank="shared",le="30"} 0',
    );
    expect(lines).toContain(
      'openclaw_hindsight_retain_duration_seconds_bucket{agent="main",bank="shared",le="+Inf"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_retain_duration_seconds_sum{agent="dev",bank="dev"} 0',
    );
  });

  it("renders queue depth per folded bank, replays and drops", () => {
    const metrics = new HindsightMetrics();
    metrics.recordReplay("dev", "delivered");
    metrics.recordReplay("dev", "delivered");
    metrics.recordReplay("dev::conv::aaaa", "deferred");
    metrics.recordDrop("dev", "limit", 3);
    metrics.recordDrop("dev", "rejected");
    metrics.recordDrop("dev", "too_large", 0);
    const depth = new Map([
      ["dev", 2],
      ["dev::conv::aaaa", 1],
      ["dev::conv::bbbb", 4],
    ]);
    const lines = sampleLines(metrics.render(() => depth));
    expect(lines).toContain('openclaw_hindsight_retain_queue_depth{bank="dev"} 2');
    expect(lines).toContain('openclaw_hindsight_retain_queue_depth{bank="dev::conv"} 5');
    expect(lines).toContain(
      'openclaw_hindsight_retain_queue_replays_total{bank="dev",outcome="delivered"} 2',
    );
    expect(lines).toContain(
      'openclaw_hindsight_retain_queue_replays_total{bank="dev::conv",outcome="deferred"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_retain_queue_drops_total{bank="dev",reason="limit"} 3',
    );
    expect(lines).toContain(
      'openclaw_hindsight_retain_queue_drops_total{bank="dev",reason="rejected"} 1',
    );
    expect(lines.some((l) => l.includes('reason="too_large"'))).toBe(false);
  });

  it("keeps a drained bank at depth 0", () => {
    const metrics = new HindsightMetrics();
    metrics.render(() => new Map([["dev", 3]]));
    const lines = sampleLines(metrics.render(() => new Map()));
    expect(lines).toContain('openclaw_hindsight_retain_queue_depth{bank="dev"} 0');
  });

  it("prints no depth samples when the queue is off", () => {
    const text = new HindsightMetrics().render(() => undefined);
    expect(text).not.toMatch(/^openclaw_hindsight_retain_queue_depth\{/m);
  });

  it("folds agent and bank past the per-family bound and keeps the enum labels", () => {
    const metrics = new HindsightMetrics();
    for (let i = 0; i < MAX_SERIES_PER_FAMILY + 5; i += 1) {
      metrics.recordDrop(`bank${i}`, "limit");
    }
    metrics.recordDrop("bank-late", "rejected");
    const drops = sampleLines(metrics.render()).filter((l) =>
      l.startsWith("openclaw_hindsight_retain_queue_drops_total"),
    );
    expect(drops).toHaveLength(MAX_SERIES_PER_FAMILY + 2);
    expect(drops).toContain(
      'openclaw_hindsight_retain_queue_drops_total{bank="other",reason="limit"} 5',
    );
    expect(drops).toContain(
      'openclaw_hindsight_retain_queue_drops_total{bank="other",reason="rejected"} 1',
    );
  });
});

describe("metrics route handler", () => {
  it("serves Prometheus text to a caller with read scope", () => {
    const metrics = new HindsightMetrics();
    metrics.recordRetain("dev", "dev", "sent", 12);
    const handler = createMetricsRouteHandler(
      metrics,
      () => new Map([["dev", 1]]),
      () => true,
    );
    const { res, headers, handled } = call(handler, "GET");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain('openclaw_hindsight_retain_queue_depth{bank="dev"} 1');
    expect(headers["content-length"]).toBe(String(Buffer.byteLength(res.body!, "utf8")));
  });

  it("answers HEAD with headers and no body", () => {
    const handler = createMetricsRouteHandler(
      new HindsightMetrics(),
      () => undefined,
      () => true,
    );
    const { res, headers } = call(handler, "HEAD");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
    expect(Number(headers["content-length"])).toBeGreaterThan(0);
  });

  it("refuses other methods", () => {
    const handler = createMetricsRouteHandler(
      new HindsightMetrics(),
      () => undefined,
      () => true,
    );
    const { res, headers } = call(handler, "POST");
    expect(res.statusCode).toBe(405);
    expect(headers.allow).toBe("GET, HEAD");
  });

  it("fails closed without read scope, before rendering", () => {
    let rendered = false;
    const handler = createMetricsRouteHandler(
      new HindsightMetrics(),
      () => {
        rendered = true;
        return undefined;
      },
      () => false,
    );
    const { res } = call(handler, "GET");
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("missing scope: operator.read");
    expect(rendered).toBe(false);
  });

  it("denies by default outside a gateway request scope", () => {
    const handler = createMetricsRouteHandler(new HindsightMetrics(), () => undefined);
    expect(call(handler, "GET").res.statusCode).toBe(403);
  });
});

describe("recall skip and injection metrics", () => {
  it("counts skips by agent and reason, with no bank label", () => {
    const m = new HindsightMetrics();
    m.recordRecallSkip("dev", "cache_hit");
    m.recordRecallSkip("dev", "cache_hit");
    m.recordRecallSkip("main", "breaker_open");
    const text = m.render();
    expect(text).toContain("# TYPE openclaw_hindsight_recall_skipped_total counter");
    const lines = sampleLines(text);
    expect(lines).toContain(
      'openclaw_hindsight_recall_skipped_total{agent="dev",reason="cache_hit"} 2',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_skipped_total{agent="main",reason="breaker_open"} 1',
    );
  });

  it("declares every skip reason", () => {
    expect(RECALL_SKIP_REASONS).toEqual([
      "filter",
      "no_audience",
      "empty_query",
      "followup",
      "cache_hit",
      "breaker_open",
    ]);
  });

  it("observes injected memory count and characters in their own buckets", () => {
    const m = new HindsightMetrics();
    m.recordInjection("dev", "dev::conv::0123456789abcdef", 3, 1200);
    const lines = sampleLines(m.render());
    expect(INJECTED_COUNT_BUCKETS).toEqual([1, 2, 3, 5, 8, 10, 15, 20, 30, 50]);
    expect(INJECTED_CHARS_BUCKETS).toEqual([250, 500, 1000, 2000, 4000, 8000, 16000, 32000]);
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_memories_bucket{agent="dev",bank="dev::conv",le="2"} 0',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_memories_bucket{agent="dev",bank="dev::conv",le="3"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_memories_sum{agent="dev",bank="dev::conv"} 3',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_chars_bucket{agent="dev",bank="dev::conv",le="1000"} 0',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_chars_bucket{agent="dev",bank="dev::conv",le="2000"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_chars_bucket{agent="dev",bank="dev::conv",le="+Inf"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_chars_count{agent="dev",bank="dev::conv"} 1',
    );
  });

  it("keeps the latency histogram in seconds", () => {
    const m = new HindsightMetrics();
    m.recordRecall("dev", "dev", "injected", 1500);
    const lines = sampleLines(m.render());
    expect(lines).toContain(
      'openclaw_hindsight_recall_duration_seconds_sum{agent="dev",bank="dev"} 1.5',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_duration_seconds_bucket{agent="dev",bank="dev",le="2.5"} 1',
    );
  });
});
