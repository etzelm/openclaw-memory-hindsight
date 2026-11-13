import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HindsightClient } from "./client.js";
import { hindsightConfigSchema } from "./config.js";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { createFakeHindsight, spyOnTimeouts } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;
type Result = { prependContext?: string } | undefined;

const RECALL_PATH = "/v1/default/banks/dev/memories/recall";
const OWNER = { kind: "owner-private" as const, agentId: "dev" };
const SESSION = "agent:dev:main";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** fetch double: each recall takes the next answer from `answers` ("hang" never answers). */
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
    registerMemoryCapability: vi.fn<AnyFn>(),
    registerTool: vi.fn<AnyFn>(),
    registerService: vi.fn<AnyFn>(),
  } as unknown as OpenClawPluginApi;
  memoryPlugin.register(api);
  const hook = (name: string) =>
    on.mock.calls.find(([hookName]) => hookName === name)?.[1] as AnyFn | undefined;
  const hookNames = () => on.mock.calls.map(([name]) => String(name));
  const recalls = () => requests.filter((r) => r.url.endsWith("/memories/recall"));
  const received = (text: string, runId: string, sessionKey = SESSION) =>
    hook("message_received")?.(
      { content: text, from: "user", sessionKey, runId },
      { channelId: "webchat", sessionKey, runId },
    ) as Promise<void> | undefined;
  const build = (text: string, runId: string, audience = OWNER, sessionKey = SESSION) =>
    hook("before_prompt_build")!(
      { prompt: text, currentUserMessage: text, messages: [] },
      { agentId: "dev", sessionKey, runId, memoryAudience: audience },
    ) as Promise<Result>;
  return { hookNames, recalls, received, build, api, entry };
}

const facts = (result: Result) =>
  (result?.prependContext ?? "").split("\n").filter((line) => line.startsWith("- "));

describe("recallEarlyStart (N6 b)", () => {
  it("is off by default and adds no message_received hook", () => {
    expect(hindsightConfigSchema.parse({ hindsightApiUrl: "https://h.example" })).toMatchObject({
      recallEarlyStart: false,
    });
    const { hookNames } = setup({}, []);
    expect(hookNames()).not.toContain("message_received");
  });

  it("starts the recall when the message arrives and uses it in before_prompt_build", async () => {
    const { received, build, recalls } = setup({ recallEarlyStart: true }, [
      ["first fact"],
      ["early fact"],
    ]);
    // The first turn of a session learns the route; nothing starts early yet.
    await received("where does hindsight run?", "r1");
    expect(recalls()).toHaveLength(0);
    expect(facts(await build("where does hindsight run?", "r1"))).toEqual(["- first fact [world]"]);
    await received("which port does it use?", "r2");
    expect(recalls()).toHaveLength(2);
    expect(facts(await build("which port does it use?", "r2"))).toEqual(["- early fact [world]"]);
    expect(recalls()).toHaveLength(2);
  });

  it("drops the early result when the query, the run or the bank differs, and recalls fresh", async () => {
    for (const change of ["query", "run", "bank"] as const) {
      const { received, build, recalls, entry } = setup({ recallEarlyStart: true }, [
        ["first fact"],
        ["early fact"],
        ["fresh fact"],
      ]);
      await build("where does hindsight run?", "r1");
      await received("which port does it use?", "r2");
      if (change === "bank") {
        // A live agentBankMap change moves the agent to another bank after the early start.
        entry.agentBankMap = { dev: "team" };
      }
      const query = change === "query" ? "something else entirely" : "which port does it use?";
      const result = await build(query, change === "run" ? "r9" : "r2");
      expect({ change, facts: facts(result) }).toEqual({ change, facts: ["- fresh fact [world]"] });
      expect({ change, recalls: recalls().length }).toEqual({ change, recalls: 3 });
      vi.unstubAllGlobals();
    }
  });

  it("drops the result of a skipped turn: the next turn never sees it", async () => {
    const { received, build, recalls } = setup({ recallEarlyStart: true }, [
      ["first fact"],
      ["early fact"],
      ["second early fact"],
    ]);
    await build("where does hindsight run?", "r1");
    await received("which port does it use?", "r2");
    // r2 never reaches before_prompt_build; r3 starts its own recall and gets its own result.
    await received("and the hostname?", "r3");
    expect(facts(await build("and the hostname?", "r3"))).toEqual(["- second early fact [world]"]);
    expect(recalls()).toHaveLength(3);
    // A later build for r2 finds nothing to reuse.
    await build("which port does it use?", "r2");
    expect(recalls()).toHaveLength(4);
  });

  it("starts nothing early when auto-recall is off for the agent", async () => {
    const { received, build, recalls } = setup(
      { recallEarlyStart: true, agents: { dev: { autoRecall: false } } },
      [],
    );
    await build("where does hindsight run?", "r1");
    await received("which port does it use?", "r2");
    expect(recalls()).toHaveLength(0);
  });
});

