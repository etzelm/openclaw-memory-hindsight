import { createHash } from "node:crypto";
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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryPlugin, { PLUGIN_ID, readPluginConfigEntry, sessionKeyDigest } from "./index.js";
import {
  createFakeHindsight,
  createHangingFetch,
  createTestService,
  type RecordedRequest,
  spyOnTimeouts,
} from "./test-helpers.js";

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
  const api = createFakePluginApi({
    pluginConfig,
    config,
    on,
    registerMemoryCapability,
    registerTool,
  });
  memoryPlugin.register(api);
  const hook = (name: string) => on.mock.calls.find(([hookName]) => hookName === name)?.[1];
  return { api, fake, hook, registerMemoryCapability, registerTool };
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

  it("tags each auto-retain with retainTags plus inline retain_tags", async () => {
    const { fake, hook } = setup({ retainTags: ["source:openclaw"] });
    const ctx = { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER };
    await hook("agent_end")(
      {
        success: true,
        runId: "run-tags-1",
        messages: [{ role: "user", content: "keep this fact" }],
      },
      ctx,
    );
    await hook("agent_end")(
      {
        success: true,
        runId: "run-tags-2",
        messages: [
          {
            role: "user",
            content: "deploy rule <retain_tags>team:ops, source:openclaw</retain_tags>",
          },
        ],
      },
      ctx,
    );
    const tags = fake.requests
      .filter((r) => r.method === "POST")
      .map((r) => (r.body as { items: Array<{ tags?: string[] }> }).items[0]?.tags);
    expect(tags).toEqual([["source:openclaw"], ["source:openclaw", "team:ops"]]);
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

/** The auto-retain items posted, in order. */
const retained = (requests: RecordedRequest[]) =>
  requests
    .filter((r) => r.method === "POST" && r.url.endsWith("/memories"))
    .map((r) => {
      const item = (r.body as { items: Array<Record<string, any>> }).items[0]!;
      return {
        documentId: item.document_id as string,
        updateMode: item.update_mode as string,
        tags: item.tags as string[] | undefined,
        texts: JSON.parse(item.content).map((m: { content: string }) => m.content) as string[],
      };
    });

describe("auto-retain across one run's agent_end calls", () => {
  const SESSION = "agent:dev:main";
  const ctxFor = (runId: string, extra: Record<string, unknown> = {}) => ({
    agentId: "dev",
    sessionKey: SESSION,
    memoryAudience: OWNER,
    runId,
    ...extra,
  });
  const prior = [
    { role: "user", content: "older" },
    { role: "assistant", content: "older reply" },
  ];
  const ask = { role: "user", content: "the code word is heron" };
  const reply = { role: "assistant", content: "noted: heron" };
  const resume =
    "Continue the current task from the existing transcript, preserving completed work.";
  const resumed = { role: "assistant", content: "nothing left to do" };
  const firstAttempt = async (hook: (name: string) => AnyFn | undefined, runId = "run-1") => {
    await hook("before_prompt_build")!(
      {
        prompt: ask.content,
        currentUserMessage: ask.content,
        messages: [...prior, ask],
      },
      ctxFor(runId),
    );
    await hook("agent_end")!(
      { success: true, runId, messages: [...prior, ask, reply] },
      ctxFor(runId),
    );
  };

  it("re-sends the whole run when the host continues it after a retry", async () => {
    const { fake, hook } = setup({ retainTags: ["source:openclaw"] });
    await firstAttempt(hook);
    // The host's in-run continuation: same runId, a synthetic prompt, a second agent_end.
    await hook("before_prompt_build")(
      {
        prompt: resume,
        currentUserMessage: resume,
        messages: [...prior, ask, reply],
      },
      ctxFor("run-1"),
    );
    await hook("agent_end")(
      {
        success: true,
        runId: "run-1",
        messages: [...prior, ask, reply, { role: "user", content: resume }, resumed],
      },
      ctxFor("run-1"),
    );
    const [first, second] = retained(fake.requests);
    expect(first!.texts).toEqual([ask.content, reply.content]);
    expect(second!.documentId).toBe(first!.documentId);
    expect(second!.updateMode).toBe("replace");
    expect(second!.tags).toEqual(["source:openclaw"]);
    expect(second!.texts.slice(0, 2)).toEqual([ask.content, reply.content]);
    expect(second!.texts).toContain(resumed.content);
    expect(second!.texts).not.toContain("older");
  });

  it("sends identical content for a re-delivered agent_end", async () => {
    const { fake, hook } = setup();
    await firstAttempt(hook);
    await hook("agent_end")(
      { success: true, runId: "run-1", messages: [...prior, ask, reply] },
      ctxFor("run-1"),
    );
    const [first, second] = retained(fake.requests);
    expect(second).toEqual(first);
    expect(first!.texts).toEqual([ask.content, reply.content]);
  });

  it("starts a new run fresh", async () => {
    const { fake, hook } = setup();
    await firstAttempt(hook);
    const next = { role: "user", content: "what was the code word?" };
    const answer = { role: "assistant", content: "heron" };
    await hook("before_prompt_build")(
      {
        prompt: next.content,
        currentUserMessage: next.content,
        messages: [...prior, ask, reply, next],
      },
      ctxFor("run-2"),
    );
    await hook("agent_end")(
      {
        success: true,
        runId: "run-2",
        messages: [...prior, ask, reply, next, answer],
      },
      ctxFor("run-2"),
    );
    const [, second] = retained(fake.requests);
    expect(second!.documentId).toMatch(/:run:run-2$/);
    expect(second!.texts).toEqual([next.content, answer.content]);
  });

  it("keeps the run start across a maintenance turn in the same session", async () => {
    const { fake, hook } = setup();
    await firstAttempt(hook);
    const flush = ctxFor("flush-1", { trigger: "memory" });
    await hook("before_prompt_build")(
      {
        prompt: "flush",
        messages: [...prior, ask, reply, { role: "user", content: "flush" }],
      },
      flush,
    );
    await hook("agent_end")({ success: true, runId: "flush-1", messages: [ask] }, flush);
    await hook("before_prompt_build")(
      {
        prompt: resume,
        currentUserMessage: resume,
        messages: [...prior, ask, reply],
      },
      ctxFor("run-1"),
    );
    await hook("agent_end")(
      {
        success: true,
        runId: "run-1",
        messages: [...prior, ask, reply, { role: "user", content: resume }, resumed],
      },
      ctxFor("run-1"),
    );
    const posts = retained(fake.requests);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.texts.slice(0, 2)).toEqual([ask.content, reply.content]);
  });

  it("keeps the next run's start when the previous run's agent_end arrives late", async () => {
    // The host does not await agent_end, so run-1's handler can run after run-2 started.
    const { fake, hook } = setup();
    const next = { role: "user", content: "what was the code word?" };
    const answer = { role: "assistant", content: "heron" };
    await hook("before_prompt_build")(
      { prompt: ask.content, currentUserMessage: ask.content, messages: [...prior, ask] },
      ctxFor("run-1"),
    );
    await hook("before_prompt_build")(
      {
        prompt: next.content,
        currentUserMessage: next.content,
        messages: [...prior, ask, reply, next],
      },
      ctxFor("run-2"),
    );
    await hook("agent_end")(
      { success: true, runId: "run-1", messages: [...prior, ask, reply] },
      ctxFor("run-1"),
    );
    // run-2 continues in-run (two user messages), so a lost start shows in its document.
    await hook("agent_end")(
      {
        success: true,
        runId: "run-2",
        messages: [...prior, ask, reply, next, answer, { role: "user", content: resume }, resumed],
      },
      ctxFor("run-2"),
    );
    const posts = retained(fake.requests);
    const byRun = new Map(posts.map((p) => [p.documentId.split(":run:")[1], p.texts]));
    // run-1 never reads run-2's start (that would leave it nothing to retain).
    expect(byRun.get("run-1")).toEqual([ask.content, reply.content]);
    // run-2 still has its own start.
    expect(byRun.get("run-2")).toEqual([next.content, answer.content, resume, resumed.content]);
  });

  it("drops the run start when the session ends", async () => {
    const { fake, hook } = setup();
    await firstAttempt(hook);
    await hook("session_end")(
      { sessionId: "s1", messageCount: 3, reason: "reset" },
      ctxFor("run-1"),
    );
    // Without a marker, agent_end falls back to the last user message.
    await hook("agent_end")(
      {
        success: true,
        runId: "run-1",
        messages: [...prior, ask, reply, { role: "user", content: "later ask" }, resumed],
      },
      ctxFor("run-1"),
    );
    const [, second] = retained(fake.requests);
    expect(second!.texts).toEqual(["later ask", resumed.content]);
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

const logs = (api: OpenClawPluginApi, level: "warn" | "debug") =>
  (api.logger[level] as ReturnType<typeof vi.fn<AnyFn>>).mock.calls.map(([m]) => String(m));

describe("auto-recall on a bank that does not exist yet", () => {
  const ctx = {
    agentId: "fresh",
    sessionKey: "agent:fresh:main",
    memoryAudience: {
      kind: "owner-private" as const,
      agentId: "fresh",
    },
  };
  const event = { prompt: "where does hindsight run?", messages: [] };
  it("treats Hindsight's bank-not-found 404 as no memories: no warning, a debug line", async () => {
    const { api, fake, hook } = setup();
    fake.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Bank 'fresh' not found" }), { status: 404 }),
    );
    await expect(hook("before_prompt_build")(event, ctx)).resolves.toBeUndefined();
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(logs(api, "warn")).toEqual([]);
    expect(logs(api, "debug")).toContain("memory-hindsight: auto-recall found no bank yet");
  });

  it("keeps a 404 from a route that does not exist loud", async () => {
    const { api, fake, hook } = setup();
    fake.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
    );
    await expect(hook("before_prompt_build")(event, ctx)).resolves.toBeUndefined();
    expect(logs(api, "warn")).toEqual([
      "memory-hindsight: auto-recall skipped: Hindsight recall failed: HTTP 404",
    ]);
  });

  it("keeps other HTTP errors loud", async () => {
    const { api, fake, hook } = setup();
    fake.fetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    await hook("before_prompt_build")(event, ctx);
    expect(logs(api, "warn")).toEqual([
      "memory-hindsight: auto-recall skipped: Hindsight recall failed: HTTP 500",
    ]);
  });
});

describe("host maintenance turns", () => {
  const user = { role: "user", content: "keep this durable fact" };
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "pre-compaction flush (trigger memory)",
      {
        agentId: "dev",
        trigger: "memory",
        sessionKey: "agent:dev:internal-session-effects:00000000-0000000000000000",
        memoryAudience: OWNER,
      },
    ],
    [
      "Active Memory recall child",
      {
        agentId: "dev",
        trigger: "manual",
        sessionKey: "agent:dev:dashboard:11111111:active-memory:0123456789ab",
        memoryAudience: OWNER,
      },
    ],
  ];

  it.each(cases)("%s: no auto-recall and no auto-retain", async (_name, ctx) => {
    const { fake, hook } = setup();
    await expect(
      hook("before_prompt_build")(
        {
          prompt: "Review the conversation so far and call hindsight_retain",
          messages: [user],
        },
        ctx,
      ),
    ).resolves.toBeUndefined();
    await hook("agent_end")({ success: true, runId: "r1", messages: [user] }, ctx);
    expect(fake.requests).toEqual([]);
  });

  it.each(cases)("%s: agent_end alone retains nothing", async (_name, ctx) => {
    const { fake, hook } = setup();
    await hook("agent_end")({ success: true, runId: "r2", messages: [user] }, ctx);
    expect(fake.requests).toEqual([]);
  });

  it("still recalls and retains on the parent user turn", async () => {
    const { fake, hook } = setup();
    const ctx = {
      agentId: "dev",
      trigger: "user",
      sessionKey: "agent:dev:dashboard:11111111",
      memoryAudience: OWNER,
    };
    await hook("before_prompt_build")({ prompt: "where does hindsight run?", messages: [] }, ctx);
    await hook("agent_end")({ success: true, runId: "r1", messages: [user] }, ctx);
    expect(fake.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "POST /v1/default/banks/dev/memories/recall",
      "PUT /v1/default/banks/dev",
      "POST /v1/default/banks/dev/memories",
    ]);
  });
});

