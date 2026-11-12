import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { METRICS_ROUTE_PATH } from "./metrics.js";
import { createFakeHindsight, createHangingFetch, spyOnTimeouts } from "./test-helpers.js";

// The route checks the caller's scopes through the host's request scope; tests set them here.
const scopeState = vi.hoisted(() => ({ scopes: ["operator.read"] as string[] }));
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...real,
    getPluginRuntimeGatewayRequestScope: () => ({
      client: { connect: { scopes: scopeState.scopes } },
    }),
  };
});

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

const OWNER = { kind: "owner-private" as const, agentId: "dev" };
const CONVERSATION = {
  kind: "conversation" as const,
  agentId: "dev",
  sessionKey: "agent:dev:telegram:group:-100",
  sessionId: "s1",
};
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

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-metrics-"));
  scopeState.scopes = ["operator.read"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(stateDir, { recursive: true, force: true });
});

function boot(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  extra: Record<string, unknown> = {},
) {
  vi.stubGlobal("fetch", fetch);
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "secret-test-token",
    ...extra,
  };
  const on = vi.fn<AnyFn>();
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
    on,
    registerMemoryCapability: vi.fn<AnyFn>(),
    registerTool: vi.fn<AnyFn>(),
    registerService,
    registerHttpRoute,
  };
  // SAFETY: register() only uses the members above; the rest of the host API is never reached.
  memoryPlugin.register(api as unknown as OpenClawPluginApi);
  registerService.mock.calls[0]?.[0].start({ stateDir });
  const hook = (name: string) => on.mock.calls.find(([hookName]) => hookName === name)?.[1];
  const route = registerHttpRoute.mock.calls[0]?.[0];
  const scrape = (method = "GET") => {
    const res = {
      statusCode: 0,
      body: undefined as string | undefined,
      setHeader: vi.fn<AnyFn>(),
      end(body?: string) {
        res.body = body;
      },
    };
    route.handler({ method } as IncomingMessage, res as unknown as ServerResponse);
    return res;
  };
  const samples = () =>
    (scrape().body ?? "").split("\n").filter((line) => line && !line.startsWith("#"));
  return { hook, route, scrape, samples, registerService };
}

const recallUrl = "POST /v1/default/banks/dev/memories/recall";

function stale(): never {
  throw new Error("memory audience is no longer current");
}

describe("metrics route registration", () => {
  it("registers one gateway-auth exact route on the gateway port", () => {
    const { route } = boot(createFakeHindsight().fetch);
    expect(route).toMatchObject({
      path: METRICS_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
    });
    expect(METRICS_ROUTE_PATH).toBe("/plugins/hindsight-native/metrics");
  });

  it("refuses a caller without read scope", () => {
    const { scrape } = boot(createFakeHindsight().fetch);
    scopeState.scopes = [];
    expect(scrape().statusCode).toBe(403);
    scopeState.scopes = ["operator.write"];
    expect(scrape().statusCode).toBe(200);
  });
});

describe("auto-recall metrics", () => {
  it("counts an injected recall and its latency", async () => {
    const fake = createFakeHindsight({
      [recallUrl]: () => ({ json: { results: [{ id: "m1", text: "Studio", type: "world" }] } }),
    });
    const { hook, samples } = boot(fake.fetch);
    await hook("before_prompt_build")(PROMPT, CTX);
    expect(samples()).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="injected"} 1',
    );
    expect(samples()).toContain(
      'openclaw_hindsight_recall_duration_seconds_count{agent="dev",bank="dev"} 1',
    );
  });

  it("counts no results and a missing bank as empty, conversation banks folded", async () => {
    const fake = createFakeHindsight({ [recallUrl]: () => ({ json: { results: [] } }) });
    const { hook, samples } = boot(fake.fetch);
    await hook("before_prompt_build")(PROMPT, CTX);
    // Unknown route in the fake: an empty 404, which the client reads as a missing bank.
    await hook("before_prompt_build")(PROMPT, {
      agentId: "dev",
      sessionKey: CONVERSATION.sessionKey,
      memoryAudience: CONVERSATION,
    });
    const lines = samples();
    expect(lines).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="empty"} 1',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev::conv",outcome="empty"} 1',
    );
    expect(lines.join("\n")).not.toContain("telegram");
  });

  it("counts a server error as error and a timeout as timeout", async () => {
    const fake = createFakeHindsight({ [recallUrl]: () => ({ status: 500, json: {} }) });
    const { hook, samples } = boot(fake.fetch);
    await hook("before_prompt_build")(PROMPT, CTX);
    expect(samples()).toContain(
      'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="error"} 1',
    );

    const timeouts = spyOnTimeouts();
    try {
      const slow = boot(createHangingFetch());
      await slow.hook("before_prompt_build")(PROMPT, CTX);
      expect(slow.samples()).toContain(
        'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="timeout"} 1',
      );
    } finally {
      timeouts.restore();
    }
  });

  it("records nothing when a host assert cancels the recall, before or after the request", async () => {
    const fake = createFakeHindsight({
      [recallUrl]: () => ({ json: { results: [{ id: "m1", text: "Studio", type: "world" }] } }),
    });
    const { hook, samples } = boot(fake.fetch);
    await hook("before_prompt_build")(PROMPT, { ...CTX, assertMemoryAudienceCurrent: stale });
    expect(fake.requests).toEqual([]);
    await hook("before_prompt_build")(PROMPT, {
      ...CTX,
      hookInvocation: { assertActive: stale },
    });
    expect(fake.requests).toHaveLength(1);
    expect(samples()).toEqual([]);
  });

  it("records no recall outcome or latency for a skipped recall, only the skip", async () => {
    const fake = createFakeHindsight();
    const { hook, samples } = boot(fake.fetch);
    await hook("before_prompt_build")(PROMPT, { agentId: "dev", sessionKey: "agent:dev:main" });
    expect(samples()).toEqual([
      'openclaw_hindsight_recall_skipped_total{agent="dev",reason="no_audience"} 1',
    ]);
  });
});

