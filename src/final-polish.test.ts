import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HindsightHttpError } from "./client.js";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { RecallBreaker } from "./recall-breaker.js";
import { spyOnTimeouts } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;
type Result = { prependContext?: string } | undefined;

const OWNER = { kind: "owner-private" as const, agentId: "dev" };
const SESSION = "agent:dev:main";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * fetch double: each recall takes the next answer from `answers` ("hang" never answers, "5xx"
 * answers 503 at once).
 */
function setup(extra: Record<string, unknown>, answers: (string[] | "hang" | "5xx")[]) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, body });
      const answer = answers.shift() ?? [];
      if (answer === "hang") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      if (answer === "5xx") {
        return Promise.resolve(new Response("{}", { status: 503 }));
      }
      const results = answer.map((text, i) => ({ id: `m${i}`, text, type: "world" }));
      return Promise.resolve(new Response(JSON.stringify({ results }), { status: 200 }));
    },
  );
  vi.stubGlobal("fetch", fetch);
  const entry: Record<string, unknown> = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "t",
    ...extra,
  };
  const config = { plugins: { entries: { [PLUGIN_ID]: { config: entry } } } };
  const on = vi.fn<AnyFn>();
  const registerMemoryCapability = vi.fn<AnyFn>();
  const api = {
    id: PLUGIN_ID,
    pluginConfig: { ...entry },
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
    registerTool: vi.fn<AnyFn>(),
    registerService: vi.fn<AnyFn>(),
  } as unknown as OpenClawPluginApi;
  memoryPlugin.register(api);
  const hook = (name: string) =>
    on.mock.calls.find(([hookName]) => hookName === name)?.[1] as AnyFn | undefined;
  const recalls = () => requests.filter((r) => r.url.endsWith("/memories/recall"));
  const received = (text: string, runId: string, sessionKey = SESSION) =>
    hook("message_received")?.(
      { content: text, from: "user", sessionKey, runId },
      { channelId: "webchat", sessionKey, runId },
    ) as Promise<void> | undefined;
  const buildAs = (agentId: string, text: string, runId: string, sessionKey?: string) =>
    hook("before_prompt_build")!(
      { prompt: text, currentUserMessage: text, messages: [] },
      {
        agentId,
        sessionKey: sessionKey ?? `agent:${agentId}:main`,
        runId,
        memoryAudience: { kind: "owner-private" as const, agentId },
      },
    ) as Promise<Result>;
  const build = (text: string, runId: string, sessionKey = SESSION) =>
    hook("before_prompt_build")!(
      { prompt: text, currentUserMessage: text, messages: [] },
      { agentId: "dev", sessionKey, runId, memoryAudience: OWNER },
    ) as Promise<Result>;
  const capability = () =>
    registerMemoryCapability.mock.calls[0]![0] as {
      providerRuntime: { open: AnyFn };
      promptBuilder?: (params: { availableTools: Set<string>; agentId?: string }) => string[];
    };
  const health = async () => {
    const { provider } = await capability().providerRuntime.open({
      cfg: {},
      agentId: "dev",
      purpose: "status",
      context: {
        authority: { kind: "operator", scopes: ["operator.read"] },
        assertCurrent: () => {},
      },
    });
    return provider.health() as Promise<{ status: string; details: Record<string, unknown> }>;
  };
  return { recalls, received, build, buildAs, api, entry, capability, health };
}

const facts = (result: Result) =>
  (result?.prependContext ?? "").split("\n").filter((line) => line.startsWith("- "));
const logLines = (api: OpenClawPluginApi, level: "info" | "debug" | "warn") =>
  (api.logger[level] as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([m]) => m);