/** A Hindsight that can be taken offline; when down, fetch rejects like an unreachable host. */
function switchableHindsight() {
  const state = { down: true, status: 0 };
  const fake = { requests: [] as RecordedRequest[] };
  const fetch = vi.fn<AnyFn>(async (url: string, init?: RequestInit) => {
    if (state.down) {
      throw new TypeError("fetch failed");
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    fake.requests.push({ method: init?.method ?? "GET", url, body });
    return new Response(state.status ? "" : "{}", { status: state.status || 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return { state, fake };
}

/** Registers and starts the plugin like the gateway does, with the host state dir. */
function boot(stateDir: string, extra: Record<string, unknown> = {}) {
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "secret-test-token",
    ...extra,
  };
  const on = vi.fn<AnyFn>();
  const registerService = vi.fn<AnyFn>();
  const api = createFakePluginApi({
    pluginConfig,
    config: { plugins: { entries: { [PLUGIN_ID]: { config: pluginConfig } } } },
    on,
    registerService,
  });
  memoryPlugin.register(api);
  const service = registerService.mock.calls[0]?.[0];
  service.start({ stateDir });
  const agentEnd = on.mock.calls.find(([name]) => name === "agent_end")?.[1];
  return { api, service, agentEnd };
}

const queueFile = (stateDir: string) => join(stateDir, "hindsight-native", "retain-queue.jsonl");
const queuedItems = (stateDir: string) =>
  readFileSync(queueFile(stateDir), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { bankId: string; documentId: string });
const retainPosts = (requests: RecordedRequest[]) =>
  requests
    .filter((r) => r.method === "POST" && r.url.endsWith("/memories"))
    .map((r) => {
      const item = (r.body as { items: Array<{ document_id: string }> }).items[0]!;
      const bank = decodeURIComponent(new URL(r.url).pathname.split("/")[4]!);
      return `${bank} ${item.document_id.split(":run:")[1]}`;
    });

/**
 * Forgets in-memory queues, as a new process would. Imported lazily and skipped when the module is
 * missing, so on a base without the queue each test fails on its own assertions.
 */
async function forgetQueuesInMemory() {
  let mod: typeof import("./retain-queue.js") | undefined;
  try {
    mod = await import("./retain-queue.js");
  } catch {
    return;
  }
  mod.resetSharedRetainQueues();
}

/** One queue file line for bank `dev`, as an earlier run wrote it. */
const queueLine = (documentId: string, content: string) =>
  JSON.stringify({
    bankId: "dev",
    documentId,
    item: { content, document_id: documentId },
    queuedAt: Date.now(),
  });

const doc = (id: string) => ({ content: `text ${id}`, document_id: id });

function turn(runId: string, memoryAudience: unknown = OWNER, agentId = "dev") {
  return [
    { success: true, runId, messages: [{ role: "user", content: `remember fact ${runId}` }] },
    { agentId, sessionKey: `agent:${agentId}:main`, memoryAudience },
  ] as const;
}

describe("offline retain queue", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await forgetQueuesInMemory();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function newStateDir() {
    const dir = mkdtempSync(join(tmpdir(), "hs-plugin-queue-"));
    dirs.push(dir);
    return dir;
  }

  it("queues a retain while Hindsight is unreachable and delivers it once after a restart", async () => {
    const stateDir = newStateDir();
    const { state, fake } = switchableHindsight();
    const first = boot(stateDir);
    await first.agentEnd(...turn("run-1"));
    expect(first.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Hindsight unreachable, retain queued (1 pending)"),
    );
    expect(statSync(queueFile(stateDir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(queueFile(stateDir), "utf8")).not.toContain("secret-test-token");
    // A re-delivered agent_end for the same run replaces the queued item.
    await first.agentEnd(...turn("run-1"));
    first.service.stop();
    // A new process: nothing in memory, only the file.
    await forgetQueuesInMemory();

    state.down = false;
    const second = boot(stateDir);
    await vi.waitFor(() => expect(existsSync(queueFile(stateDir))).toBe(false));
    expect(retainPosts(fake.requests)).toEqual(["dev run-1"]);
    expect(second.api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("1 queued retain(s) from an earlier run"),
    );
    second.service.stop();
  });

  it("replays each item to the bank it was queued for, even after agentBankMap changes", async () => {
    const stateDir = newStateDir();
    const { state, fake } = switchableHindsight();
    const first = boot(stateDir);
    await first.agentEnd(...turn("owner-1"));
    await first.agentEnd(
      ...turn("conv-1", { ...CONVERSATION, sessionKey: "agent:dev:telegram:group:-100" }),
    );
    first.service.stop();
    const queued = queuedItems(stateDir).map((i) => i.bankId);
    expect(queued[0]).toBe("dev");
    expect(queued[1]).toMatch(/^dev::conv::/);

    state.down = false;
    const second = boot(stateDir, { agentBankMap: { dev: "shared" } });
    await vi.waitFor(() => expect(existsSync(queueFile(stateDir))).toBe(false));
    const posts = retainPosts(fake.requests);
    expect(posts[0]).toBe("dev owner-1");
    expect(posts[1]).toMatch(/^dev::conv::\S+ conv-1$/);
    expect(posts).toHaveLength(2);
    second.service.stop();
  });

  it("replays the tags resolved at enqueue time, even after retainTags changes", async () => {
    const stateDir = newStateDir();
    const { state, fake } = switchableHindsight();
    const first = boot(stateDir, { retainTags: ["source:openclaw"] });
    await first.agentEnd(
      {
        success: true,
        runId: "tagged",
        messages: [
          { role: "user", content: "remember this <retain_tags>project:queue</retain_tags>" },
        ],
      },
      { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER },
    );
    first.service.stop();
    await forgetQueuesInMemory();
    state.down = false;
    const second = boot(stateDir, { retainTags: ["changed:later"] });
    await vi.waitFor(() => expect(existsSync(queueFile(stateDir))).toBe(false));
    const posted = fake.requests.find((r) => r.method === "POST" && r.url.endsWith("/memories"));
    const item = (posted!.body as { items: Array<{ tags?: string[] }> }).items[0]!;
    expect(item.tags).toEqual(["source:openclaw", "project:queue"]);
    second.service.stop();
  });

  it("keeps a bank's order: a new retain waits behind that bank's queued items", async () => {
    const stateDir = newStateDir();
    const { state, fake } = switchableHindsight();
    const { service, agentEnd } = boot(stateDir);
    await agentEnd(...turn("run-1"));
    state.down = false;
    await agentEnd(...turn("run-2"));
    await vi.waitFor(() => expect(existsSync(queueFile(stateDir))).toBe(false));
    expect(retainPosts(fake.requests)).toEqual(["dev run-1", "dev run-2"]);
    service.stop();
  });

  it("keeps a retain that fails after a stop and restart (one queue per file)", async () => {
    const stateDir = newStateDir();
    let failFirst: ((error: unknown) => void) | undefined;
    const hanging = vi.fn<AnyFn>(
      () =>
        new Promise<Response>((_resolve, reject) => {
          failFirst = reject;
        }),
    );
    const down = vi.fn<AnyFn>(async () => {
      throw new TypeError("fetch failed");
    });
    const first = createTestService(hanging).service;
    first.startRetainQueue(stateDir);
    const pendingA = first.retainOrQueue("dev", doc("A"), AbortSignal.timeout(60_000));
    first.stop();
    const second = createTestService(down).service;
    second.startRetainQueue(stateDir);
    await expect(second.retainOrQueue("dev", doc("B"), AbortSignal.timeout(60_000))).resolves.toBe(
      "queued",
    );
    failFirst?.(new TypeError("fetch failed"));
    await expect(pendingA).resolves.toBe("queued");
    await expect(second.retainOrQueue("dev", doc("C"), AbortSignal.timeout(60_000))).resolves.toBe(
      "queued",
    );
    second.stop();
    expect(queuedItems(stateDir).map((i) => i.documentId)).toEqual(["B", "A", "C"]);
  });

  it("replays one copy per document, as a replace of that document id, after a crash", async () => {
    const stateDir = newStateDir();
    // A crash between replay's batched saves left a delivered copy of A before a newer one.
    mkdirSync(dirname(queueFile(stateDir)), { recursive: true });
    writeFileSync(
      queueFile(stateDir),
      `${[queueLine("A", "old A"), queueLine("B", "text B"), queueLine("A", "new A")].join("\n")}\n`,
    );
    const requests: RecordedRequest[] = [];
    const fetch = vi.fn<AnyFn>(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method: init?.method ?? "GET", url, body });
      return new Response("{}", { status: 200 });
    });
    const { service } = createTestService(fetch);
    service.startRetainQueue(stateDir);
    await service.retainQueue()!.flush();
    const items = requests
      .filter((r) => r.method === "POST" && r.url.endsWith("/memories"))
      .map((r) => (r.body as { items: Array<Record<string, unknown>> }).items[0]!);
    expect(items.map((i) => [i.document_id, i.content, i.update_mode])).toEqual([
      ["B", "text B", "replace"],
      ["A", "new A", "replace"],
    ]);
    expect(existsSync(queueFile(stateDir))).toBe(false);
    service.stop();
  });

  it("keeps a re-sent retain queued while Hindsight is down and the file cannot be rewritten", async () => {
    const stateDir = newStateDir();
    const down = vi.fn<AnyFn>(async () => {
      throw new TypeError("fetch failed");
    });
    const { service } = createTestService(down);
    service.startRetainQueue(stateDir);
    const file = queueFile(stateDir);
    await expect(service.retainOrQueue("dev", doc("A"), AbortSignal.timeout(60_000))).resolves.toBe(
      "queued",
    );
    await service.retainQueue()!.flush();
    // A directory at the temp path makes every rewrite fail (EISDIR, for root too).
    mkdirSync(`${file}.tmp`);
    try {
      for (const content of ["second", "third"]) {
        await expect(
          service.retainOrQueue("dev", { content, document_id: "A" }, AbortSignal.timeout(60_000)),
        ).resolves.toBe("queued");
      }
    } finally {
      rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
    service.stop();
    const { RetainQueue } = await import("./retain-queue.js");
    const restarted = new RetainQueue({
      filePath: file,
      limits: () => ({ maxItems: 100, maxAgeMs: 60_000 }),
      logger: {},
    });
    restarted.load();
    expect(restarted.list()).toEqual([{ bankId: "dev", documentId: "A" }]);
    expect(restarted.peek()?.item.content).toBe("third");
  });

  it("sends a retain live when queueing it behind its bank fails (disk error)", async () => {
    const stateDir = newStateDir();
    let up = false;
    const fetch = vi.fn<AnyFn>(async () => {
      if (!up) {
        throw new TypeError("fetch failed");
      }
      return new Response("{}", { status: 200 });
    });
    const { service } = createTestService(fetch);
    service.startRetainQueue(stateDir);
    await expect(service.retainOrQueue("dev", doc("A"), AbortSignal.timeout(60_000))).resolves.toBe(
      "queued",
    );
    service.retainQueue()!.stop();
    const { RetainQueue } = await import("./retain-queue.js");
    const spy = vi.spyOn(RetainQueue.prototype, "enqueue").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    up = true;
    try {
      await expect(
        service.retainOrQueue("dev", doc("B"), AbortSignal.timeout(60_000)),
      ).resolves.toBe("sent");
    } finally {
      spy.mockRestore();
    }
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not queue retain (ENOSPC: no space left on device)"),
    );
    service.stop();
  });

  it("keeps queued retains when bank setup answers 4xx on replay", async () => {
    const stateDir = newStateDir();
    let mode: "down" | "setup-422" = "down";
    const fetch = vi.fn<AnyFn>(async (url: string, init?: RequestInit) => {
      if (mode === "down") {
        throw new TypeError("fetch failed");
      }
      const isSetup = init?.method === "PUT" && !url.endsWith("/memories");
      return new Response("{}", { status: isSetup ? 422 : 200 });
    });
    const { service } = createTestService(fetch, { retainMission: "Keep durable facts." });
    service.startRetainQueue(stateDir);
    await service.retainOrQueue("dev", doc("A"), AbortSignal.timeout(60_000));
    await service.retainOrQueue("dev", doc("B"), AbortSignal.timeout(60_000));
    // Let the pass started while Hindsight was down finish, then replay against the 422.
    await service.retainQueue()!.flush();
    mode = "setup-422";
    await service.retainQueue()!.flush();
    expect(queuedItems(stateDir).map((i) => i.documentId)).toEqual(["A", "B"]);
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("bank setup failed (Hindsight bank setup failed: HTTP 422)"),
    );
    service.stop();
  });

  it("does not queue 4xx answers", async () => {
    const stateDir = newStateDir();
    const { state } = switchableHindsight();
    state.down = false;
    state.status = 400;
    const { api, service, agentEnd } = boot(stateDir);
    await agentEnd(...turn("run-1"));
    expect(existsSync(queueFile(stateDir))).toBe(false);
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-retain failed: Hindsight retain failed: HTTP 400"),
    );
    service.stop();
  });

  it("queues 5xx answers", async () => {
    const stateDir = newStateDir();
    const { state } = switchableHindsight();
    state.down = false;
    state.status = 503;
    const { service, agentEnd } = boot(stateDir);
    await agentEnd(...turn("run-1"));
    expect(existsSync(queueFile(stateDir))).toBe(true);
    service.stop();
  });

  it("keeps the old drop-and-warn behavior with retainQueueEnabled false", async () => {
    const stateDir = newStateDir();
    switchableHindsight();
    const { api, service, agentEnd } = boot(stateDir, { retainQueueEnabled: false });
    await agentEnd(...turn("run-1"));
    expect(existsSync(queueFile(stateDir))).toBe(false);
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("memory-hindsight: auto-retain failed"),
    );
    service.stop();
  });

  it("applies retainQueueMaxItems", async () => {
    const stateDir = newStateDir();
    switchableHindsight();
    const { api, service, agentEnd } = boot(stateDir, { retainQueueMaxItems: 2 });
    for (const runId of ["r1", "r2", "r3"]) {
      await agentEnd(...turn(runId));
    }
    expect(queuedItems(stateDir).map((i) => i.documentId.split(":run:")[1])).toEqual(["r2", "r3"]);
    expect(
      (api.logger.warn as ReturnType<typeof vi.fn<AnyFn>>).mock.calls.filter(([m]) =>
        String(m).includes("retain queue dropped"),
      ),
    ).toHaveLength(1);
    service.stop();
  });
});

