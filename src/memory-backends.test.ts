import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeToolRef, encodeToolRef, fusedToolFactory, storeOf } from "./fusion-tools.js";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import {
  configuredBackendIds,
  createFusedHandle,
  fuseRanked,
  type MemoryProviderHandle,
  unwrapReference,
  wrapReference,
} from "./memory-backends.js";
import { createHindsightProviderRuntime } from "./provider-runtime.js";
import type { MemoryPluginCapability } from "./sdk-types.js";
import { createFakeHindsight, createTestService } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;
type OpenParams = Parameters<NonNullable<MemoryPluginCapability["providerRuntime"]>["open"]>[0];
type Authority = OpenParams["context"]["authority"];

const OWNER_ID = "hindsight-native";
const ownerSession = (sessionKey = "agent:dev:main"): Authority => ({
  kind: "session",
  sessionKey,
  sandboxed: false,
  audience: { kind: "owner-private", agentId: "dev" },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeBackend(
  providerId: string,
  hits: { id: string; excerpt: string }[],
  overrides: Partial<MemoryProviderHandle> = {},
) {
  const close = vi.fn<AnyFn>(async () => {});
  const get = vi.fn<AnyFn>(async ({ reference }: { reference: { id: string } }) => ({
    status: "ok" as const,
    reference: { providerId, id: reference.id },
    text: `full text of ${reference.id}`,
    citations: [{ label: reference.id, reference: { providerId, id: reference.id } }],
  }));
  const handle: MemoryProviderHandle = {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: true },
    search: vi.fn<AnyFn>(async () => ({
      hits: hits.map((hit) => ({
        reference: { providerId, id: hit.id },
        excerpt: hit.excerpt,
        citations: [{ label: hit.id, reference: { providerId, id: hit.id } }],
      })),
    })),
    get,
    health: async () => ({ status: "ready" as const }),
    close,
    ...overrides,
  };
  return { handle, close, get };
}

function runtimeHarness(overrides: Record<string, unknown> = {}, store = true) {
  const fake = createFakeHindsight({
    "POST /v1/default/banks/dev/memories/recall": () => ({
      json: { results: [{ id: "m1", text: "Studio hosts Hindsight", scores: { final: 0.9 } }] },
    }),
    "PUT /v1/default/banks/dev": () => ({ json: {} }),
    "POST /v1/default/banks/dev/memories": () => ({ json: {} }),
    "GET /v1/default/banks/dev/documents/openclaw-store%3Aabc": () => ({
      json: { id: "openclaw-store:abc", original_text: "stored line 1\nline 2" },
    }),
  });
  const { service } = createTestService(fake.fetch, overrides);
  const runtime = createHindsightProviderRuntime({ providerId: OWNER_ID, service, store });
  const open = async (
    authority: Authority,
    extra: Partial<OpenParams> & { backends?: unknown } = {},
  ) => {
    const result = await runtime.open({
      cfg: {},
      agentId: "dev",
      context: { authority, assertCurrent: () => {} },
      ...extra,
    } as OpenParams);
    if (!result.provider) {
      throw new Error(result.error);
    }
    return result.provider as MemoryProviderHandle;
  };
  return { fake, open };
}

function fakeApi(params: { registrationMode?: string; config?: unknown }) {
  const calls = {
    registerMemoryCapability: vi.fn<AnyFn>(),
    registerTool: vi.fn<AnyFn>(),
    registerService: vi.fn<AnyFn>(),
    registerHttpRoute: vi.fn<AnyFn>(),
    registerCli: vi.fn<AnyFn>(),
    on: vi.fn<AnyFn>(),
  };
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "test-token",
  };
  const config = params.config ?? {
    plugins: { entries: { [PLUGIN_ID]: { config: pluginConfig } } },
  };
  const api = {
    id: PLUGIN_ID,
    ...(params.registrationMode ? { registrationMode: params.registrationMode } : {}),
    pluginConfig,
    config,
    logger: { info: vi.fn<AnyFn>(), warn: vi.fn<AnyFn>(), error: vi.fn<AnyFn>() },
    runtime: { config: { current: () => config } },
    ...calls,
  };
  return { api: api as unknown as OpenClawPluginApi, calls, logger: api.logger };
}