describe("recallEarlyStart: an outage costs a turn at most one timeout (0.9.0 review N1)", () => {
  it("does not send a second request when the early one timed out, and counts it", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { received, build, recalls } = setup({ recallEarlyStart: true }, [
        ["first fact"],
        "hang",
        "hang",
        "hang",
        "hang",
      ]);
      await build("where does hindsight run?", "r1");
      for (const [q, r] of [
        ["which port does it use?", "r2"],
        ["and the hostname?", "r3"],
        ["and the bank id?", "r4"],
      ]) {
        await received(q!, r!);
        expect(await build(q!, r!)).toBeUndefined();
      }
      // One request per turn: the early one. Three taken timeouts opened the breaker.
      expect(recalls()).toHaveLength(4);
      expect(timeouts.requested).toHaveLength(4);
      await received("and the api version?", "r5");
      expect(await build("and the api version?", "r5")).toBeUndefined();
      expect(recalls()).toHaveLength(4);
    } finally {
      timeouts.restore();
    }
  });

  it("injects the young stale block instead when the early request timed out", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { received, build, recalls } = setup(
        { recallEarlyStart: true, recallStaleOnTimeout: 60_000 },
        [["first fact"], "hang", ["never sent"]],
      );
      await build("where does hindsight run?", "r1");
      await received("which port does it use?", "r2");
      expect(facts(await build("which port does it use?", "r2"))).toEqual(["- first fact [world]"]);
      expect(recalls()).toHaveLength(2);
    } finally {
      timeouts.restore();
    }
  });

  it("still recalls again when the early request failed fast (5xx)", async () => {
    const { received, build, recalls } = setup({ recallEarlyStart: true }, [
      ["first fact"],
      "5xx",
      ["fresh fact"],
    ]);
    await build("where does hindsight run?", "r1");
    await received("which port does it use?", "r2");
    expect(facts(await build("which port does it use?", "r2"))).toEqual(["- fresh fact [world]"]);
    expect(recalls()).toHaveLength(3);
  });

  it("a timed-out early request under a tight agent timeout does not count", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { received, build, buildAs, recalls } = setup(
        { recallEarlyStart: true, agents: { dev: { recallTimeoutMs: 250 } } },
        [["first fact"], "hang", "hang", "hang", ["main fact"]],
      );
      await build("where does hindsight run?", "r1");
      for (const [q, r] of [
        ["which port does it use?", "r2"],
        ["and the hostname?", "r3"],
        ["and the bank id?", "r4"],
      ]) {
        await received(q!, r!);
        await build(q!, r!);
      }
      expect(facts(await buildAs("main", "what is on the calendar today?", "m1"))).toEqual([
        "- main fact [world]",
      ]);
      expect(recalls()).toHaveLength(5);
    } finally {
      timeouts.restore();
    }
  });
});

describe("a tight-timeout probe does not reopen the breaker (0.9.0 review N2)", () => {
  it("frees the probe slot without a new cool-down, so the next turn probes", async () => {
    const timeouts = spyOnTimeouts();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    try {
      const { buildAs, recalls } = setup({ agents: { dev: { recallTimeoutMs: 250 } } }, [
        "5xx",
        "5xx",
        "5xx",
        "hang",
        ["main fact"],
      ]);
      for (const r of ["m1", "m2", "m3"]) {
        await buildAs("main", "what is on the calendar today?", r);
      }
      expect(await buildAs("main", "and tomorrow?", "m4")).toBeUndefined();
      expect(recalls()).toHaveLength(3);
      now.mockReturnValue(1_000_000 + 61_000);
      // dev carries the probe and times out under its own 250 ms.
      expect(await buildAs("dev", "which port does it use?", "d1")).toBeUndefined();
      expect(recalls()).toHaveLength(4);
      // The next turn probes at once instead of waiting another cool-down.
      expect(facts(await buildAs("main", "what about friday?", "m5"))).toEqual([
        "- main fact [world]",
      ]);
      expect(recalls()).toHaveLength(5);
    } finally {
      timeouts.restore();
    }
  });

  it("RecallBreaker.releaseProbe frees the slot and keeps the breaker open", () => {
    let t = 0;
    const breaker = new RecallBreaker({ now: () => t });
    const down = new HindsightHttpError("down", 503);
    breaker.record(down);
    breaker.record(down);
    breaker.record(down);
    t = 61_000;
    expect(breaker.admit()).toBe("probe");
    expect(breaker.admit()).toBe("skip");
    breaker.releaseProbe();
    expect(breaker.state()).toBe("open");
    expect(breaker.admit()).toBe("probe");
  });
});

describe("early answer from before a failure (0.9.0 review N3)", () => {
  it("does not close a breaker that opened after the early request answered", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { received, build, recalls, api } = setup({ recallEarlyStart: true }, [
        ["first fact"],
        ["early fact"],
        "hang",
        "hang",
        "hang",
        ["never sent"],
      ]);
      await build("where does hindsight run?", "r1");
      await received("which port does it use?", "r2");
      // Another session of the same agent sees three timeouts: the breaker opens.
      for (const r of ["o1", "o2", "o3"]) {
        await build("what is the weather?", r, "agent:dev:other");
      }
      expect(recalls()).toHaveLength(5);
      // The turn still uses its early answer, but the answer is older than the outage.
      expect(facts(await build("which port does it use?", "r2"))).toEqual(["- early fact [world]"]);
      expect(logLines(api, "info")).not.toContain("memory-hindsight: auto-recall resumed");
      expect(await build("and the hostname?", "r3")).toBeUndefined();
      expect(recalls()).toHaveLength(5);
    } finally {
      timeouts.restore();
    }
  });
});

