import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import {
  COUNTER_SEEDS,
  HindsightMetrics,
  MAX_SERIES_PER_FAMILY,
  METRIC_FAMILIES,
  METRICS_ROUTE_PATH,
  type MetricsSink,
  SINK_MAX_SERIES_PER_FAMILY,
} from "./metrics.js";
import { createFakeHindsight } from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...real,
    getPluginRuntimeGatewayRequestScope: () => ({
      client: { connect: { scopes: ["operator.read"] } },
    }),
  };
});

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

type Sample = { kind: string; name: string; labels: Record<string, string>; value: number };

function fakeSink(): MetricsSink & { samples: Sample[] } {
  const samples: Sample[] = [];
  return {
    samples,
    counter: (name) => ({
      inc: (labels = {}, amount = 1) =>
        samples.push({ kind: "counter", name, labels: { ...labels }, value: amount }),
    }),
    gauge: (name) => ({
      set: (labels, value) => samples.push({ kind: "gauge", name, labels: { ...labels }, value }),
    }),
    histogram: (name) => ({
      observe: (labels, value) =>
        samples.push({ kind: "histogram", name, labels: { ...labels }, value }),
    }),
  };
}

const COUNTER_FAMILIES = METRIC_FAMILIES.filter((f) => f.type === "counter").map((f) => f.name);

/** Every zero series the owner agent and bank get at start, as route text lines. */
function zeroLines(agent: string, bank: string): string[] {
  const lines: string[] = [];
  for (const outcome of ["injected", "empty", "error", "timeout"]) {
    lines.push(
      `openclaw_hindsight_recall_total{agent="${agent}",bank="${bank}",outcome="${outcome}"} 0`,
    );
  }
  for (const reason of [
    "filter",
    "no_audience",
    "empty_query",
    "followup",
    "cache_hit",
    "breaker_open",
  ]) {
    lines.push(`openclaw_hindsight_recall_skipped_total{agent="${agent}",reason="${reason}"} 0`);
  }
  for (const outcome of ["sent", "queued", "error", "timeout"]) {
    lines.push(
      `openclaw_hindsight_retain_total{agent="${agent}",bank="${bank}",outcome="${outcome}"} 0`,
    );
  }
  for (const outcome of ["delivered", "deferred"]) {
    lines.push(
      `openclaw_hindsight_retain_queue_replays_total{bank="${bank}",outcome="${outcome}"} 0`,
    );
  }
  for (const reason of ["limit", "too_large", "rejected"]) {
    lines.push(`openclaw_hindsight_retain_queue_drops_total{bank="${bank}",reason="${reason}"} 0`);
  }
  for (const family of METRIC_FAMILIES) {
    lines.push(`openclaw_hindsight_metrics_series_folded_total{family="${family.name}"} 0`);
  }
  return lines;
}

describe("zero counters from start", () => {
  it("seeds every counter family and enum value at 0 on the route", () => {
    const metrics = new HindsightMetrics();
    metrics.seedCounters("main", "main");
    const text = metrics.render();
    for (const line of zeroLines("main", "main")) {
      expect(text).toContain(line);
    }
  });

  it("covers every declared counter family", () => {
    expect(Object.keys(COUNTER_SEEDS).toSorted()).toEqual(COUNTER_FAMILIES.toSorted());
  });

  it("pushes a zero increment for every seeded counter series to the sink", () => {
    const sink = fakeSink();
    const metrics = new HindsightMetrics({ sink });
    metrics.seedCounters("main", "main");
    const zeros = sink.samples.filter((s) => s.kind === "counter");
    expect(zeros.every((s) => s.value === 0)).toBe(true);
    expect(new Set(zeros.map((s) => s.name))).toEqual(new Set(COUNTER_FAMILIES));
    expect(zeros).toContainEqual({
      kind: "counter",
      name: "retain_queue_replays_total",
      labels: { bank: "main", outcome: "deferred" },
      value: 0,
    });
    expect(zeros).toContainEqual({
      kind: "counter",
      name: "retain_queue_drops_total",
      labels: { bank: "main", reason: "limit" },
      value: 0,
    });
    expect(zeros).toHaveLength(zeroLines("main", "main").length);
  });

  it("never resets a counter that already counted", () => {
    const metrics = new HindsightMetrics();
    metrics.recordReplay("main", "deferred");
    metrics.seedCounters("main", "main");
    expect(metrics.render()).toContain(
      'openclaw_hindsight_retain_queue_replays_total{bank="main",outcome="deferred"} 1',
    );
  });
});