describe("memory backend references", () => {
  it("wraps a backend reference under the owner id and unwraps it again", () => {
    const inner = { providerId: "memory-core", id: "memory/2026-11-22.md#L1", revision: "r1" };
    const outer = wrapReference(OWNER_ID, inner);
    expect(outer.providerId).toBe(OWNER_ID);
    expect(outer.revision).toBe("r1");
    expect(unwrapReference(OWNER_ID, outer)).toEqual(inner);
  });

  it("does not unwrap Hindsight ids, foreign owners or self-wrapped ids", () => {
    expect(unwrapReference(OWNER_ID, { providerId: OWNER_ID, id: "6f1c-uuid" })).toBeNull();
    expect(unwrapReference(OWNER_ID, { providerId: OWNER_ID, id: "doc:openclaw-store:x" })).toBe(
      null,
    );
    expect(unwrapReference(OWNER_ID, { providerId: "memfusion", id: '["a","b"]' })).toBeNull();
    expect(
      unwrapReference(OWNER_ID, { providerId: OWNER_ID, id: '["hindsight-native","b"]' }),
    ).toBe(null);
    expect(unwrapReference(OWNER_ID, { providerId: OWNER_ID, id: "[not json" })).toBeNull();
  });
});

const hit = (providerId: string, id: string, excerpt: string) => ({
  reference: { providerId, id },
  excerpt,
});

describe("rank fusion", () => {
  it("interleaves lists by rank and merges identical excerpts", () => {
    const fused = fuseRanked([
      { id: "a", hits: [hit("a", "a1", "Alpha"), hit("a", "a2", "Shared  fact")] },
      { id: "b", hits: [hit("b", "b1", "shared fact"), hit("b", "b2", "Beta")] },
    ]);
    expect(fused.map((h) => h.reference.id)).toEqual(["b1", "a1", "b2"]);
  });
});

describe("configuredBackendIds", () => {
  it("lists enabled entries with memoryBackend true, never this plugin", () => {
    const config = {
      plugins: {
        entries: {
          "memory-core": { memoryBackend: true },
          "memory-lancedb": { memoryBackend: true, enabled: false },
          "memory-wiki": { enabled: true },
          [OWNER_ID]: { memoryBackend: true },
        },
      },
    };
    expect(configuredBackendIds(config, OWNER_ID)).toEqual(["memory-core"]);
    expect(configuredBackendIds({}, OWNER_ID)).toEqual([]);
  });
});

const own = () =>
  fakeBackend(OWNER_ID, [
    { id: "h1", excerpt: "Hindsight runs on the Studio" },
    { id: "h2", excerpt: "Mini runs the gateway" },
  ]);