describe("the tight-timeout rule reads the global timeout when the request is sent (N5)", () => {
  it("a live change of the global timeout during a request does not flip the decision", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build, buildAs, recalls, entry } = setup(
        { agents: { dev: { recallTimeoutMs: 250 } } },
        ["hang", "hang", "hang", ["main fact"]],
      );
      for (const [q, r] of [
        ["where does hindsight run?", "r1"],
        ["which port does it use?", "r2"],
        ["and the hostname?", "r3"],
      ]) {
        const turn = build(q!, r!);
        entry.recallTimeoutMs = 250;
        await turn;
        delete entry.recallTimeoutMs;
      }
      expect(facts(await buildAs("main", "what is on the calendar today?", "m1"))).toEqual([
        "- main fact [world]",
      ]);
      expect(recalls()).toHaveLength(4);
    } finally {
      timeouts.restore();
    }
  });
});

describe("earlier P3s (0.9.0 review)", () => {
  it("a live change of recallTypes is not served from the recall cache", async () => {
    const { build, recalls, entry } = setup({ recallCacheTtlMs: 600_000 }, [
      ["old fact"],
      ["new fact"],
    ]);
    await build("where does hindsight run?", "r1");
    entry.recallTypes = ["world"];
    expect(facts(await build("where does hindsight run?", "r2"))).toEqual(["- new fact [world]"]);
    expect(recalls()).toHaveLength(2);
  });

  it("reports the last recall error when only an agents entry turns autoRecall on", async () => {
    const { build, health } = setup({ autoRecall: false, agents: { dev: { autoRecall: true } } }, [
      "5xx",
    ]);
    await build("where does hindsight run?", "r1");
    const h = await health();
    expect(h.status).toBe("degraded");
    expect(h.details).toMatchObject({ lastRecallError: "http_5xx" });
  });

  it("the prompt section follows the agent's own autoRecall", () => {
    const tools = new Set(["hindsight_recall"]);
    const off = setup(
      { memoryPromptSection: true, agents: { quiet: { autoRecall: false } } },
      [],
    ).capability().promptBuilder!;
    expect(off({ availableTools: tools, agentId: "quiet" }).join("\n")).not.toContain(
      "<hindsight_memories>",
    );
    expect(off({ availableTools: tools, agentId: "dev" }).join("\n")).toContain(
      "<hindsight_memories>",
    );
    const on = setup(
      { memoryPromptSection: true, autoRecall: false, agents: { dev: { autoRecall: true } } },
      [],
    ).capability().promptBuilder!;
    expect(on({ availableTools: tools, agentId: "dev" }).join("\n")).toContain(
      "<hindsight_memories>",
    );
    expect(on({ availableTools: tools, agentId: "other" }).join("\n")).not.toContain(
      "<hindsight_memories>",
    );
  });
});

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\s+/g, " ");

describe("docs (0.9.0 review P2-3, N1, N4, P3)", () => {
  it("labels recallEarlyStart experimental in README, docs, manifest and upgrade notes", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/\| `recallEarlyStart` \| `false` \| Experimental[:.]/);
    const docs = read("docs/configuration.md");
    expect(docs).toMatch(/`recallEarlyStart` \(experimental\)/);
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      uiHints: Record<string, { label: string; help: string }>;
      configSchema: { properties: Record<string, { description: string }> };
    };
    expect(manifest.uiHints.recallEarlyStart!.label).toMatch(/\(Experimental\)$/);
    expect(manifest.uiHints.recallEarlyStart!.help).toMatch(/^Experimental/);
    expect(manifest.configSchema.properties.recallEarlyStart!.description).toMatch(/^Experimental/);
    const changelog = read("CHANGELOG.md");
    const notes = changelog.split("### Upgrade notes")[1]!.split("### Added")[0]!;
    expect(notes).toMatch(/`recallEarlyStart` \(default `false`, experimental\)/);
  });

  it("no doc says a failed early request counts whenever a turn takes it", () => {
    for (const file of ["docs/configuration.md", "openclaw.plugin.json", "CHANGELOG.md"]) {
      const text = read(file);
      expect({
        file,
        old: /counts? toward the (recall|circuit) breaker only when a turn takes it/i.test(text),
      }).toEqual({
        file,
        old: false,
      });
    }
    const docs = read("docs/configuration.md");
    expect(docs).toContain("An early request that timed out is not sent again");
  });

  it("the breaker docs say a tight-timeout agent alone never opens it, and the probe rule", () => {
    const docs = read("docs/configuration.md");
    expect(docs).toContain("If only such agents are active, the breaker does not open on a hang");
    expect(docs).toContain("frees the probe slot without a new cool-down");
  });

  it("the retain queue size-bound note names the queue --drop exception", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog).not.toContain("The file now stays within the bound.");
    expect(changelog).toMatch(/`queue --drop` tombstone .* past the bound by one line/);
  });
});
