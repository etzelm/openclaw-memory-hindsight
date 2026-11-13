import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { createFakeHindsight } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

const OWNER = { kind: "owner-private" as const, agentId: "dev" };
const BASE = {
  hindsightApiUrl: "http://hindsight.test",
  allowInsecureHttp: true,
  hindsightApiToken: "test-token",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** register() against a host config with the given memory slot and extra host keys. */
function boot(params: {
  slot?: string | null;
  pluginConfig?: Record<string, unknown>;
  host?: Record<string, unknown>;
  refuseCapability?: boolean;
  withSupplements?: boolean;
}) {
  const fake = createFakeHindsight({
    "POST /v1/default/banks/dev/memories/recall": () => ({
      json: { results: [{ id: "m1", text: "Studio hosts Hindsight", type: "world" }] },
    }),
    "POST /v1/default/banks/dev/memories": () => ({ json: {} }),
    "PUT /v1/default/banks/dev": () => ({ json: {} }),
  });
  vi.stubGlobal("fetch", fake.fetch);
  const pluginConfig = { ...BASE, ...params.pluginConfig };
  const plugins: Record<string, unknown> = {
    entries: { [PLUGIN_ID]: { config: pluginConfig } },
  };
  if (params.slot !== undefined) {
    plugins.slots = { memory: params.slot };
  }
  const config = { ...params.host, plugins: { ...plugins, ...(params.host?.plugins as object) } };
  const on = vi.fn<AnyFn>();
  const registerMemoryCapability = vi.fn<AnyFn>(() => {
    if (params.refuseCapability) {
      throw new Error("only memory plugins can register a memory capability");
    }
  });
  const registerTool = vi.fn<AnyFn>();
  const registerService = vi.fn<AnyFn>();
  const registerMemoryCorpusSupplement = vi.fn<AnyFn>();
  const registerMemoryPromptSupplement = vi.fn<AnyFn>();
  const registerLearnContribution = vi.fn<AnyFn>();
  const api = {
    id: PLUGIN_ID,
    pluginConfig,
    config,
    logger: {
      info: vi.fn<AnyFn>(),
      warn: vi.fn<AnyFn>(),
      error: vi.fn<AnyFn>(),
      debug: vi.fn<AnyFn>(),
    },
    runtime: { config: { current: () => config } },
    on,
    registerMemoryCapability,
    registerTool,
    registerService,
    registerLearnContribution,
    ...(params.withSupplements === false
      ? {}
      : { registerMemoryCorpusSupplement, registerMemoryPromptSupplement }),
  } as unknown as OpenClawPluginApi;
  memoryPlugin.register(api);
  const hook = (name: string) => on.mock.calls.find(([hookName]) => hookName === name)?.[1];
  const tools = registerTool.mock.calls.map(([, opts]) => (opts as { name: string }).name);
  const logs = (level: "info" | "warn" | "error") =>
    (api.logger[level] as unknown as ReturnType<typeof vi.fn<AnyFn>>).mock.calls.map(([m]) =>
      String(m),
    );
  return {
    api,
    fake,
    hook,
    tools,
    logs,
    registerMemoryCapability,
    registerMemoryCorpusSupplement,
    registerMemoryPromptSupplement,
    registerLearnContribution,
    registerService,
  };
}

describe("slot role at registration", () => {
  it("owns the slot: registers the capability and /learn, no supplements", () => {
    const r = boot({
      slot: PLUGIN_ID,
      pluginConfig: { corpusSupplement: true, memoryPromptSection: true },
    });
    expect(r.registerMemoryCapability).toHaveBeenCalledTimes(1);
    expect(r.registerLearnContribution).toHaveBeenCalledTimes(1);
    expect(r.registerMemoryCorpusSupplement).not.toHaveBeenCalled();
    expect(r.registerMemoryPromptSupplement).not.toHaveBeenCalled();
    expect(r.tools).toEqual(["hindsight_retain", "hindsight_recall", "hindsight_reflect"]);
  });

  it("beside memory-core: no capability, no /learn, same hindsight_* tools, never memory_search", () => {
    const r = boot({ slot: "memory-core" });
    expect(r.registerMemoryCapability).not.toHaveBeenCalled();
    expect(r.registerLearnContribution).not.toHaveBeenCalled();
    expect(r.tools).toEqual(["hindsight_retain", "hindsight_recall", "hindsight_reflect"]);
    expect(r.tools).not.toContain("memory_search");
    expect(r.tools).not.toContain("memory_get");
    expect(r.hook("before_prompt_build")).toBeTypeOf("function");
    expect(r.hook("agent_end")).toBeTypeOf("function");
  });

  it("sidecar supplements are opt-in", () => {
    expect(boot({ slot: "memory-core" }).registerMemoryCorpusSupplement).not.toHaveBeenCalled();
    const r = boot({
      slot: "memory-core",
      pluginConfig: { corpusSupplement: true, memoryPromptSection: true },
    });
    expect(r.registerMemoryCorpusSupplement).toHaveBeenCalledTimes(1);
    expect(r.registerMemoryPromptSupplement).toHaveBeenCalledTimes(1);
    const section = r.registerMemoryPromptSupplement.mock.calls[0]![0]({
      availableTools: new Set(["hindsight_recall"]),
      citationsMode: "off",
    });
    expect(section[0]).toBe("## Hindsight memory");
  });

  it("warns instead of failing on a host without the supplement registrars", () => {
    const r = boot({
      slot: "memory-core",
      pluginConfig: { corpusSupplement: true, memoryPromptSection: true },
      withSupplements: false,
    });
    expect(r.logs("warn").some((m) => m.includes("no registerMemoryCorpusSupplement"))).toBe(true);
    expect(r.logs("warn").some((m) => m.includes("no registerMemoryPromptSupplement"))).toBe(true);
  });

  it("falls back to sidecar when the host refuses the capability (kind-less build)", () => {
    const r = boot({ refuseCapability: true, pluginConfig: { corpusSupplement: true } });
    expect(r.registerMemoryCapability).toHaveBeenCalledTimes(1);
    expect(r.registerLearnContribution).not.toHaveBeenCalled();
    expect(r.registerMemoryCorpusSupplement).toHaveBeenCalledTimes(1);
    expect(r.logs("warn").some((m) => m.includes("host refused the memory capability"))).toBe(true);
    expect(r.tools).toContain("hindsight_recall");
  });

  it("fails loudly instead of falling back when the slot names it or slotMode is replace", () => {
    for (const r of [
      boot({ slot: PLUGIN_ID, refuseCapability: true, pluginConfig: { corpusSupplement: true } }),
      boot({
        refuseCapability: true,
        pluginConfig: { slotMode: "replace", corpusSupplement: true },
      }),
    ]) {
      expect(r.registerMemoryCapability).toHaveBeenCalledTimes(1);
      expect(r.registerLearnContribution).not.toHaveBeenCalled();
      expect(r.registerMemoryCorpusSupplement).not.toHaveBeenCalled();
      expect(r.logs("warn").some((m) => m.includes("running as a sidecar"))).toBe(false);
      expect(r.logs("error").some((m) => m.includes("serves no memory runtime"))).toBe(true);
    }
  });

  it("logs the sidecar role and a slot conflict at service start", () => {
    const side = boot({ slot: "memory-core" });
    side.registerService.mock.calls[0]![0].start({});
    expect(side.logs("info")).toContain(
      "memory-hindsight: running as a sidecar beside memory-core; memory_search and memory_get stay with it",
    );
    side.registerService.mock.calls[0]![0].stop();
    const bad = boot({ slot: "memory-core", pluginConfig: { slotMode: "replace" } });
    bad.registerService.mock.calls[0]![0].start({});
    expect(bad.logs("warn").some((m) => m.includes("slotMode is replace"))).toBe(true);
    bad.registerService.mock.calls[0]![0].stop();
  });
});

const activeMemory = (config: Record<string, unknown> = {}) => ({
  plugins: {
    entries: {
      "active-memory": {
        enabled: true,
        config: { mode: "always", agents: ["dev"], toolsAllow: ["hindsight_recall"], ...config },
      },
    },
  },
});
const run = (r: ReturnType<typeof boot>, sessionKey = "agent:dev:telegram:direct:42") =>
  r.hook("before_prompt_build")!(
    {
      prompt: "where does Hindsight run",
      currentUserMessage: "where does Hindsight run",
      messages: [],
    },
    { agentId: "dev", sessionKey, messageProvider: "telegram", memoryAudience: OWNER },
  );
const recalls = (r: ReturnType<typeof boot>) =>
  r.fake.requests.filter((q) => q.url.endsWith("/memories/recall")).length;
const YIELD = { activeMemoryYield: true };

describe("sidecar auto-recall and Active Memory", () => {
  it("yields only with activeMemoryYield and when Active Memory recalls on this turn", async () => {
    const r = boot({ slot: "memory-core", pluginConfig: YIELD, host: activeMemory() });
    expect(await run(r)).toBeUndefined();
    expect(recalls(r)).toBe(0);
  });

  it("injects without activeMemoryYield (the session toggle is not visible), even when covered", async () => {
    const r = boot({ slot: "memory-core", host: activeMemory() });
    const out = await run(r);
    expect(recalls(r)).toBe(1);
    expect(JSON.stringify(out)).toContain("Studio hosts Hindsight");
  });

  it.each([
    ["mode off", activeMemory({ mode: "off" })],
    ["mode escalate", activeMemory({ mode: "escalate" })],
    ["denied chat id", activeMemory({ deniedChatIds: ["42"] })],
    ["hindsight_recall not in toolsAllow", activeMemory({ toolsAllow: ["memory_search"] })],
    ["plugin not loaded", { plugins: { deny: ["active-memory"], ...activeMemory().plugins } }],
  ] as const)("injects with activeMemoryYield when %s", async (_name, host) => {
    const r = boot({ slot: "memory-core", pluginConfig: YIELD, host });
    await run(r);
    expect(recalls(r)).toBe(1);
  });

  it("injects with activeMemoryYield in a group chat (Active Memory default is direct only)", async () => {
    const r = boot({ slot: "memory-core", pluginConfig: YIELD, host: activeMemory() });
    await run(r, "agent:dev:telegram:group:-100");
    expect(recalls(r)).toBe(1);
  });

  it("never yields as the slot owner", async () => {
    const r = boot({ slot: PLUGIN_ID, pluginConfig: YIELD, host: activeMemory() });
    await run(r);
    expect(recalls(r)).toBe(1);
  });
});

describe("memoryFileSync service", () => {
  it("retains workspace memory files into the owner bank after start, with the script's ids", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const root = mkdtempSync(join(tmpdir(), "hs-sidecar-sync-"));
    try {
      const ws = join(root, "ws");
      mkdirSync(join(ws, "memory"), { recursive: true });
      writeFileSync(join(ws, "MEMORY.md"), "rules\n");
      writeFileSync(join(ws, "memory", "2026-11-01.md"), "note\n");
      const r = boot({
        slot: "memory-core",
        pluginConfig: { memoryFileSync: true, memoryFileSyncAgents: ["dev"] },
        host: { agents: { list: [{ id: "dev", workspace: ws }] } },
      });
      const service = r.registerService.mock.calls[0]![0];
      service.start({ stateDir: join(root, "state") });
      await vi.advanceTimersByTimeAsync(30_000);
      // The first pass started at 30 s; wait for it to finish, then read what it did.
      await service.memoryFileSyncIdle();
      const ids = r.fake.requests
        .filter((q) => q.method === "POST" && q.url.endsWith("/banks/dev/memories"))
        .map((q) => (q.body as { items: Array<{ document_id: string }> }).items[0]!.document_id);
      expect(ids).toEqual(["MEMORY.md", "memory/2026-11-01.md"]);
      const state = JSON.parse(
        readFileSync(
          join(root, "state", "plugins", PLUGIN_ID, "memory-file-sync", "dev.json"),
          "utf8",
        ),
      );
      expect(Object.keys(state)).toEqual(["MEMORY.md", "memory/2026-11-01.md"]);
      service.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is off by default and warns when the host gives no state dir", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const off = boot({ slot: "memory-core" });
    off.registerService.mock.calls[0]![0].start({});
    expect(vi.getTimerCount()).toBe(0);
    off.registerService.mock.calls[0]![0].stop();
    const on = boot({ slot: "memory-core", pluginConfig: { memoryFileSync: true } });
    on.registerService.mock.calls[0]![0].start({});
    expect(on.logs("warn").some((m) => m.includes("memoryFileSync needs the host state dir"))).toBe(
      true,
    );
    on.registerService.mock.calls[0]![0].stop();
  });
});
