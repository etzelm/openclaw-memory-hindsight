import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { createFakeHindsight } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(extra: Record<string, unknown> = {}) {
  const fake = createFakeHindsight({
    "PUT /v1/default/banks/dev": () => ({ json: {} }),
    "POST /v1/default/banks/dev/memories": () => ({ json: {} }),
  });
  vi.stubGlobal("fetch", fake.fetch);
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "test-token",
    ...extra,
  };
  const config = { plugins: { entries: { [PLUGIN_ID]: { config: pluginConfig } } } };
  const on = vi.fn<AnyFn>();
  const registerMemoryCapability = vi.fn<AnyFn>();
  const registerTool = vi.fn<AnyFn>();
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
    registerService: vi.fn<AnyFn>(),
  };
  // SAFETY: register() only uses the members above.
  memoryPlugin.register(api as unknown as OpenClawPluginApi);
  const hook = (name: string) => on.mock.calls.find(([hookName]) => hookName === name)?.[1];
  const toolNames = registerTool.mock.calls.map(([, opts]) => String(opts.name));
  return { fake, hook, capability: registerMemoryCapability.mock.calls[0]?.[0], toolNames };
}

describe("private transcript recall registration", () => {
  it("is off by default: no flag, no direct tool, recall tools unchanged", () => {
    const { capability, toolNames } = setup();
    expect(capability.supportsPrivateTranscriptRecall).toBeUndefined();
    expect(capability.deterministicRecallToolName).toBeUndefined();
    expect(capability.recallToolNames).toEqual(["hindsight_recall", "hindsight_reflect"]);
    expect(toolNames).not.toContain("hindsight_conversation_recall");
  });

  it("declares the capability and registers the tool when privateTranscriptRecall is on", () => {
    const { capability, toolNames } = setup({ privateTranscriptRecall: true });
    expect(capability.supportsPrivateTranscriptRecall).toBe(true);
    expect(capability.deterministicRecallToolName).toBe("hindsight_conversation_recall");
    // Active Memory's default tool allowlist comes from recallToolNames.
    expect(capability.recallToolNames).toEqual([
      "hindsight_recall",
      "hindsight_reflect",
      "hindsight_conversation_recall",
    ]);
    expect(toolNames).toContain("hindsight_conversation_recall");
  });

  it("stamps auto-retained runs with the transcript id and the host's sandbox flag", async () => {
    const { fake, hook } = setup();
    const owner = { kind: "owner-private" as const, agentId: "dev" };
    const base = { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: owner };
    const end = hook("agent_end");
    await end(
      { success: true, runId: "r1", messages: [{ role: "user", content: "remember the plan" }] },
      { ...base, sessionId: "s-1", sandboxed: false },
    );
    await end(
      { success: true, runId: "r2", messages: [{ role: "user", content: "remember the plan" }] },
      { ...base, sessionId: "s-1", sandboxed: true },
    );
    await end(
      { success: true, runId: "r3", messages: [{ role: "user", content: "remember the plan" }] },
      base,
    );
    const metas = fake.requests
      .filter((r) => r.method === "POST")
      .map(
        (r) =>
          (r.body as { items: Array<{ metadata: Record<string, string> }> }).items[0]!.metadata,
      );
    expect(metas[0]).toMatchObject({ session_id: "s-1", sandboxed: "false" });
    expect(metas[1]).toMatchObject({ session_id: "s-1", sandboxed: "true" });
    expect(metas[2]).not.toHaveProperty("session_id");
    expect(metas[2]).not.toHaveProperty("sandboxed");
  });
});
