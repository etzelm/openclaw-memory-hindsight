import { describe, expect, it, vi } from "vitest";
import {
  HindsightMetrics,
  INJECTED_CHARS_BUCKETS,
  INJECTED_COUNT_BUCKETS,
  LATENCY_BUCKETS,
  METRIC_FAMILIES,
  type MetricsSink,
  openMetricsSink,
  SINK_MAX_SERIES_PER_FAMILY,
} from "./metrics.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

type Sample = {
  kind: "counter" | "gauge" | "histogram";
  name: string;
  labels: object;
  value: number;
};

/** A recorder double shaped like the host's `api.metrics.register()` result. */
function fakeSink(): MetricsSink & { samples: Sample[] } {
  const samples: Sample[] = [];
  return {
    samples,
    counter: (name) => ({
      inc: (labels = {}, amount = 1) =>
        samples.push({ kind: "counter", name, labels, value: amount }),
    }),
    gauge: (name) => ({
      set: (labels, value) => samples.push({ kind: "gauge", name, labels, value }),
    }),
    histogram: (name) => ({
      observe: (labels, value) => samples.push({ kind: "histogram", name, labels, value }),
    }),
  };
}

function boom(): never {
  throw new Error("disposed");
}

const logger = () => ({ warn: vi.fn<AnyFn>(), debug: vi.fn<AnyFn>() });