describe("recallStaleOnTimeout (N6 c)", () => {
  it("is off by default: a timeout injects nothing", async () => {
    expect(
      hindsightConfigSchema.parse({ hindsightApiUrl: "https://h.example" }).recallStaleOnTimeout,
    ).toBe(0);
    const timeouts = spyOnTimeouts();
    try {
      const { build } = setup({}, [["first fact"], "hang"]);
      expect(facts(await build("where does hindsight run?", "r1"))).toHaveLength(1);
      expect(await build("which port does it use?", "r2")).toBeUndefined();
    } finally {
      timeouts.restore();
    }
  });

  it("on a timeout injects the session's last block when it is younger than the key", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build, api } = setup({ recallStaleOnTimeout: 60_000 }, [["first fact"], "hang"]);
      expect(facts(await build("where does hindsight run?", "r1"))).toEqual([
        "- first fact [world]",
      ]);
      expect(facts(await build("which port does it use?", "r2"))).toEqual(["- first fact [world]"]);
      const debug = (api.logger.debug as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(debug.map(([m]) => m)).toContain("memory-hindsight: auto-recall source=stale");
    } finally {
      timeouts.restore();
    }
  });

  it("injects nothing when the last block is too old, from another bank, or the error is not a timeout", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const now = vi.spyOn(Date, "now");
      now.mockReturnValue(1_000_000);
      const old = setup({ recallStaleOnTimeout: 1_000 }, [["first fact"], "hang"]);
      await old.build("where does hindsight run?", "r1");
      now.mockReturnValue(1_002_000);
      expect(await old.build("which port does it use?", "r2")).toBeUndefined();
      now.mockRestore();
      vi.unstubAllGlobals();

      const other = setup({ recallStaleOnTimeout: 60_000 }, [["first fact"], "hang"]);
      await other.build("where does hindsight run?", "r1");
      const ops = { kind: "owner-private" as const, agentId: "ops" };
      expect(await other.build("which port does it use?", "r2", ops)).toBeUndefined();
      vi.unstubAllGlobals();
    } finally {
      timeouts.restore();
    }
    const failing = setup({ recallStaleOnTimeout: 60_000 }, [["first fact"]]);
    await failing.build("where does hindsight run?", "r1");
    vi.stubGlobal(
      "fetch",
      vi.fn<AnyFn>(async () => new Response("", { status: 500 })),
    );
    expect(await failing.build("which port does it use?", "r2")).toBeUndefined();
  });

  it("refuses a value outside 0 to 3600000", () => {
    for (const bad of [-1, 3_600_001, 1.5, "60000"]) {
      expect(() =>
        hindsightConfigSchema.parse({
          hindsightApiUrl: "https://h.example",
          recallStaleOnTimeout: bad,
        }),
      ).toThrow("recallStaleOnTimeout must be an integer from 0 to 3600000");
    }
  });
});

function clientWith() {
  const fake = createFakeHindsight({
    [`POST ${RECALL_PATH}`]: () => ({ json: { results: [] } }),
  });
  const client = new HindsightClient({
    resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
    fetch: fake.fetch,
  });
  return { client, fake };
}

