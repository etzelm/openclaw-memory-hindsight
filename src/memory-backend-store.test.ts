import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import type { MemoryProviderHandle } from "./memory-backends.js";
import { createHindsightProviderRuntime, storeDocumentId } from "./provider-runtime.js";
import { conversationBankId } from "./routing.js";
import type { MemoryPluginCapability } from "./sdk-types.js";
import { createFakeHindsight, createTestService } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;
type OpenParams = Parameters<NonNullable<MemoryPluginCapability["providerRuntime"]>["open"]>[0];
type Authority = OpenParams["context"]["authority"];

const OWNER_ID = "hindsight-native";
const OPERATOR: Authority = { kind: "operator", scopes: ["operator.read"] };
const ownerSession = (sessionKey = "agent:dev:main"): Authority => ({
  kind: "session",
  sessionKey,
  sandboxed: false,
  audience: { kind: "owner-private", agentId: "dev" },
});
const conversation: Authority = {
  kind: "session",
  sessionKey: "agent:dev:telegram:group:-100",
  sandboxed: false,
  audience: {
    kind: "conversation",
    agentId: "dev",
    sessionKey: "agent:dev:telegram:group:-100",
    sessionId: "s1",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("provider runtime as a memory backend", () => {
  it("offers no store unless the backend role asks for it (0.11 handle)", async () => {
    const provider = await runtimeHarness({}, false).open(ownerSession());
    expect(provider.capabilities).toEqual({
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
    });
    expect(provider.store).toBeUndefined();
  });

  it("stores into the caller's audience bank with a stable replace document", async () => {
    const { fake, open } = runtimeHarness({ retainTags: ["openclaw"] });
    const provider = await open(ownerSession());
    expect(provider.capabilities.store).toBe(true);
    const result = await provider.store!({
      text: "  Mitchell prefers short commit subjects  ",
      title: "preference",
      tags: ["style", "openclaw"],
      origin: "tool",
    });
    const documentId = storeDocumentId("dev", "Mitchell prefers short commit subjects");
    expect(result).toEqual({
      status: "stored",
      reference: { providerId: OWNER_ID, id: `doc:${documentId}` },
    });
    const retain = fake.requests.find(
      (r) => r.method === "POST" && r.url.endsWith("/banks/dev/memories"),
    );
    expect(retain?.body).toEqual({
      async: true,
      items: [
        {
          content: "Mitchell prefers short commit subjects",
          context: "preference",
          tags: ["openclaw", "style"],
          document_id: documentId,
          update_mode: "replace",
          metadata: {
            source: "openclaw",
            agent_id: "dev",
            session_key: "agent:dev:main",
            retention_scope: "provider_store_tool",
          },
        },
      ],
    });
  });

  it("stores a conversation's memory in that conversation's bank", async () => {
    const bank = conversationBankId("dev", "agent:dev:telegram:group:-100");
    const fake = createFakeHindsight({
      [`POST /v1/default/banks/${encodeURIComponent(bank)}/memories`]: () => ({ json: {} }),
    });
    const { service } = createTestService(fake.fetch);
    const runtime = createHindsightProviderRuntime({ providerId: OWNER_ID, service, store: true });
    const opened = await runtime.open({
      cfg: {},
      agentId: "dev",
      context: { authority: conversation, assertCurrent: () => {} },
    } as OpenParams);
    const provider = opened.provider as MemoryProviderHandle;
    expect(provider.capabilities.store).toBe(true);
    expect(await provider.store!({ text: "group fact" })).toMatchObject({ status: "stored" });
    expect(bank).not.toBe("dev");
    expect(fake.requests).toHaveLength(1);
    expect(
      (fake.requests[0]!.body as { items: { document_id: string }[] }).items[0]!.document_id,
    ).toBe(storeDocumentId(bank, "group fact"));
  });

  it.each([
    ["an operator", OPERATOR, {}, {}],
    ["a status lease", ownerSession(), {}, { purpose: "status" }],
    ["context mode", ownerSession(), { memoryMode: "context" }, {}],
    ["an incognito session", ownerSession("agent:dev:dashboard:incognito-x"), {}, {}],
    [
      "a session without audience",
      { kind: "session", sessionKey: "agent:dev:x", sandboxed: false } as Authority,
      {},
      {},
    ],
  ])("is read only for %s", async (_label, authority, overrides, extra) => {
    const provider = await runtimeHarness(overrides).open(authority, extra as Partial<OpenParams>);
    expect(provider.capabilities.store).toBeUndefined();
    expect(provider.store).toBeUndefined();
  });

  it("rejects an empty store without a request", async () => {
    const { fake, open } = runtimeHarness();
    const provider = await open(ownerSession());
    expect(await provider.store!({ text: "   " })).toMatchObject({ status: "rejected" });
    expect(fake.requests).toEqual([]);
  });

  it("reads a stored document by its doc reference and refuses other documents", async () => {
    const { open } = runtimeHarness();
    const provider = await open(ownerSession());
    expect(
      await provider.get({
        reference: { providerId: OWNER_ID, id: "doc:openclaw-store:abc" },
        lines: 1,
      }),
    ).toMatchObject({ status: "ok", text: "stored line 1", truncated: true, nextFrom: 2 });
    expect(
      await provider.get({ reference: { providerId: OWNER_ID, id: "doc:openclaw:session-run" } }),
    ).toEqual({ status: "not_found" });
  });
});

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

describe("registration with memory backends", () => {
  it("registers only the provider runtime in memory-backend mode, without network", () => {
    const fetch = vi.fn<AnyFn>();
    vi.stubGlobal("fetch", fetch);
    const { api, calls, logger } = fakeApi({ registrationMode: "memory-backend" });
    memoryPlugin.register(api);
    expect(calls.registerMemoryCapability).toHaveBeenCalledTimes(1);
    const capability = calls.registerMemoryCapability.mock.calls[0]![0];
    expect(Object.keys(capability)).toEqual(["providerRuntime"]);
    expect(capability.providerRuntime.open).toBeTypeOf("function");
    expect(calls.registerTool).not.toHaveBeenCalled();
    expect(calls.registerService).not.toHaveBeenCalled();
    expect(calls.registerHttpRoute).not.toHaveBeenCalled();
    expect(calls.on).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("memory backend"));
  });

  it("opens lazily in memory-backend mode and stores through the caller's audience", async () => {
    const fake = createFakeHindsight({
      "PUT /v1/default/banks/dev": () => ({ json: {} }),
      "POST /v1/default/banks/dev/memories": () => ({ json: {} }),
    });
    vi.stubGlobal("fetch", fake.fetch);
    const { api, calls } = fakeApi({ registrationMode: "memory-backend" });
    memoryPlugin.register(api);
    const runtime = calls.registerMemoryCapability.mock.calls[0]![0].providerRuntime;
    const { provider } = await runtime.open({
      cfg: {},
      agentId: "dev",
      context: { authority: ownerSession(), assertCurrent: () => {} },
    });
    expect(fake.requests).toEqual([]);
    expect(await provider.store({ text: "fact" })).toMatchObject({ status: "stored" });
    expect(fake.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toContain(
      "POST /v1/default/banks/dev/memories",
    );
  });
});