describe("metric families for api.metrics", () => {
  it("declares the route families plus the fold counter with host-valid names, labels and buckets", () => {
    expect(METRIC_FAMILIES.map((f) => [f.name, f.type, f.labels])).toEqual([
      ["recall_total", "counter", ["agent", "bank", "outcome"]],
      ["recall_duration_seconds", "histogram", ["agent", "bank"]],
      ["recall_skipped_total", "counter", ["agent", "reason"]],
      ["recall_injected_memories", "histogram", ["agent", "bank"]],
      ["recall_injected_chars", "histogram", ["agent", "bank"]],
      ["retain_total", "counter", ["agent", "bank", "outcome"]],
      ["retain_duration_seconds", "histogram", ["agent", "bank"]],
      ["retain_queue_depth", "gauge", ["bank"]],
      ["retain_queue_replays_total", "counter", ["bank", "outcome"]],
      ["retain_queue_drops_total", "counter", ["bank", "reason"]],
      ["metrics_series_folded_total", "counter", ["family"]],
    ]);
    const buckets = Object.fromEntries(
      METRIC_FAMILIES.flatMap((f) => (f.type === "histogram" ? [[f.name, f.buckets]] : [])),
    );
    expect(buckets).toEqual({
      recall_duration_seconds: LATENCY_BUCKETS,
      recall_injected_memories: INJECTED_COUNT_BUCKETS,
      recall_injected_chars: INJECTED_CHARS_BUCKETS,
      retain_duration_seconds: LATENCY_BUCKETS,
    });
    for (const family of METRIC_FAMILIES) {
      expect(family.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(family.name.startsWith("openclaw_")).toBe(false);
      expect(family.type !== "counter" || family.name.endsWith("_total")).toBe(true);
      expect(family.help.length).toBeGreaterThan(0);
    }
  });
});

describe("openMetricsSink", () => {
  it("returns undefined without api.metrics", () => {
    const log = logger();
    expect(openMetricsSink(undefined, log)).toBeUndefined();
    expect(openMetricsSink({}, log)).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("registers every family once and returns the recorders", () => {
    const sink = fakeSink();
    const register = vi.fn<AnyFn>(() => sink);
    expect(openMetricsSink({ register }, logger())).toBe(sink);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ families: METRIC_FAMILIES });
  });

  it("returns undefined and warns when register() throws", () => {
    const log = logger();
    const register = vi.fn<AnyFn>(() => {
      throw new Error("plugin metrics: hindsight-native metrics API is no longer current");
    });
    expect(openMetricsSink({ register }, log)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/api\.metrics.*no longer current.*route/);
  });
});

describe("HindsightMetrics with a sink", () => {
  it("forwards every record with the route's labels", () => {
    const sink = fakeSink();
    const metrics = new HindsightMetrics({ sink });
    metrics.recordRecall("dev", "dev::conv::abc", "injected", 250);
    metrics.recordRecallSkip("dev", "cache_hit");
    metrics.recordInjection("dev", "dev", 3, 900);
    metrics.recordRetain("dev", "dev", "sent", 1500);
    metrics.recordReplay("dev", "delivered");
    metrics.recordDrop("dev", "limit", 2);
    metrics.recordDrop("dev", "limit", 0);
    expect(sink.samples).toEqual([
      {
        kind: "counter",
        name: "recall_total",
        labels: { agent: "dev", bank: "dev::conv", outcome: "injected" },
        value: 1,
      },
      {
        kind: "histogram",
        name: "recall_duration_seconds",
        labels: { agent: "dev", bank: "dev::conv" },
        value: 0.25,
      },
      {
        kind: "counter",
        name: "recall_skipped_total",
        labels: { agent: "dev", reason: "cache_hit" },
        value: 1,
      },
      {
        kind: "histogram",
        name: "recall_injected_memories",
        labels: { agent: "dev", bank: "dev" },
        value: 3,
      },
      {
        kind: "histogram",
        name: "recall_injected_chars",
        labels: { agent: "dev", bank: "dev" },
        value: 900,
      },
      {
        kind: "counter",
        name: "retain_total",
        labels: { agent: "dev", bank: "dev", outcome: "sent" },
        value: 1,
      },
      {
        kind: "histogram",
        name: "retain_duration_seconds",
        labels: { agent: "dev", bank: "dev" },
        value: 1.5,
      },
      {
        kind: "counter",
        name: "retain_queue_replays_total",
        labels: { bank: "dev", outcome: "delivered" },
        value: 1,
      },
      {
        kind: "counter",
        name: "retain_queue_drops_total",
        labels: { bank: "dev", reason: "limit" },
        value: 2,
      },
    ]);
  });

  it("folds new agents into other below the host's 128 label sets", () => {
    expect(SINK_MAX_SERIES_PER_FAMILY).toBeLessThanOrEqual(128);
    const sink = fakeSink();
    const metrics = new HindsightMetrics({ sink });
    for (let i = 0; i < 130; i += 1) {
      metrics.recordRecallSkip(`agent${i}`, "filter");
    }
    const skips = sink.samples.filter((s) => s.name === "recall_skipped_total");
    const agents = new Set(skips.map((s) => (s.labels as { agent: string }).agent));
    expect(agents.size).toBe(SINK_MAX_SERIES_PER_FAMILY + 1);
    expect(agents.has("other")).toBe(true);
  });

  it("pushes queue depth per bank and a drained bank as 0", () => {
    const sink = fakeSink();
    const metrics = new HindsightMetrics({ sink });
    metrics.publishQueueDepth(
      () =>
        new Map([
          ["dev", 2],
          ["dev::conv::x", 1],
        ]),
    );
    metrics.publishQueueDepth(() => new Map());
    expect(sink.samples).toEqual([
      { kind: "gauge", name: "retain_queue_depth", labels: { bank: "dev" }, value: 2 },
      { kind: "gauge", name: "retain_queue_depth", labels: { bank: "dev::conv" }, value: 1 },
      { kind: "gauge", name: "retain_queue_depth", labels: { bank: "dev" }, value: 0 },
      { kind: "gauge", name: "retain_queue_depth", labels: { bank: "dev::conv" }, value: 0 },
    ]);
  });

  it("seeds one zero depth sample for the owner bank on an idle plugin", () => {
    const sink = fakeSink();
    const metrics = new HindsightMetrics({ sink });
    metrics.seedQueueDepth("main");
    metrics.publishQueueDepth(() => new Map());
    expect(sink.samples).toEqual([
      { kind: "gauge", name: "retain_queue_depth", labels: { bank: "main" }, value: 0 },
    ]);
  });

  it("renders the seeded owner bank at 0 without a sink", () => {
    const metrics = new HindsightMetrics();
    metrics.seedQueueDepth("main");
    expect(metrics.render(() => new Map())).toContain(
      'openclaw_hindsight_retain_queue_depth{bank="main"} 0',
    );
  });

  it("does not reset an existing nonzero depth when seeding", () => {
    const sink = fakeSink();
    const metrics = new HindsightMetrics({ sink });
    metrics.publishQueueDepth(() => new Map([["main", 3]]));
    metrics.seedQueueDepth("main");
    metrics.publishQueueDepth(() => new Map([["main", 3]]));
    expect(sink.samples.map((s) => s.value)).toEqual([3, 3]);
  });

  it("swallows a recorder that throws and warns once", () => {
    const sink: MetricsSink = {
      counter: () => ({ inc: boom }),
      gauge: () => ({ set: boom }),
      histogram: () => ({ observe: boom }),
    };
    const log = logger();
    const metrics = new HindsightMetrics({ sink, logger: log });
    expect(() => {
      metrics.recordRecall("dev", "dev", "error", 10);
      metrics.recordRecallSkip("dev", "filter");
      metrics.recordInjection("dev", "dev", 1, 10);
      metrics.recordRetain("dev", "dev", "error", 10);
      metrics.recordReplay("dev", "deferred");
      metrics.recordDrop("dev", "rejected");
      metrics.publishQueueDepth(() => new Map([["dev", 1]]));
    }).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("keeps the 0.10.0 render and fold bound without a sink", () => {
    const metrics = new HindsightMetrics();
    metrics.recordRecall("dev", "dev", "empty", 5);
    expect(metrics.render()).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="empty"} 1',
    );
  });
});
