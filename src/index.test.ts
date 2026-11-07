import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryPlugin, { PLUGIN_ID, readPluginConfigEntry, sessionKeyDigest } from "./index.js";
import { createFakeHindsight, createHangingFetch, spyOnTimeouts } from "./test-helpers.js";

/**
 * Local stand-in for the host's plugin API. The host's own test helpers
 * (plugin-sdk/plugin-test-api, channel-test-helpers) are not exported by the openclaw package,
 * so this fake captures only what register() touches.
 */
function createFakePluginApi(params: {
  pluginConfig?: Record<string, unknown>;
  config?: unknown;
  on?: AnyFn;
  registerMemoryCapability?: AnyFn;
  registerTool?: AnyFn;
  registerService?: AnyFn;
}): OpenClawPluginApi {
  const fake = {
    id: PLUGIN_ID,
    pluginConfig: params.pluginConfig,
    config: params.config ?? {},
    logger: {
      info: vi.fn<AnyFn>(),
      warn: vi.fn<AnyFn>(),
      error: vi.fn<AnyFn>(),
      debug: vi.fn<AnyFn>(),
    },
    runtime: { config: { current: () => params.config ?? {} } },
    on: params.on ?? vi.fn<AnyFn>(),
    registerMemoryCapability: params.registerMemoryCapability ?? vi.fn<AnyFn>(),
    registerTool: params.registerTool ?? vi.fn<AnyFn>(),
    registerService: params.registerService ?? vi.fn<AnyFn>(),
  };
  // SAFETY: register() only uses the members above; the rest of the host API is never reached.
  return fake as unknown as OpenClawPluginApi;
}

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

const OWNER = { kind: "owner-private" as const, agentId: "dev" };
const CONVERSATION = {
  kind: "conversation" as const,
  agentId: "dev",
  sessionKey: "agent:dev:telegram:group:-100",
  sessionId: "s1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(extra: Record<string, unknown> = {}) {
  const fake = createFakeHindsight({
    "POST /v1/default/banks/dev/memories/recall": () => ({
      json: { results: [{ id: "m1", text: "Studio hosts Hindsight", type: "world" }] },
    }),
    "PUT /v1/default/banks/dev": () => ({ json: {} }),
    "POST /v1/default/banks/dev/memories": () => ({ json: {} }),
  });
  vi.stubGlobal("fetch", fake.fetch);
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "test-token",
    retainMission: "Keep durable facts.",
    ...extra,
  };
  const config = { plugins: { entries: { [PLUGIN_ID]: { config: pluginConfig } } } };
  const on = vi.fn<AnyFn>();
  const registerMemoryCapability = vi.fn<AnyFn>();
  const registerTool = vi.fn<AnyFn>();
  memoryPlugin.register(
    createFakePluginApi({
      pluginConfig,
      config,
      on,
      registerMemoryCapability,
      registerTool,
    }),
  );
  const hook = (name: string) => on.mock.calls.find(([hookName]) => hookName === name)?.[1];
  return { fake, hook, registerMemoryCapability, registerTool };
}