describe("recallSkipEntities (N6 d)", () => {
  it("sends include.entities = null only when asked", async () => {
    const { client, fake } = clientWith();
    await client.recall("dev", "q", { budget: "mid" });
    await client.recall("dev", "q", { budget: "mid", skipEntities: true });
    expect(fake.requests[0]!.body).toEqual({ query: "q", budget: "mid" });
    expect(fake.requests[1]!.body).toEqual({
      query: "q",
      budget: "mid",
      include: { entities: null },
    });
  });

  it("is on by default for auto-recall, and recallSkipEntities: false sends no include", async () => {
    expect(
      hindsightConfigSchema.parse({ hindsightApiUrl: "https://h.example" }).recallSkipEntities,
    ).toBe(true);
    const on = setup({}, [["a"]]);
    await on.build("where does hindsight run?", "r1");
    expect(on.recalls()[0]!.body.include).toEqual({ entities: null });
    vi.unstubAllGlobals();
    const off = setup({ recallSkipEntities: false }, [["a"]]);
    await off.build("where does hindsight run?", "r1");
    expect(off.recalls()[0]!.body).not.toHaveProperty("include");
  });
});

/** Waits for timers (the 20 ms timeouts of spyOnTimeouts) and pending promises to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/** The hindsight_retain tool registered by the plugin, bound to one session. */
function retainTool(api: OpenClawPluginApi, sessionKey = SESSION) {
  const calls = (api.registerTool as unknown as { mock: { calls: [AnyFn, { name: string }][] } })
    .mock.calls;
  const factory = calls.find(([, opts]) => opts.name === "hindsight_retain")![0];
  return factory({
    agentId: "dev",
    sessionKey,
    memoryAudience: OWNER,
    assertMemoryAudienceCurrent: () => undefined,
  }) as { execute: AnyFn };
}

describe("recallEarlyStart: age bound, retain invalidation, fallback (0.9.0 review P2-1)", () => {
  it("does not use an early result older than recallTimeoutMs plus 5 s", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const { received, build, recalls } = setup({ recallEarlyStart: true }, [
      ["first fact"],
      ["early fact"],
      ["fresh fact"],
    ]);
    await build("where does hindsight run?", "r1");
    await received("which port does it use?", "r2");
    expect(recalls()).toHaveLength(2);
    // The message waited 30 minutes behind a long run before its turn built.
    now.mockReturnValue(1_000_000 + 30 * 60_000);
    expect(facts(await build("which port does it use?", "r2"))).toEqual(["- fresh fact [world]"]);
    expect(recalls()).toHaveLength(3);
  });

  it("still uses an early result inside the bound", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const { received, build, recalls } = setup({ recallEarlyStart: true }, [
      ["first fact"],
      ["early fact"],
    ]);
    await build("where does hindsight run?", "r1");
    await received("which port does it use?", "r2");
    now.mockReturnValue(1_000_000 + 14_000);
    expect(facts(await build("which port does it use?", "r2"))).toEqual(["- early fact [world]"]);
    expect(recalls()).toHaveLength(2);
  });

  it("drops the early result when hindsight_retain runs in the session", async () => {
    const { received, build, recalls, api } = setup({ recallEarlyStart: true }, [
      ["first fact"],
      ["early fact"],
      [],
      ["fresh fact"],
    ]);
    await build("where does hindsight run?", "r1");
    await received("which port does it use?", "r2");
    await retainTool(api).execute("c1", { content: "Hindsight moved to the NAS" });
    expect(facts(await build("which port does it use?", "r2"))).toEqual(["- fresh fact [world]"]);
    expect(recalls()).toHaveLength(3);
  });

  // 0.9.0 review N1: only a fast failure is retried; a timed-out early request is not.
  it("recalls again when the early request failed fast", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { received, build, recalls } = setup({ recallEarlyStart: true }, [
        ["first fact"],
        "5xx",
        ["fresh fact"],
      ]);
      await build("where does hindsight run?", "r1");
      await received("which port does it use?", "r2");
      await settle();
      expect(facts(await build("which port does it use?", "r2"))).toEqual(["- fresh fact [world]"]);
      expect(recalls()).toHaveLength(3);
    } finally {
      timeouts.restore();
    }
  });
});