describe("auto-retain metrics", () => {
  const writeRoutes = {
    "PUT /v1/default/banks/dev": () => ({ json: {} }),
    "POST /v1/default/banks/dev/memories": () => ({ json: {} }),
  };

  it("counts a sent retain and its latency", async () => {
    const { hook, samples } = boot(createFakeHindsight(writeRoutes).fetch);
    await hook("agent_end")(RUN, CTX);
    expect(samples()).toContain(
      'openclaw_hindsight_retain_total{agent="dev",bank="dev",outcome="sent"} 1',
    );
    expect(samples()).toContain(
      'openclaw_hindsight_retain_duration_seconds_count{agent="dev",bank="dev"} 1',
    );
  });

  it("counts a queued retain and shows the queue depth, then the replay", async () => {
    let down = true;
    const fake = createFakeHindsight({
      // No retainMission, so there is no bank setup call: the write itself fails.
      "POST /v1/default/banks/dev/memories": () => (down ? { status: 503 } : { json: {} }),
    });
    const { hook, samples, registerService } = boot(fake.fetch);
    await hook("agent_end")(RUN, CTX);
    let lines = samples();
    expect(lines).toContain(
      'openclaw_hindsight_retain_total{agent="dev",bank="dev",outcome="queued"} 1',
    );
    expect(lines).toContain('openclaw_hindsight_retain_queue_depth{bank="dev"} 1');
    // A restart replays what the queue holds.
    down = false;
    const service = registerService.mock.calls[0]?.[0];
    service.start({ stateDir });
    await vi.waitFor(() =>
      expect(samples()).toContain(
        'openclaw_hindsight_retain_queue_replays_total{bank="dev",outcome="delivered"} 1',
      ),
    );
    lines = samples();
    expect(lines).toContain('openclaw_hindsight_retain_queue_depth{bank="dev"} 0');
    service.stop();
  });

  it("counts a rejected retain as error", async () => {
    const fake = createFakeHindsight({
      "PUT /v1/default/banks/dev": () => ({ json: {} }),
      "POST /v1/default/banks/dev/memories": () => ({ status: 422, json: {} }),
    });
    const { hook, samples } = boot(fake.fetch);
    await hook("agent_end")(RUN, CTX);
    expect(samples()).toContain(
      'openclaw_hindsight_retain_total{agent="dev",bank="dev",outcome="error"} 1',
    );
  });

  it("counts a timed-out retain as timeout when the queue is off", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { hook, samples } = boot(createHangingFetch(), { retainQueueEnabled: false });
      await hook("agent_end")(RUN, CTX);
      expect(samples()).toContain(
        'openclaw_hindsight_retain_total{agent="dev",bank="dev",outcome="timeout"} 1',
      );
    } finally {
      timeouts.restore();
    }
  });
});

const skips = (lines: string[]) =>
  lines.filter((l) => l.startsWith("openclaw_hindsight_recall_skipped_total"));

