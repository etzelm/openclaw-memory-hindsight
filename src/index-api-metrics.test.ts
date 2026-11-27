import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { METRIC_FAMILIES, METRICS_ROUTE_PATH, type MetricsSink } from "./metrics.js";
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

const OWNER = { kind: "owner-private" as const, agentId: "dev" };
const CTX = { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER, runId: "r1" };
const PROMPT = {
  prompt: "where does hindsight run?",
  currentUserMessage: "where does hindsight run?",
  messages: [],
};
const RUN = {
  success: true,
  runId: "r1",
  messages: [
    { role: "user", content: "where does hindsight run?" },
    { role: "assistant", content: "on the studio" },
  ],
};
const recallUrl = "POST /v1/default/banks/dev/memories/recall";

type Sample = { kind: string; name: string; labels: object; value: number };

function fakeSink(): MetricsSink & { samples: Sample[]; broken: boolean } {
  const samples: Sample[] = [];
  const sink = {
    samples,
    broken: false,
    counter: (name: string) => ({
      inc: (labels = {}, amount = 1) => push("counter", name, labels, amount),
    }),
    gauge: (name: string) => ({
      set: (labels: object, value: number) => push("gauge", name, labels, value),
    }),
    histogram: (name: string) => ({
      observe: (labels: object, value: number) => push("histogram", name, labels, value),
    }),
  };
  function push(kind: string, name: string, labels: object, value: number) {
    if (sink.broken) {
      throw new Error("plugin metrics: recorder of a disposed instance");
    }
    samples.push({ kind, name, labels, value });
  }
  return sink;
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-api-metrics-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

function boot(fetch: (url: string, init?: RequestInit) => Promise<Response>, metrics: unknown) {
  vi.stubGlobal("fetch", fetch);
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "secret-test-token",
  };
  const on = vi.fn<AnyFn>();
  const registerService = vi.fn<AnyFn>();
  const registerHttpRoute = vi.fn<AnyFn>();
  const warn = vi.fn<AnyFn>();
  const api = {
    id: PLUGIN_ID,
    pluginConfig,
    config: {},
    logger: { info: vi.fn<AnyFn>(), warn, error: vi.fn<AnyFn>(), debug: vi.fn<AnyFn>() },
    runtime: {
      config: {
        current: () => ({ plugins: { entries: { [PLUGIN_ID]: { config: pluginConfig } } } }),
      },
    },
    on,
    registerMemoryCapability: vi.fn<AnyFn>(),
    registerTool: vi.fn<AnyFn>(),
    registerService,
    registerHttpRoute,
    ...(metrics === undefined ? {} : { metrics }),
  };
  // SAFETY: register() only uses the members above; the rest of the host API is never reached.
  memoryPlugin.register(api as unknown as OpenClawPluginApi);
  const service = registerService.mock.calls[0]?.[0];
  service.start({ stateDir });
  const hook = (name: string) => on.mock.calls.find(([hookName]) => hookName === name)?.[1];
  const routes = registerHttpRoute.mock.calls.filter(([r]) => r.path === METRICS_ROUTE_PATH);
  const scrape = () => {
    const res = {
      statusCode: 0,
      body: undefined as string | undefined,
      setHeader: vi.fn<AnyFn>(),
      end(body?: string) {
        res.body = body;
      },
    };
    routes[0]?.[0].handler({ method: "GET" } as IncomingMessage, res as unknown as ServerResponse);
    return res.body ?? "";
  };
  return { hook, routes, scrape, service, warn };
}

const recallRoutes = {
  [recallUrl]: () => ({
    json: { results: [{ id: "m1", text: "hindsight runs on the studio", type: "world" }] },
  }),
};