describe("session patterns in the hooks", () => {
  const messages = [{ role: "user", content: "remember this please" }];
  const prompt = {
    prompt: "where does hindsight run?",
    currentUserMessage: "where does hindsight run?",
    messages: [],
  };
  const subagentCtx = {
    agentId: "dev",
    sessionKey: "agent:dev:subagent:abc",
    memoryAudience: OWNER,
    runId: "r1",
  };

  it("recall-only subagent recalls from the owner bank and never retains", async () => {
    const { fake, hook, registerTool } = setup({
      recallOnlySessionPatterns: ["agent:dev:subagent:**"],
    });
    const result = await hook("before_prompt_build")(prompt, subagentCtx);
    expect(result.prependContext).toContain("- Studio hosts Hindsight [world]");
    expect(fake.requests[0]?.url).toBe(
      "http://hindsight.test/v1/default/banks/dev/memories/recall",
    );
    fake.requests.length = 0;
    await hook("agent_end")({ success: true, runId: "r1", messages }, subagentCtx);
    expect(retained(fake.requests)).toEqual([]);
    expect(fake.requests).toEqual([]);
    // Tools are registered as factories; the retain factory yields null for this session.
    const factories = registerTool.mock.calls.map(([factory, opts]) => [opts.name, factory]);
    const byName = Object.fromEntries(factories) as Record<string, AnyFn | undefined>;
    expect(byName.hindsight_retain!(subagentCtx)).toBeNull();
    expect(byName.hindsight_recall!(subagentCtx)).not.toBeNull();
    expect(byName.hindsight_reflect!(subagentCtx)).not.toBeNull();
  });

  it("ignored sessions neither recall nor retain, even when also recall-only", async () => {
    const { fake, hook } = setup({
      ignoreSessionPatterns: ["agent:dev:subagent:abc"],
      recallOnlySessionPatterns: ["agent:dev:subagent:**"],
    });
    expect(await hook("before_prompt_build")(prompt, subagentCtx)).toBeUndefined();
    await hook("agent_end")({ success: true, runId: "r1", messages }, subagentCtx);
    expect(fake.requests).toEqual([]);
  });

  it("leaves an unmatched subagent skipped and an unmatched main session retaining", async () => {
    const { fake, hook } = setup({ recallOnlySessionPatterns: ["agent:other:**"] });
    expect(await hook("before_prompt_build")(prompt, subagentCtx)).toBeUndefined();
    await hook("agent_end")({ success: true, runId: "r1", messages }, subagentCtx);
    expect(fake.requests).toEqual([]);
    const main = { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER };
    await hook("agent_end")({ success: true, runId: "r2", messages }, main);
    expect(retained(fake.requests)).toHaveLength(1);
  });
});