describe("memory-hindsight registration", () => {
  it("registers the memory capability and the three tools", () => {
    const { registerMemoryCapability, registerTool } = setup();
    const capability = registerMemoryCapability.mock.calls[0]?.[0];
    expect(capability.providerRuntime.open).toBeTypeOf("function");
    expect(capability.providerFlushPlanResolver).toBeTypeOf("function");
    expect(capability.recallToolNames).toEqual(["hindsight_recall", "hindsight_reflect"]);
    // The fake API has no registerLearnContribution, so the legacy fields are used.
    expect(capability.learnToolNames).toEqual(["hindsight_retain"]);
    expect(capability.learnGuidanceBuilder).toBeTypeOf("function");
    expect(
      registerTool.mock.calls
        .map(([, opts]) => String(opts.name))
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["hindsight_recall", "hindsight_reflect", "hindsight_retain"]);
  });

  it("uses registerLearnContribution instead of capability fields when the host has it", () => {
    const registerMemoryCapability = vi.fn<AnyFn>();
    const registerLearnContribution = vi.fn<AnyFn>();
    const api = createFakePluginApi({
      pluginConfig: { hindsightApiUrl: "http://hindsight.test", allowInsecureHttp: true },
      registerMemoryCapability,
    });
    Object.assign(api, { registerLearnContribution });
    memoryPlugin.register(api);
    const capability = registerMemoryCapability.mock.calls[0]?.[0];
    expect(capability.recallToolNames).toEqual(["hindsight_recall", "hindsight_reflect"]);
    expect(capability).not.toHaveProperty("learnToolNames");
    expect(capability).not.toHaveProperty("learnGuidanceBuilder");
    expect(registerLearnContribution).toHaveBeenCalledTimes(1);
    expect(registerLearnContribution.mock.calls[0]?.[0]).toMatchObject({
      medium: "memory",
      toolNames: ["hindsight_retain"],
    });
  });

  it("stays inert without hindsightApiUrl", () => {
    const registerMemoryCapability = vi.fn<AnyFn>();
    memoryPlugin.register(createFakePluginApi({ pluginConfig: {}, registerMemoryCapability }));
    expect(registerMemoryCapability).not.toHaveBeenCalled();
  });

  it("stays inert and sends no request for remote plain http without allowInsecureHttp", () => {
    const fetchSpy = vi.fn<AnyFn>();
    vi.stubGlobal("fetch", fetchSpy);
    const registerMemoryCapability = vi.fn<AnyFn>();
    const on = vi.fn<AnyFn>();
    memoryPlugin.register(
      createFakePluginApi({
        pluginConfig: { hindsightApiUrl: "http://studio:8888", hindsightApiToken: "t" },
        registerMemoryCapability,
        on,
      }),
    );
    expect(registerMemoryCapability).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the plugin id hindsight-native, distinct from the vendor plugin", () => {
    expect(PLUGIN_ID).toBe("hindsight-native");
    expect(memoryPlugin.id).toBe("hindsight-native");
  });
});

describe("live config", () => {
  it("reads plugins.entries[id].config from a runtime snapshot", () => {
    const entry = { hindsightApiUrl: "http://x.test", allowInsecureHttp: true };
    expect(
      readPluginConfigEntry(
        { plugins: { entries: { [PLUGIN_ID]: { config: entry } } } },
        PLUGIN_ID,
      ),
    ).toBe(entry);
    expect(readPluginConfigEntry({}, PLUGIN_ID)).toBeUndefined();
    expect(readPluginConfigEntry(undefined, PLUGIN_ID)).toBeUndefined();
  });

  it("applies a live config change without re-registering", async () => {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories/recall": () => ({
        json: { results: [{ id: "m1", text: "fact", type: "world" }] },
      }),
    });
    vi.stubGlobal("fetch", fake.fetch);
    const pluginConfig = {
      hindsightApiUrl: "http://hindsight.test",
      allowInsecureHttp: true,
      hindsightApiToken: "t",
    };
    const config = { plugins: { entries: { [PLUGIN_ID]: { config: { ...pluginConfig } } } } };
    const on = vi.fn<AnyFn>();
    memoryPlugin.register(createFakePluginApi({ pluginConfig, config, on }));
    const hook = on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
    const ctx = { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER };
    const event = { prompt: "where does hindsight run?", messages: [] };
    await expect(hook(event, ctx)).resolves.toMatchObject({
      prependContext: expect.stringContaining("fact"),
    });
    config.plugins.entries[PLUGIN_ID].config = { ...pluginConfig, autoRecall: false } as never;
    fake.requests.length = 0;
    await expect(hook(event, ctx)).resolves.toBeUndefined();
    expect(fake.requests).toEqual([]);
  });
});