describe("recallEarlyStart and the breaker (0.9.0 review P2-2)", () => {
  it("messages that never get a turn do not open the breaker", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { received, build, recalls } = setup({ recallEarlyStart: true }, [
        ["first fact"],
        "hang",
        "hang",
        "hang",
        ["real fact"],
      ]);
      await build("where does hindsight run?", "r1");
      // Group chatter the agent never answers: three early requests, all timing out.
      await received("did anyone see the game last night?", "g1");
      await received("what time is the standup tomorrow?", "g2");
      await received("who is bringing lunch on friday?", "g3");
      await settle();
      expect(recalls()).toHaveLength(4);
      // The next real turn still sends its request.
      expect(facts(await build("which port does hindsight use?", "r2"))).toEqual([
        "- real fact [world]",
      ]);
      expect(recalls()).toHaveLength(5);
    } finally {
      timeouts.restore();
    }
  });

  it("starts nothing early while the breaker is open, so a turn gets the probe", async () => {
    const timeouts = spyOnTimeouts();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    try {
      const { received, build, recalls } = setup({ recallEarlyStart: true }, [
        ["first fact"],
        "hang",
        "hang",
        "hang",
        ["probe fact"],
      ]);
      await build("where does hindsight run?", "r1");
      await build("which port does it use?", "r2");
      await build("and the hostname?", "r3");
      await build("and the bank id?", "r4");
      expect(recalls()).toHaveLength(4);
      // Past the cool-down: the next request is the probe.
      now.mockReturnValue(1_000_000 + 61_000);
      await received("what is the api version?", "r5");
      expect(recalls()).toHaveLength(4);
      expect(facts(await build("what is the api version?", "r5"))).toEqual([
        "- probe fact [world]",
      ]);
      expect(recalls()).toHaveLength(5);
    } finally {
      timeouts.restore();
    }
  });

  it("a taken early result that answered counts as an answer", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { received, build, recalls } = setup({ recallEarlyStart: true }, [
        ["first fact"],
        "hang",
        "hang",
        ["early fact"],
        "hang",
        ["after fact"],
      ]);
      await build("where does hindsight run?", "r1");
      await build("which port does it use?", "r2");
      await build("and the hostname?", "r3");
      await received("and the bank id?", "r4");
      expect(facts(await build("and the bank id?", "r4"))).toEqual(["- early fact [world]"]);
      // The early answer reset the failure count: one more timeout does not open the breaker.
      await build("and the api version?", "r5");
      expect(facts(await build("and the port again?", "r6"))).toEqual(["- after fact [world]"]);
      expect(recalls()).toHaveLength(6);
    } finally {
      timeouts.restore();
    }
  });
});

/** A hook the plugin registered, by name. */
function hookOf(api: OpenClawPluginApi, name: string): AnyFn {
  const calls = (api.on as unknown as { mock: { calls: [string, AnyFn][] } }).mock.calls;
  return calls.find(([hookName]) => hookName === name)![1];
}

/** A turn of another agent, in its own session and bank. */
const buildAs = (api: OpenClawPluginApi, agentId: string, text: string, runId: string) =>
  hookOf(api, "before_prompt_build")(
    { prompt: text, currentUserMessage: text, messages: [] },
    {
      agentId,
      sessionKey: `agent:${agentId}:main`,
      runId,
      memoryAudience: { kind: "owner-private" as const, agentId },
    },
  ) as Promise<Result>;

const debugLines = (api: OpenClawPluginApi) =>
  (api.logger.debug as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([m]) => m);