const FACT = [{ id: "m1", text: "Studio hosts Hindsight", type: "world" }];

function recallCtx(sessionKey = "agent:dev:main", audience = OWNER, agentId = "dev") {
  return { agentId, sessionKey, memoryAudience: audience };
}

function recallEv(text: string, messages: unknown[] = []) {
  return { prompt: text, currentUserMessage: text, messages };
}

describe("auto-recall cache and follow-ups", () => {
  const RECALL_DEV = "POST /v1/default/banks/dev/memories/recall";
  const RECALL_OPS = "POST /v1/default/banks/ops/memories/recall";
  const OPS = { kind: "owner-private" as const, agentId: "ops" };

  function setupRecall(extra: Record<string, unknown>, devResults: () => unknown[]) {
    const fake = createFakeHindsight({
      [RECALL_DEV]: () => ({ json: { results: devResults() } }),
      [RECALL_OPS]: () => ({ json: { results: [{ id: "o1", text: "ops fact", type: "world" }] } }),
    });
    vi.stubGlobal("fetch", fake.fetch);
    const pluginConfig = {
      hindsightApiUrl: "http://hindsight.test",
      allowInsecureHttp: true,
      hindsightApiToken: "t",
      ...extra,
    };
    const on = vi.fn<AnyFn>();
    const api = createFakePluginApi({ pluginConfig, config: {}, on });
    memoryPlugin.register(api);
    const run = on.mock.calls.find(([name]) => name === "before_prompt_build")![1];
    const recalls = () => fake.requests.filter((r) => r.url.endsWith("/memories/recall"));
    const sources = () =>
      (api.logger.debug as unknown as ReturnType<typeof vi.fn<AnyFn>>).mock.calls
        .map(([msg]) => /auto-recall source=(\S+)/.exec(String(msg))?.[1])
        .filter(Boolean);
    return { run, recalls, sources, fake };
  }

  it("with both keys off every call is fresh", async () => {
    const { run, recalls, sources } = setupRecall({}, () => FACT);
    await run(recallEv("where does hindsight run?"), recallCtx());
    await run(recallEv("where does hindsight run?"), recallCtx());
    await run(recallEv("and the mini"), recallCtx());
    expect(recalls()).toHaveLength(3);
    expect(sources()).toEqual(["fresh", "fresh", "fresh"]);
  });

  it("serves the same query from cache within the TTL and recalls after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { run, recalls, sources } = setupRecall({ recallCacheTtlMs: 1000 }, () => FACT);
      const first = await run(recallEv("where does hindsight run?"), recallCtx());
      vi.advanceTimersByTime(999);
      const second = await run(recallEv("where does hindsight run?"), recallCtx());
      expect(recalls()).toHaveLength(1);
      expect(first.prependContext).toContain("Studio hosts Hindsight");
      expect(second.prependContext).toContain("Studio hosts Hindsight");
      vi.advanceTimersByTime(2);
      await run(recallEv("where does hindsight run?"), recallCtx());
      expect(recalls()).toHaveLength(2);
      expect(sources()).toEqual(["fresh", "cached", "fresh"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("misses for a different query, session or bank", async () => {
    const { run, recalls } = setupRecall({ recallCacheTtlMs: 60_000 }, () => FACT);
    await run(recallEv("where does hindsight run?"), recallCtx());
    await run(recallEv("where does the nas live?"), recallCtx());
    expect(recalls()).toHaveLength(2);
    await run(recallEv("where does the nas live?"), recallCtx("agent:dev:other"));
    expect(recalls()).toHaveLength(3);
    await run(recallEv("where does the nas live?"), recallCtx("agent:dev:other", OPS, "ops"));
    expect(recalls()).toHaveLength(4);
    expect(recalls()[3]?.url).toContain("/banks/ops/");
    // The same session on another bank did not evict or reuse the dev entry.
    await run(recallEv("where does the nas live?"), recallCtx("agent:dev:other"));
    expect(recalls()).toHaveLength(5);
  });

  it("skips a short follow-up only after a recall that returned memories", async () => {
    const { run, recalls, sources } = setupRecall(
      { recallCacheTtlMs: 60_000, recallFollowupMaxWords: 6 },
      () => FACT,
    );
    await run(recallEv("where does hindsight run?"), recallCtx());
    const result = await run(recallEv("and the mini then"), recallCtx());
    expect(result).toBeUndefined();
    expect(recalls()).toHaveLength(1);
    expect(sources()).toEqual(["fresh", "followup-skip"]);
  });

  it("an empty recall never enables the skip; the follow-up expands with the previous message", async () => {
    const { run, recalls, sources } = setupRecall(
      { recallCacheTtlMs: 60_000, recallFollowupMaxWords: 6 },
      () => [],
    );
    const history = [
      { role: "user", content: "where does hindsight run?" },
      { role: "assistant", content: "on the studio" },
      { role: "user", content: "and the mini then" },
    ];
    await run(recallEv("where does hindsight run?"), recallCtx());
    await run(recallEv("and the mini then", history), recallCtx());
    expect(recalls()).toHaveLength(2);
    expect((recalls()[1]!.body as { query: string }).query).toBe(
      "where does hindsight run?\nand the mini then",
    );
    expect(sources()).toEqual(["fresh", "followup-expanded"]);
  });

  it("with no TTL a follow-up always recalls, expanded", async () => {
    const { run, recalls, sources } = setupRecall({ recallFollowupMaxWords: 6 }, () => FACT);
    const history = [
      { role: "user", content: "where does hindsight run?" },
      { role: "user", content: "and the mini then" },
    ];
    await run(recallEv("where does hindsight run?"), recallCtx());
    await run(recallEv("and the mini then", history), recallCtx());
    expect(recalls()).toHaveLength(2);
    expect(sources()).toEqual(["fresh", "followup-expanded"]);
  });

  it("a follow-up after the TTL recalls fresh instead of skipping", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { run, recalls } = setupRecall(
        { recallCacheTtlMs: 1000, recallFollowupMaxWords: 6 },
        () => FACT,
      );
      await run(recallEv("where does hindsight run?"), recallCtx());
      vi.advanceTimersByTime(1001);
      await run(recallEv("and the mini then"), recallCtx());
      expect(recalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never treats a URL or path message as a follow-up", async () => {
    const { run, recalls, sources } = setupRecall(
      { recallCacheTtlMs: 60_000, recallFollowupMaxWords: 6 },
      () => FACT,
    );
    await run(recallEv("where does hindsight run?"), recallCtx());
    await run(recallEv("see http://x.test"), recallCtx());
    await run(recallEv("open ~/work/x"), recallCtx());
    await run(recallEv("read src/index.ts"), recallCtx());
    expect(recalls()).toHaveLength(4);
    expect(sources()).toEqual(["fresh", "fresh", "fresh", "fresh"]);
  });

  it("a follow-up skip does not cross sessions", async () => {
    const { run, recalls } = setupRecall(
      { recallCacheTtlMs: 60_000, recallFollowupMaxWords: 6 },
      () => FACT,
    );
    await run(recallEv("where does hindsight run?"), recallCtx());
    const other = await run(recallEv("and the mini then"), recallCtx("agent:dev:other"));
    expect(recalls()).toHaveLength(2);
    expect(other.prependContext).toContain("Studio hosts Hindsight");
  });

  it("incognito and maintenance sessions still do no recall, cache or not", async () => {
    const { run, recalls } = setupRecall(
      { recallCacheTtlMs: 60_000, recallFollowupMaxWords: 6 },
      () => FACT,
    );
    await run(recallEv("where does hindsight run?"), recallCtx("agent:dev:dashboard:incognito-x"));
    await run(recallEv("where does hindsight run?"), {
      ...recallCtx("agent:dev:cron:job1"),
      trigger: "heartbeat",
    });
    expect(recalls()).toHaveLength(0);
  });

  it("boilerplate-only messages trigger no recall", async () => {
    const { run, recalls } = setupRecall({}, () => FACT);
    const banner =
      "[Inter-session message] sourceSession=agent:dev:subagent:1 isUser=false\nThis content was routed by OpenClaw from another session.";
    await expect(run(recallEv(banner), recallCtx())).resolves.toBeUndefined();
    expect(recalls()).toHaveLength(0);
  });
});

const cacheRecalls = (fake: ReturnType<typeof createFakeHindsight>) =>
  fake.requests.filter((r) => r.url.endsWith("/memories/recall"));
const retainToolFrom = (registerTool: ReturnType<typeof vi.fn<AnyFn>>, ctx: unknown) => {
  const factory = registerTool.mock.calls.find(([, opts]) => opts.name === "hindsight_retain")?.[0];
  return factory!(ctx)!;
};
const toolCtx = (sessionKey: string) => ({
  agentId: "dev",
  sessionKey,
  memoryAudience: OWNER,
  assertMemoryAudienceCurrent: () => undefined,
});

describe("recall cache and same-session retains", () => {
  const ask = recallEv("where does hindsight run?");

  it("recalls fresh after hindsight_retain in the same session, still cached for another", async () => {
    const { fake, hook, registerTool } = setup({ recallCacheTtlMs: 60_000 });
    const run = hook("before_prompt_build")!;
    await run(ask, recallCtx());
    await run(ask, recallCtx("agent:dev:other"));
    await run(ask, recallCtx());
    expect(cacheRecalls(fake)).toHaveLength(2);
    await retainToolFrom(registerTool, toolCtx("agent:dev:main")).execute("c1", {
      content: "Hindsight moved to the NAS",
    });
    // The same session's next turn does not reuse results from before its own retain.
    await run(ask, recallCtx());
    expect(cacheRecalls(fake)).toHaveLength(3);
    // Another session's entry is untouched.
    await run(ask, recallCtx("agent:dev:other"));
    expect(cacheRecalls(fake)).toHaveLength(3);
  });
});