describe("auto-recall skip and injection metrics", () => {
  const FACTS = {
    [recallUrl]: () => ({
      json: {
        results: [
          { id: "m1", text: "Studio hosts Hindsight", type: "world" },
          { id: "m2", text: "The mini runs the gateway", type: "world" },
        ],
      },
    }),
  };

  it("counts session filters, a missing audience and an empty query, and nothing else", async () => {
    const { hook, samples } = boot(createFakeHindsight(FACTS).fetch, {
      excludeProviders: ["heartbeat"],
    });
    const run = hook("before_prompt_build");
    await run(PROMPT, { ...CTX, messageProvider: "heartbeat" });
    await run(PROMPT, { ...CTX, sessionKey: "agent:dev:dashboard:incognito-x" });
    await run(PROMPT, { agentId: "dev", sessionKey: "agent:dev:main" });
    await run({ prompt: "", currentUserMessage: "", messages: [] }, CTX);
    // A maintenance turn is host housekeeping, not a skipped recall.
    await run(PROMPT, { ...CTX, trigger: "memory" });
    expect(skips(samples()).toSorted()).toEqual([
      'openclaw_hindsight_recall_skipped_total{agent="dev",reason="empty_query"} 1',
      'openclaw_hindsight_recall_skipped_total{agent="dev",reason="filter"} 2',
      'openclaw_hindsight_recall_skipped_total{agent="dev",reason="no_audience"} 1',
    ]);
  });

  it("counts a cache hit and a follow-up skip", async () => {
    const { hook, samples } = boot(createFakeHindsight(FACTS).fetch, {
      recallCacheTtlMs: 600_000,
      recallFollowupMaxWords: 3,
    });
    const run = hook("before_prompt_build");
    await run(PROMPT, CTX);
    await run(PROMPT, CTX);
    await run({ prompt: "and the mini", currentUserMessage: "and the mini", messages: [] }, CTX);
    expect(skips(samples()).toSorted()).toEqual([
      'openclaw_hindsight_recall_skipped_total{agent="dev",reason="cache_hit"} 1',
      'openclaw_hindsight_recall_skipped_total{agent="dev",reason="followup"} 1',
    ]);
  });

  it("observes the count and size of every injected block, fresh or cached", async () => {
    const { hook, samples } = boot(createFakeHindsight(FACTS).fetch, {
      recallCacheTtlMs: 600_000,
    });
    const run = hook("before_prompt_build");
    const first = await run(PROMPT, CTX);
    await run(PROMPT, CTX);
    const chars = String(first.prependContext).length;
    const lines = samples();
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_memories_count{agent="dev",bank="dev"} 2',
    );
    expect(lines).toContain(
      'openclaw_hindsight_recall_injected_memories_sum{agent="dev",bank="dev"} 4',
    );
    expect(lines).toContain(
      `openclaw_hindsight_recall_injected_chars_sum{agent="dev",bank="dev"} ${chars * 2}`,
    );
  });

  it("observes nothing for an empty recall", async () => {
    const { hook, samples } = boot(
      createFakeHindsight({ [recallUrl]: () => ({ json: { results: [] } }) }).fetch,
    );
    await hook("before_prompt_build")(PROMPT, CTX);
    expect(samples().filter((l) => l.includes("recall_injected_"))).toEqual([]);
  });
});

describe("auto-recall skips while the circuit breaker is open", () => {
  it("counts each skipped turn as breaker_open", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { hook, samples } = boot(createHangingFetch());
      const run = hook("before_prompt_build");
      for (let i = 0; i < 5; i++) {
        await run(PROMPT, CTX);
      }
      expect(skips(samples())).toEqual([
        'openclaw_hindsight_recall_skipped_total{agent="dev",reason="breaker_open"} 2',
      ]);
      expect(samples()).toContain(
        'openclaw_hindsight_recall_total{agent="dev",bank="dev",outcome="timeout"} 3',
      );
    } finally {
      timeouts.restore();
    }
  });
});

describe("injection metrics with recallTopK", () => {
  it("observes the capped block, not every result Hindsight returned", async () => {
    const fake = createFakeHindsight({
      [recallUrl]: () => ({
        json: {
          results: [
            { id: "m1", text: "one", type: "world" },
            { id: "m2", text: "two", type: "world" },
            { id: "m3", text: "three", type: "world" },
          ],
        },
      }),
    });
    const { hook, samples } = boot(fake.fetch, { recallTopK: 2 });
    await hook("before_prompt_build")(PROMPT, CTX);
    expect(samples()).toContain(
      'openclaw_hindsight_recall_injected_memories_sum{agent="dev",bank="dev"} 2',
    );
  });
});

describe("skip metrics with recallQueryShaping", () => {
  it("counts an envelope-only message under strip as empty_query, with no request", async () => {
    const fake = createFakeHindsight();
    const { hook, samples } = boot(fake.fetch, { recallQueryShaping: "strip" });
    const envelope =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n## Current Run\nrun notes\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    await hook("before_prompt_build")(
      { prompt: envelope, currentUserMessage: envelope, messages: [] },
      CTX,
    );
    expect(fake.requests).toEqual([]);
    expect(skips(samples())).toEqual([
      'openclaw_hindsight_recall_skipped_total{agent="dev",reason="empty_query"} 1',
    ]);
  });
});