describe("auto-recall", () => {
  it("injects memories from the owner bank before the user message", async () => {
    const { fake, hook } = setup();
    const result = await hook("before_prompt_build")(
      {
        prompt: "where does hindsight run?",
        currentUserMessage: "where does hindsight run?",
        messages: [],
      },
      { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER },
    );
    expect(result.prependContext).toContain("<hindsight_memories>");
    expect(result.prependContext).toContain("- Studio hosts Hindsight [world]");
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      url: "http://hindsight.test/v1/default/banks/dev/memories/recall",
      body: { query: "where does hindsight run?" },
    });
  });

  it("uses the conversation bank for a conversation audience", async () => {
    const { fake, hook } = setup();
    await hook("before_prompt_build")(
      { prompt: "what did we decide?", messages: [] },
      { agentId: "dev", sessionKey: CONVERSATION.sessionKey, memoryAudience: CONVERSATION },
    );
    expect(fake.requests[0]?.url).toMatch(
      /\/banks\/dev%3A%3Aconv%3A%3A[0-9a-f]{16}\/memories\/recall$/,
    );
  });

  it("skips without audience, for excluded providers, incognito, or in tools mode", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{}, { agentId: "dev", sessionKey: "agent:dev:main" }],
      [
        { excludeProviders: ["heartbeat"] },
        { agentId: "dev", messageProvider: "heartbeat", memoryAudience: OWNER },
      ],
      [
        {},
        { agentId: "dev", sessionKey: "agent:dev:dashboard:incognito-x", memoryAudience: OWNER },
      ],
      [
        { memoryMode: "tools" },
        { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER },
      ],
    ];
    for (const [extra, ctx] of cases) {
      const { fake, hook } = setup(extra);
      await expect(
        hook("before_prompt_build")({ prompt: "where does hindsight run?", messages: [] }, ctx),
      ).resolves.toBeUndefined();
      expect(fake.requests).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});

describe("auto-retain", () => {
  it("retains the whole run to the owner bank with one document per run", async () => {
    const { fake, hook } = setup();
    const ctx = {
      agentId: "dev",
      sessionKey: "agent:dev:main",
      memoryAudience: OWNER,
      runId: "run-1",
    };
    const prior = [
      { role: "user", content: "older" },
      { role: "assistant", content: "older reply" },
    ];
    const request = { role: "user", content: "ship the native plugin" };
    await hook("before_prompt_build")(
      {
        prompt: "ship the native plugin",
        currentUserMessage: "ship the native plugin",
        messages: [...prior, request],
      },
      ctx,
    );
    fake.requests.length = 0;
    await hook("agent_end")(
      {
        success: true,
        runId: "run-1",
        messages: [
          ...prior,
          request,
          { role: "user", content: "also add tests" },
          { role: "assistant", content: "done" },
        ],
      },
      ctx,
    );
    expect(fake.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "PUT /v1/default/banks/dev",
      "POST /v1/default/banks/dev/memories",
    ]);
    const body = fake.requests[1]?.body as { items: Array<Record<string, any>> } | undefined;
    const item = body!.items[0]!;
    const digest = createHash("sha256").update("agent:dev:main").digest("hex").slice(0, 12);
    expect(item.document_id).toBe(`openclaw:agent:dev:main-${digest}:run:run-1`);
    expect(item.update_mode).toBe("replace");
    expect(JSON.parse(item.content).map((m: { content: string }) => m.content)).toEqual([
      "ship the native plugin",
      "also add tests",
      "done",
    ]);
    expect(item.metadata).toMatchObject({
      audience: "owner-private",
      session_key: "agent:dev:main",
    });
  });

  it("retains after the run released its audience (agent_end runs after the attempt)", async () => {
    const { fake, hook } = setup();
    const released = vi.fn<AnyFn>(() => {
      throw new Error("memory audience was released by its owner");
    });
    await hook("agent_end")(
      { success: true, runId: "run-2", messages: [{ role: "user", content: "keep this fact" }] },
      {
        agentId: "dev",
        sessionKey: "agent:dev:main",
        memoryAudience: OWNER,
        assertMemoryAudienceCurrent: released,
      },
    );
    expect(released).not.toHaveBeenCalled();
    expect(fake.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "PUT /v1/default/banks/dev",
      "POST /v1/default/banks/dev/memories",
    ]);
  });

  it("does not retain failed runs, operational sessions, or sessions without audience", async () => {
    const messages = [{ role: "user", content: "remember this please" }];
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { success: false, messages },
        { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER },
      ],
      [
        { success: true, messages },
        { agentId: "dev", sessionKey: "agent:dev:subagent:x", memoryAudience: OWNER },
      ],
      [
        { success: true, messages },
        { agentId: "dev", sessionKey: "agent:dev:main" },
      ],
    ];
    for (const [event, ctx] of cases) {
      const { fake, hook } = setup();
      await hook("agent_end")(event, ctx);
      expect(fake.requests).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});