describe("recallStaleOnTimeout: filter, session end, breaker (0.9.0 review P2-4, P2-5)", () => {
  it("does not inject a block recalled under other request settings", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build, entry } = setup({ recallStaleOnTimeout: 60_000 }, [["first fact"], "hang"]);
      expect(facts(await build("where does hindsight run?", "r1"))).toHaveLength(1);
      // A live change of the score floor: the old block was recalled without it.
      entry.recallMinScore = 0.5;
      expect(await build("which port does it use?", "r2")).toBeUndefined();
    } finally {
      timeouts.restore();
    }
  });

  it("does not inject a block recalled under another tag filter (history pattern)", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build } = setup(
        {
          recallStaleOnTimeout: 60_000,
          recallTagGroups: [{ not: { tags: ["history"] } }],
          recallHistoryPattern: "\\bhistory\\b",
        },
        [["history fact"], "hang"],
      );
      // The history query recalls without the filter; the next query is filtered.
      expect(facts(await build("show me the history of the nas move", "r1"))).toHaveLength(1);
      expect(await build("which port does hindsight use?", "r2")).toBeUndefined();
    } finally {
      timeouts.restore();
    }
  });

  it("forgets the session's block, early recall and route at session_end", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build, received, recalls, api } = setup(
        { recallStaleOnTimeout: 60_000, recallEarlyStart: true },
        [["first fact"], "hang"],
      );
      await build("where does hindsight run?", "r1");
      await hookOf(api, "session_end")(
        { reason: "reset", sessionKey: SESSION },
        { sessionKey: SESSION },
      );
      // No route any more: nothing starts early.
      await received("which port does it use?", "r2");
      expect(recalls()).toHaveLength(1);
      // The new session's timeout gets nothing from the old one.
      expect(await build("which port does it use?", "r2")).toBeUndefined();
    } finally {
      timeouts.restore();
    }
  });

  it("forgets every session's block when the service stops", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build, api } = setup({ recallStaleOnTimeout: 60_000 }, [["first fact"], "hang"]);
      await build("where does hindsight run?", "r1");
      const services = (api.registerService as unknown as { mock: { calls: [AnyFn][] } }).mock
        .calls;
      const svc = services.map(([s]) => s as unknown as { start: AnyFn; stop: AnyFn }).at(-1)!;
      svc.stop();
      svc.start({});
      expect(await build("which port does it use?", "r2")).toBeUndefined();
    } finally {
      timeouts.restore();
    }
  });

  it("keeps injecting a young block while the breaker is open", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build, recalls, api } = setup({ recallStaleOnTimeout: 60_000 }, [
        ["first fact"],
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
        expect(facts(await build(q!, r!))).toEqual(["- first fact [world]"]);
      }
      // Three timeouts opened the breaker: no request, and still the stale block.
      expect(facts(await build("and the api version?", "r5"))).toEqual(["- first fact [world]"]);
      expect(recalls()).toHaveLength(4);
      expect(debugLines(api)).toContain("memory-hindsight: auto-recall skipped: breaker open");
    } finally {
      timeouts.restore();
    }
  });
});

describe("per-agent recallTimeoutMs and the breaker (0.9.0 review P2-6)", () => {
  it("timeouts under an agent timeout tighter than the global one do not pause other agents", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build, api, recalls } = setup({ agents: { dev: { recallTimeoutMs: 250 } } }, [
        "hang",
        "hang",
        "hang",
        ["main fact"],
      ]);
      await build("where does hindsight run?", "r1");
      await build("which port does it use?", "r2");
      await build("and the hostname?", "r3");
      expect(timeouts.requested).toEqual([250, 250, 250]);
      expect(facts(await buildAs(api, "main", "what is on the calendar today?", "m1"))).toEqual([
        "- main fact [world]",
      ]);
      expect(recalls()).toHaveLength(4);
    } finally {
      timeouts.restore();
    }
  });

  it("timeouts under the global timeout, or a looser agent one, still open the breaker", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { build, api, recalls } = setup({ agents: { dev: { recallTimeoutMs: 20_000 } } }, [
        "hang",
        "hang",
        "hang",
        ["main fact"],
      ]);
      await build("where does hindsight run?", "r1");
      await build("which port does it use?", "r2");
      await build("and the hostname?", "r3");
      expect(await buildAs(api, "main", "what is on the calendar today?", "m1")).toBeUndefined();
      expect(recalls()).toHaveLength(3);
    } finally {
      timeouts.restore();
    }
  });
});