describe("fused handle", () => {
  it("searches Hindsight and every backend, wrapping only backend references", async () => {
    const core = fakeBackend("memory-core", [{ id: "MEMORY.md#L3", excerpt: "MEMORY.md says hi" }]);
    const handle = createFusedHandle({
      ownerId: OWNER_ID,
      own: own().handle,
      backends: [{ id: "memory-core", providerId: "memory-core", handle: core.handle }],
    });
    expect(handle.capabilities).toEqual({
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
    });
    const page = await handle.search({ query: "where", maxResults: 10, cursor: "x" });
    expect(page.coverage).toBe("complete");
    expect(page.hits.map((h) => h.reference)).toEqual([
      { providerId: OWNER_ID, id: "h1" },
      { providerId: OWNER_ID, id: '["memory-core","MEMORY.md#L3"]' },
      { providerId: OWNER_ID, id: "h2" },
    ]);
    expect(page.hits[1]!.citations?.[0]?.reference?.providerId).toBe(OWNER_ID);
    // Pagination is not offered, so a cursor never reaches a store.
    expect(core.handle.search).toHaveBeenCalledWith({ query: "where", maxResults: 10 });
  });

  it("routes get by reference and translates the result back", async () => {
    const mine = own();
    const core = fakeBackend("memory-core", []);
    const handle = createFusedHandle({
      ownerId: OWNER_ID,
      own: mine.handle,
      backends: [{ id: "memory-core", providerId: "memory-core", handle: core.handle }],
    });
    const result = await handle.get({
      reference: wrapReference(OWNER_ID, { providerId: "memory-core", id: "MEMORY.md#L3" }),
    });
    expect(core.get).toHaveBeenCalledWith({
      reference: { providerId: "memory-core", id: "MEMORY.md#L3" },
    });
    expect(result).toMatchObject({
      status: "ok",
      reference: { providerId: OWNER_ID, id: '["memory-core","MEMORY.md#L3"]' },
      text: "full text of MEMORY.md#L3",
    });
    expect(result).toMatchObject({ citations: [{ reference: { providerId: OWNER_ID } }] });
    await handle.get({ reference: { providerId: OWNER_ID, id: "h1" } });
    expect(mine.get).toHaveBeenCalledWith({ reference: { providerId: OWNER_ID, id: "h1" } });
    expect(
      await handle.get({
        reference: wrapReference(OWNER_ID, { providerId: "memory-lancedb", id: "x" }),
      }),
    ).toEqual({ status: "not_found" });
  });

  it("reports a failing or slow backend as partial coverage and keeps the other hits", async () => {
    const broken = fakeBackend("memory-core", [], {
      search: async () => {
        throw new Error("index locked");
      },
    });
    const slow = fakeBackend("memory-lancedb", [], {
      search: () => new Promise(() => {}),
    });
    const handle = createFusedHandle({
      ownerId: OWNER_ID,
      own: own().handle,
      backends: [
        { id: "memory-core", providerId: "memory-core", handle: broken.handle },
        { id: "memory-lancedb", providerId: "memory-lancedb", handle: slow.handle },
      ],
      openFailures: [{ id: "memfoo", error: "no provider" }],
      timeoutMs: 20,
    });
    const page = await handle.search({ query: "q" });
    expect(page.coverage).toBe("partial");
    expect(page.hits.map((h) => h.reference.id)).toEqual(["h1", "h2"]);
    expect(page.warning).toContain("memfoo (no provider)");
    expect(page.warning).toContain("memory-core (index locked)");
    expect(page.warning).toContain("memory-lancedb search timed out after 20 ms");
  });

  it("is degraded when a backend is not ready and closes every lease once", async () => {
    const mine = own();
    const core = fakeBackend("memory-core", [], {
      health: async () => ({ status: "unavailable" as const }),
    });
    const handle = createFusedHandle({
      ownerId: OWNER_ID,
      own: mine.handle,
      backends: [{ id: "memory-core", providerId: "memory-core", handle: core.handle }],
    });
    const health = await handle.health();
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ backends: { "memory-core": "unavailable" } });
    await handle.close();
    await handle.close();
    expect(mine.close).toHaveBeenCalledTimes(1);
    expect(core.close).toHaveBeenCalledTimes(1);
    await expect(handle.search({ query: "q" })).rejects.toThrow("lease is closed");
  });
});