describe("document ids", () => {
  it("keeps session keys that sanitize alike apart with a short hash of the raw key", () => {
    expect(sessionKeyDigest("a b")).not.toBe(sessionKeyDigest("a/b"));
    expect(sessionKeyDigest("a b")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("auto-retain timeout", () => {
  it("aborts a hung retain after 30 s, logs a warning and does not throw", async () => {
    const timeouts = spyOnTimeouts();
    vi.stubGlobal("fetch", createHangingFetch());
    try {
      const on = vi.fn<AnyFn>();
      const api = createFakePluginApi({
        pluginConfig: { hindsightApiUrl: "http://hindsight.test", allowInsecureHttp: true },
        on,
      });
      memoryPlugin.register(api);
      const hook = on.mock.calls.find(([name]) => name === "agent_end")?.[1];
      await expect(
        hook(
          { success: true, runId: "r1", messages: [{ role: "user", content: "remember this" }] },
          { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER },
        ),
      ).resolves.toBeUndefined();
      expect(timeouts.requested).toEqual([30_000]);
      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("memory-hindsight: auto-retain failed"),
      );
    } finally {
      timeouts.restore();
    }
  });
});

function startWarnings(pluginConfig: Record<string, unknown>) {
  const registerService = vi.fn<AnyFn>();
  const api = createFakePluginApi({ pluginConfig, registerService });
  memoryPlugin.register(api);
  registerService.mock.calls[0]?.[0].start();
  return (api.logger.warn as ReturnType<typeof vi.fn<AnyFn>>).mock.calls.map(([m]) => String(m));
}

describe("service start warnings", () => {
  it("warns once when the token is an unresolved SecretRef", () => {
    const warnings = startWarnings({
      hindsightApiUrl: "https://hindsight.test",
      hindsightApiToken: { source: "file", provider: "p", id: "x" },
    });
    expect(warnings).toEqual([
      "memory-hindsight: hindsightApiToken not resolved; requests go unauthenticated",
    ]);
  });

  it("warns once that token and conversation text are unencrypted with the opt-in", () => {
    const warnings = startWarnings({
      hindsightApiUrl: "http://studio:8888",
      allowInsecureHttp: true,
      hindsightApiToken: "secret-token",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bearer token");
    expect(warnings[0]).toContain("conversation text");
    expect(warnings[0]).not.toContain("secret-token");
  });

  it("warns with the opt-in even when no token is set", () => {
    const warnings = startWarnings({
      hindsightApiUrl: "http://studio:8888",
      allowInsecureHttp: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("conversation text");
  });

  it("stays quiet for https and loopback", () => {
    expect(startWarnings({ hindsightApiUrl: "https://h", hindsightApiToken: "t" })).toEqual([]);
    expect(
      startWarnings({ hindsightApiUrl: "http://127.0.0.1:1", hindsightApiToken: "t" }),
    ).toEqual([]);
  });
});