describe("label-set bound fails loudly", () => {
  const sets = 130;

  it("folds past 120 with a sink, warns once per family and counts every folded sample", () => {
    const sink = fakeSink();
    const warn = vi.fn<AnyFn>();
    const metrics = new HindsightMetrics({ sink, logger: { warn } });
    for (let i = 0; i < sets; i++) {
      metrics.recordRecallSkip(`agent${i}`, "filter");
    }
    const pushed = sink.samples.filter((s) => s.name === "recall_skipped_total");
    // Every sample reached the sink: none dropped by the plugin.
    expect(pushed).toHaveLength(sets);
    const distinct = new Set(pushed.map((s) => JSON.stringify(s.labels)));
    expect(distinct.size).toBe(SINK_MAX_SERIES_PER_FAMILY + 1);
    expect(distinct.size).toBeLessThanOrEqual(128);
    expect(pushed.filter((s) => s.labels.agent === "other")).toHaveLength(sets - 120);
    const folded = sink.samples.filter((s) => s.name === "metrics_series_folded_total");
    expect(folded.reduce((n, s) => n + s.value, 0)).toBe(sets - 120);
    expect(folded.every((s) => s.labels.family === "recall_skipped_total")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("recall_skipped_total");
    expect(warn.mock.calls[0]?.[0]).toContain("120");
    expect(metrics.render()).toContain(
      'openclaw_hindsight_metrics_series_folded_total{family="recall_skipped_total"} 10',
    );
  });

  it("keeps every family under the host cap of 128 even with all enum values folded", () => {
    const sink = fakeSink();
    const metrics = new HindsightMetrics({ sink, logger: { warn: () => {} } });
    metrics.seedCounters("main", "main");
    for (let i = 0; i < sets; i++) {
      for (const outcome of ["injected", "empty", "error", "timeout"] as const) {
        metrics.recordRecall(`agent${i}`, `bank${i}`, outcome, 5);
        metrics.recordRetain(
          `agent${i}`,
          `bank${i}`,
          outcome === "injected" ? "sent" : outcome === "empty" ? "queued" : outcome,
          5,
        );
      }
      for (const reason of [
        "filter",
        "no_audience",
        "empty_query",
        "followup",
        "cache_hit",
        "breaker_open",
      ] as const) {
        metrics.recordRecallSkip(`agent${i}`, reason);
      }
      metrics.recordInjection(`agent${i}`, `bank${i}`, 2, 300);
      metrics.recordReplay(`bank${i}`, "delivered");
      metrics.recordReplay(`bank${i}`, "deferred");
      for (const reason of ["limit", "too_large", "rejected"] as const) {
        metrics.recordDrop(`bank${i}`, reason);
      }
    }
    const byFamily = new Map<string, Set<string>>();
    for (const s of sink.samples) {
      const set = byFamily.get(s.name) ?? new Set<string>();
      set.add(JSON.stringify(s.labels));
      byFamily.set(s.name, set);
    }
    const over = [...byFamily].filter(([, labelSets]) => labelSets.size > 128);
    expect(over.map(([family]) => family)).toEqual([]);
    expect(byFamily.get("recall_skipped_total")?.size).toBe(126);
  });

  it("warns once per family on the route at 200 and counts folded samples", () => {
    const warn = vi.fn<AnyFn>();
    const metrics = new HindsightMetrics({ logger: { warn } });
    for (let i = 0; i < MAX_SERIES_PER_FAMILY + 5; i++) {
      metrics.recordDrop(`bank${i}`, "limit");
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("retain_queue_drops_total");
    expect(metrics.render()).toContain(
      'openclaw_hindsight_metrics_series_folded_total{family="retain_queue_drops_total"} 5',
    );
  });

  it("declares the folded counter to api.metrics", () => {
    expect(METRIC_FAMILIES).toContainEqual({
      name: "metrics_series_folded_total",
      type: "counter",
      help: expect.any(String),
      labels: ["family"],
    });
  });
});

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-hardening-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

function boot(metricsApi: unknown) {
  vi.stubGlobal("fetch", createFakeHindsight().fetch);
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "secret-test-token",
  };
  const registerService = vi.fn<AnyFn>();
  const registerHttpRoute = vi.fn<AnyFn>();
  const api = {
    id: PLUGIN_ID,
    pluginConfig,
    config: {},
    logger: {
      info: vi.fn<AnyFn>(),
      warn: vi.fn<AnyFn>(),
      error: vi.fn<AnyFn>(),
      debug: vi.fn<AnyFn>(),
    },
    runtime: {
      config: {
        current: () => ({ plugins: { entries: { [PLUGIN_ID]: { config: pluginConfig } } } }),
      },
    },
    on: vi.fn<AnyFn>(),
    registerMemoryCapability: vi.fn<AnyFn>(),
    registerTool: vi.fn<AnyFn>(),
    registerService,
    registerHttpRoute,
    ...(metricsApi === undefined ? {} : { metrics: metricsApi }),
  };
  // SAFETY: register() only uses the members above; the rest of the host API is never reached.
  memoryPlugin.register(api as unknown as OpenClawPluginApi);
  const service = registerService.mock.calls[0]?.[0];
  service.start({ stateDir });
  const scrape = () => {
    const route = registerHttpRoute.mock.calls.find(([r]) => r.path === METRICS_ROUTE_PATH)?.[0];
    const res = {
      statusCode: 0,
      body: undefined as string | undefined,
      setHeader: vi.fn<AnyFn>(),
      end(body?: string) {
        res.body = body;
      },
    };
    route?.handler({ method: "GET" } as IncomingMessage, res as unknown as ServerResponse);
    return res.body ?? "";
  };
  return { service, scrape };
}

describe("plugin start seeds zero counters on both paths", () => {
  it("route: an idle plugin serves every counter family at 0 for the owner bank", () => {
    const { scrape, service } = boot(undefined);
    const text = scrape();
    for (const line of zeroLines("main", "main")) {
      expect(text).toContain(line);
    }
    service.stop();
  });

  it("api.metrics: an idle plugin pushes a zero increment for every counter family", () => {
    const sink = fakeSink();
    const { service } = boot({ register: () => sink });
    const zeros = sink.samples.filter((s) => s.kind === "counter");
    expect(new Set(zeros.map((s) => s.name))).toEqual(new Set(COUNTER_FAMILIES));
    expect(zeros.every((s) => s.value === 0)).toBe(true);
    expect(zeros).toContainEqual({
      kind: "counter",
      name: "retain_queue_drops_total",
      labels: { bank: "main", reason: "rejected" },
      value: 0,
    });
    service.stop();
  });
});