describe("provider runtime as a fusion owner", () => {
  it("returns the plain handle when the host passes no backends", async () => {
    const provider = await runtimeHarness({}, false).open(ownerSession(), {});
    const page = await provider.search({ query: "hindsight" });
    expect(page.hits.map((h) => h.reference)).toEqual([{ providerId: OWNER_ID, id: "m1" }]);
    expect(page.coverage).toBe("complete");
  });

  it("fuses the backends the host passes and reports one that fails to open", async () => {
    const core = fakeBackend("memory-core", [{ id: "MEMORY.md#L1", excerpt: "From MEMORY.md" }]);
    const backends = {
      list: () => [{ id: "memory-core" }, { id: "memory-lancedb" }],
      open: async (id: string) =>
        id === "memory-core"
          ? { provider: core.handle, providerId: "memory-core", adapter: "legacy" as const }
          : { provider: null, error: "not loaded" },
    };
    const provider = await runtimeHarness({}, false).open(ownerSession(), { backends });
    const page = await provider.search({ query: "hindsight" });
    expect(page.hits.map((h) => storeOf(OWNER_ID, h.reference))).toEqual([
      "hindsight",
      "memory-core",
    ]);
    expect(page.coverage).toBe("partial");
    expect(page.warning).toContain("memory-lancedb (not loaded)");
    await provider.close();
    expect(core.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the plain handle when the host lists no backend", async () => {
    const backends = { list: () => [], open: vi.fn<AnyFn>() };
    const provider = await runtimeHarness({}, false).open(ownerSession(), { backends });
    expect(provider.health).toBeTypeOf("function");
    expect(backends.open).not.toHaveBeenCalled();
    expect((await provider.search({ query: "x" })).warning).toBeUndefined();
  });
});

const toolNames = (registerTool: ReturnType<typeof vi.fn<AnyFn>>) =>
  registerTool.mock.calls.map(([, opts]) => String(opts.name));

describe("registration with memory backends", () => {
  it("adds fused memory_search and memory_get when it owns the slot with a backend", () => {
    const pluginConfig = { hindsightApiUrl: "http://hindsight.test", allowInsecureHttp: true };
    const { api, calls } = fakeApi({
      config: {
        plugins: {
          slots: { memory: PLUGIN_ID },
          entries: {
            [PLUGIN_ID]: { config: pluginConfig },
            "memory-core": { enabled: true, memoryBackend: true },
          },
        },
      },
    });
    memoryPlugin.register(api);
    expect(toolNames(calls.registerTool)).toEqual(
      expect.arrayContaining(["memory_search", "memory_get", "hindsight_recall"]),
    );
    expect(calls.on).toHaveBeenCalled();
  });

  it.each([
    ["owner without a backend", { slots: { memory: PLUGIN_ID }, entries: {} }],
    [
      "sidecar beside memory-core",
      { slots: { memory: "memory-core" }, entries: { "memory-core": { memoryBackend: true } } },
    ],
  ])("keeps the 0.11 tool set as %s", (_label, plugins) => {
    const { api, calls } = fakeApi({ config: { plugins } });
    memoryPlugin.register(api);
    expect(toolNames(calls.registerTool)).not.toContain("memory_search");
    expect(toolNames(calls.registerTool)).not.toContain("memory_get");
  });
});

describe("fused agent tools", () => {
  const ctx = {
    agentId: "dev",
    sessionKey: "agent:dev:main",
    sessionId: "s1",
    memoryAudience: { kind: "owner-private", agentId: "dev" },
    config: {},
  };

  it("opens the host provider with the session's authority and returns store-tagged results", async () => {
    const core = fakeBackend("memory-core", [{ id: "MEMORY.md#L1", excerpt: "From MEMORY.md" }]);
    const mine = fakeBackend(OWNER_ID, [{ id: "h1", excerpt: "From Hindsight" }]);
    const fused = () =>
      createFusedHandle({
        ownerId: OWNER_ID,
        own: mine.handle,
        backends: [{ id: "memory-core", providerId: "memory-core", handle: core.handle }],
      });
    const openActive = vi.fn<AnyFn>(async () => ({ provider: fused(), providerId: OWNER_ID }));
    const search = fusedToolFactory(OWNER_ID, 0, async () => openActive)(ctx as never)!;
    const result = await search.execute("call1", { query: "where" } as never, undefined as never);
    const opened = openActive.mock.calls[0]![0];
    expect(opened.agentId).toBe("dev");
    expect(opened.context.authority).toEqual({
      kind: "session",
      sessionKey: "agent:dev:main",
      sandboxed: false,
      sessionId: "s1",
      audience: { kind: "owner-private", agentId: "dev" },
    });
    const details = (result as { details: { results: { store: string; ref: string }[] } }).details;
    expect(details.results.map((r) => r.store)).toEqual(["hindsight", "memory-core"]);
    const get = fusedToolFactory(OWNER_ID, 1, async () => openActive)(ctx as never)!;
    const read = await get.execute(
      "call2",
      { ref: details.results[1]!.ref } as never,
      undefined as never,
    );
    expect(core.get).toHaveBeenCalledWith({
      reference: { providerId: "memory-core", id: "MEMORY.md#L1" },
    });
    expect(JSON.stringify(read)).toContain("full text of MEMORY.md#L1");
    expect(core.close).toHaveBeenCalledTimes(2);
  });

  it("refuses when another plugin owns the slot, and has no tool without a session", async () => {
    const openActive = vi.fn<AnyFn>(async () => ({
      provider: fakeBackend("memfusion", []).handle,
      providerId: "memfusion",
    }));
    const search = fusedToolFactory(OWNER_ID, 0, async () => openActive)(ctx as never)!;
    const result = await search.execute("c", { query: "q" } as never, undefined as never);
    expect(JSON.stringify(result)).toContain("owned by memfusion");
    expect(fusedToolFactory(OWNER_ID, 0)({ agentId: "dev" } as never)).toBeNull();
  });

  it("reports open errors, missing refs and partial coverage to the model", async () => {
    const unavailable = vi.fn<AnyFn>(async () => ({ provider: null, error: "no memory slot" }));
    const search = fusedToolFactory(OWNER_ID, 0, async () => unavailable)(ctx as never)!;
    expect(
      JSON.stringify(await search.execute("c", { query: "q" } as never, undefined as never)),
    ).toContain("no memory slot");
    await expect(search.execute("c", { query: " " } as never, undefined as never)).rejects.toThrow(
      "query",
    );
    let seen: { assertCurrent(): void } | undefined;
    const partial = vi.fn<AnyFn>(async (params: { context: { assertCurrent(): void } }) => {
      seen = params.context;
      params.context.assertCurrent();
      return {
        provider: {
          ...fakeBackend(OWNER_ID, []).handle,
          search: async () => ({ hits: [], coverage: "partial", warning: "memory-core (down)" }),
          get: async () => ({ status: "not_found" }),
        },
        providerId: OWNER_ID,
      };
    });
    const partialSearch = fusedToolFactory(OWNER_ID, 0, async () => partial)(ctx as never)!;
    const text = JSON.stringify(
      await partialSearch.execute("c", { query: "q", maxResults: 99 } as never, undefined as never),
    );
    expect(text).toContain("No relevant memories found.");
    expect(text).toContain("memory-core (down)");
    expect(() => seen!.assertCurrent()).toThrow("has completed");
    const get = fusedToolFactory(OWNER_ID, 1, async () => partial)(ctx as never)!;
    const ref = encodeToolRef({ providerId: OWNER_ID, id: "h9" });
    expect(JSON.stringify(await get.execute("c", { ref } as never, undefined as never))).toContain(
      "not_found",
    );
    await expect(get.execute("c", { ref: "zz" } as never, undefined as never)).rejects.toThrow(
      "not a memory_search ref",
    );
    const getUnavailable = fusedToolFactory(OWNER_ID, 1, async () => unavailable)(ctx as never)!;
    expect(
      JSON.stringify(await getUnavailable.execute("c", { ref } as never, undefined as never)),
    ).toContain("no memory slot");
  });

  it("loads the host opener from the SDK and fails clearly on a host without it", async () => {
    const getActiveMemoryProvider = vi.fn<AnyFn>();
    vi.doMock("openclaw/plugin-sdk/memory-host-search", () => ({ getActiveMemoryProvider }));
    vi.resetModules();
    const withOpener = await import("./fusion-tools.js");
    expect(await withOpener.loadActiveProviderOpener()).toBe(getActiveMemoryProvider);
    vi.doMock("openclaw/plugin-sdk/memory-host-search", () => ({
      getActiveMemoryProvider: undefined,
    }));
    vi.resetModules();
    const without = await import("./fusion-tools.js");
    await expect(without.loadActiveProviderOpener()).rejects.toThrow(
      "cannot open the memory provider",
    );
    vi.doUnmock("openclaw/plugin-sdk/memory-host-search");
    vi.resetModules();
  });

  it("round-trips tool refs and rejects garbage", () => {
    const ref = { providerId: OWNER_ID, id: '["memory-core","a"]', revision: "2" };
    expect(decodeToolRef(OWNER_ID, encodeToolRef(ref))).toEqual(ref);
    expect(decodeToolRef(OWNER_ID, "!!")).toBeNull();
  });
});