describe("api.metrics present", () => {
  it("registers the families through api.metrics and serves no route", async () => {
    const sink = fakeSink();
    const register = vi.fn<AnyFn>(() => sink);
    const { hook, routes, service } = boot(createFakeHindsight(recallRoutes).fetch, { register });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ families: METRIC_FAMILIES });
    expect(routes).toHaveLength(0);
    await hook("before_prompt_build")(PROMPT, CTX);
    expect(sink.samples).toContainEqual({
      kind: "counter",
      name: "recall_total",
      labels: { agent: "dev", bank: "dev", outcome: "injected" },
      value: 1,
    });
    expect(sink.samples.filter((s) => s.name === "recall_duration_seconds")).toHaveLength(1);
    service.stop();
  });

  it("pushes the queue depth when a retain is queued and when it replays", async () => {
    let down = true;
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories": () => (down ? { status: 503 } : { json: {} }),
    });
    const sink = fakeSink();
    const { hook, service } = boot(fake.fetch, { register: () => sink });
    await hook("agent_end")(RUN, CTX);
    const depth = () => sink.samples.filter((s) => s.name === "retain_queue_depth").at(-1);
    expect(sink.samples).toContainEqual({
      kind: "counter",
      name: "retain_total",
      labels: { agent: "dev", bank: "dev", outcome: "queued" },
      value: 1,
    });
    expect(depth()).toEqual({
      kind: "gauge",
      name: "retain_queue_depth",
      labels: { bank: "dev" },
      value: 1,
    });
    down = false;
    service.start({ stateDir });
    await vi.waitFor(() =>
      expect(sink.samples).toContainEqual({
        kind: "counter",
        name: "retain_queue_replays_total",
        labels: { bank: "dev", outcome: "delivered" },
        value: 1,
      }),
    );
    expect(depth()?.value).toBe(0);
    service.stop();
  });

  it("refreshes the queue depth on a timer that stop() clears", () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const sink = fakeSink();
    const { service } = boot(createFakeHindsight().fetch, { register: () => sink });
    const call = setSpy.mock.calls.find(([, ms]) => ms === 15_000);
    expect(call).toBeDefined();
    // A tick with nothing queued only refreshes the seeded owner bank heartbeat and never throws.
    const heartbeat = {
      kind: "gauge",
      name: "retain_queue_depth",
      labels: { bank: "main" },
      value: 0,
    };
    // The zero counter seeds are covered in metrics-hardening.test.ts.
    const gauges = () => sink.samples.filter((s) => s.kind === "gauge");
    expect(gauges()).toEqual([heartbeat]);
    expect(() => (call![0] as () => void)()).not.toThrow();
    expect(gauges()).toEqual([heartbeat, heartbeat]);
    const timer = setSpy.mock.results[setSpy.mock.calls.indexOf(call!)]?.value;
    service.stop();
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it("keeps the turn path working when the recorders throw after dispose", async () => {
    const sink = fakeSink();
    const writeRoutes = {
      ...recallRoutes,
      "PUT /v1/default/banks/dev": () => ({ json: {} }),
      "POST /v1/default/banks/dev/memories": () => ({ json: {} }),
    };
    const { hook, warn, service } = boot(createFakeHindsight(writeRoutes).fetch, {
      register: () => sink,
    });
    sink.broken = true;
    const result = await hook("before_prompt_build")(PROMPT, CTX);
    expect(result?.prependContext).toContain("hindsight runs on the studio");
    await expect(hook("agent_end")(RUN, CTX)).resolves.not.toThrow();
    expect(warn.mock.calls.filter(([m]) => /metrics/.test(String(m)))).toHaveLength(1);
    service.stop();
  });
});

describe("api.metrics absent or failing", () => {
  it("serves the 0.10.0 route when api.metrics is absent", async () => {
    const { hook, routes, scrape, service } = boot(
      createFakeHindsight(recallRoutes).fetch,
      undefined,
    );
    expect(routes).toHaveLength(1);
    await hook("before_prompt_build")(PROMPT, CTX);
    expect(scrape()).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="injected"} 1',
    );
    service.stop();
  });

  it("falls back to the route when register() throws", async () => {
    const register = vi.fn<AnyFn>(() => {
      throw new Error("plugin metrics: hindsight-native metrics API is no longer current");
    });
    const { hook, routes, scrape, warn, service } = boot(createFakeHindsight(recallRoutes).fetch, {
      register,
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(routes).toHaveLength(1);
    expect(warn.mock.calls.some(([m]) => /api\.metrics/.test(String(m)))).toBe(true);
    await hook("before_prompt_build")(PROMPT, CTX);
    expect(scrape()).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="injected"} 1',
    );
    service.stop();
  });
});
