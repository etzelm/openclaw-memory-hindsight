import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_OVERRIDE_KEYS,
  CONFIG_KEYS,
  configForAgent,
  type HindsightConfig,
  hindsightConfigSchema,
} from "./config.js";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { createFakeHindsight, spyOnTimeouts } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;
type JsonSchema = Record<string, unknown> & { properties?: Record<string, JsonSchema> };

const base = { hindsightApiUrl: "https://hindsight.example" };
const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: JsonSchema; uiHints: Record<string, unknown> };
const topLevel = manifest.configSchema.properties!;
const agentSchema = (topLevel.agents as { additionalProperties: JsonSchema }).additionalProperties;

const parse = (extra: Record<string, unknown>): HindsightConfig =>
  hindsightConfigSchema.parse({ ...base, ...extra });

/** A schema without its prose, to compare the shape of a key at two places. */
function bare(schema: JsonSchema): Record<string, unknown> {
  const { description: _d, default: _f, ...rest } = schema;
  return rest;
}

/** True when the parser accepts `value` for one key of an agents entry. */
function accepts(key: string, value: unknown): boolean {
  try {
    parse({ agents: { ops: { [key]: value } } });
    return true;
  } catch {
    return false;
  }
}

describe("agents map: parsing (N7)", () => {
  it("defaults to an empty map, and accepts an empty map", () => {
    expect(Object.keys(parse({}).agents)).toEqual([]);
    expect(Object.keys(parse({ agents: {} }).agents)).toEqual([]);
  });

  it("keeps every per-agent key, keyed by the normalized agent id", () => {
    const cfg = parse({
      agents: {
        "WB Dev": {
          autoRecall: false,
          recallTimeoutMs: 2_000,
          recallTopK: 3,
          recallMinScore: 0.25,
          recallQueryShaping: "strip",
          recallTypes: ["world", " observation ", "world"],
        },
      },
    });
    expect({ ...cfg.agents["wb-dev"] }).toEqual({
      autoRecall: false,
      recallTimeoutMs: 2_000,
      recallTopK: 3,
      recallMinScore: 0.25,
      recallQueryShaping: "strip",
      recallTypes: ["world", "observation"],
    });
  });

  it("refuses a bad value with the agent and key in the message", () => {
    expect(() => parse({ agents: { ops: { recallTopK: 0 } } })).toThrow(
      'agents["ops"].recallTopK must be an integer from 1 to 50',
    );
    expect(() => parse({ agents: { ops: { recallTimeoutMs: 100 } } })).toThrow(
      'agents["ops"].recallTimeoutMs must be an integer from 250 to 30000',
    );
    expect(() => parse({ agents: { ops: { recallTypes: ["facts"] } } })).toThrow(
      'agents["ops"].recallTypes entries must be: world, experience, observation',
    );
    expect(() => parse({ agents: { ops: { autoRecall: "no" } } })).toThrow(
      'agents["ops"].autoRecall must be a boolean',
    );
  });

  it("refuses keys outside the override list, bank selection included", () => {
    for (const key of ["agentBankMap", "recallBudget", "hindsightApiUrl", "bank", "nope"]) {
      expect(() => parse({ agents: { ops: { [key]: "x" } } })).toThrow(
        `agents["ops"] has unknown keys: ${key}`,
      );
    }
  });

  it("refuses a non-object map or entry, a bad agent id and two keys for one agent", () => {
    expect(() => parse({ agents: [] })).toThrow("agents must be an object of agent id to");
    expect(() => parse({ agents: { ops: true } })).toThrow('agents["ops"] must be an object');
    expect(() => parse({ agents: { "!!!": {} } })).toThrow(
      'agents key "!!!" is not a valid agent id',
    );
    expect(() => parse({ agents: { "WB Dev": {}, "wb-dev": {} } })).toThrow(
      'agents has more than one key for agent "wb-dev"',
    );
  });

  it("keeps prototype names as plain agent ids", () => {
    const cfg = parse({ agents: { constructor: { recallTopK: 2 } } });
    expect(configForAgent(cfg, "constructor").recallTopK).toBe(2);
    expect(configForAgent(cfg, "toString")).toBe(cfg);
  });
});

describe("configForAgent (N7)", () => {
  it("returns the config itself for an empty map, an unknown agent or no agent id", () => {
    for (const cfg of [
      parse({}),
      parse({ agents: {} }),
      parse({ agents: { ops: { recallTopK: 1 } } }),
    ]) {
      expect(configForAgent(cfg, "dev")).toBe(cfg);
      expect(configForAgent(cfg, undefined)).toBe(cfg);
    }
  });

  it("overlays only the agent's keys and matches the agent id like agentBankMap does", () => {
    const cfg = parse({
      recallTopK: 9,
      recallTimeoutMs: 5_000,
      agents: { "WB Dev": { recallTopK: 2 } },
    });
    const merged = configForAgent(cfg, "wb-dev");
    expect(merged.recallTopK).toBe(2);
    expect(merged.recallTimeoutMs).toBe(5_000);
    expect(configForAgent(cfg, "WB Dev").recallTopK).toBe(2);
  });
});

describe("one schema source: manifest and parser agree (N7)", () => {
  it("declares exactly the parser's keys at the top level", () => {
    expect(Object.keys(topLevel).toSorted()).toEqual([...CONFIG_KEYS].toSorted());
  });

  it("declares exactly the override keys per agent, each as the top-level schema", () => {
    expect(agentSchema.additionalProperties).toBe(false);
    expect(Object.keys(agentSchema.properties!).toSorted()).toEqual(
      [...AGENT_OVERRIDE_KEYS].toSorted(),
    );
    for (const key of AGENT_OVERRIDE_KEYS) {
      expect({ key, ...bare(agentSchema.properties![key]!) }).toEqual({
        key,
        ...bare(topLevel[key]!),
      });
    }
  });

  it("accepts and refuses the same per-agent values as the manifest bounds", () => {
    const cases: [string, unknown, boolean][] = [];
    const agrees = (key: string, value: unknown, ok: boolean) => cases.push([key, value, ok]);
    for (const key of AGENT_OVERRIDE_KEYS) {
      const schema = agentSchema.properties![key]!;
      const items = schema.items as JsonSchema | undefined;
      if (schema.type === "integer" || schema.type === "number") {
        const min = schema.minimum as number;
        const max = schema.maximum as number;
        agrees(key, min, true);
        agrees(key, max, true);
        agrees(key, max + 1, false);
        agrees(key, min - 1, false);
        agrees(key, "1", false);
        if (schema.type === "integer") {
          agrees(key, min + 0.5, false);
        }
      } else if (schema.type === "boolean") {
        agrees(key, true, true);
        agrees(key, false, true);
        agrees(key, "true", false);
      } else if (schema.type === "string") {
        for (const value of schema.enum as string[]) {
          agrees(key, value, true);
        }
        agrees(key, "bogus", false);
      } else if (schema.type === "array") {
        agrees(key, items!.enum, true);
        agrees(key, ["bogus"], false);
        agrees(key, "world", false);
      } else {
        throw new Error(`no agreement check for ${key}`);
      }
    }
    const results = cases.map(([key, value]) => [key, value, accepts(key, value)]);
    expect(results).toEqual(cases);
  });

  it("has a uiHint for the agents map", () => {
    expect(manifest.uiHints.agents).toBeDefined();
  });
});

describe("agents map: auto-recall (N7)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const TEN = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    text: `fact number ${i}`,
    type: "world",
  }));

  function setup(extra: Record<string, unknown>) {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories/recall": () => ({ json: { results: TEN } }),
    });
    vi.stubGlobal("fetch", fake.fetch);
    const entry = {
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
    const run = on.mock.calls.find(([name]) => name === "before_prompt_build")![1] as AnyFn;
    const text =
      "where does hindsight run? <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>x<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const ask = () =>
      run(
        { prompt: text, currentUserMessage: text, messages: [] },
        {
          agentId: "dev",
          sessionKey: "agent:dev:main",
          memoryAudience: { kind: "owner-private", agentId: "dev" },
        },
      ) as Promise<{ prependContext?: string } | undefined>;
    const bodies = () =>
      fake.requests.filter((r) => r.url.endsWith("/memories/recall")).map((r) => r.body);
    return { ask, bodies };
  }

  async function observe(extra: Record<string, unknown>) {
    const timeouts = spyOnTimeouts();
    try {
      const { ask, bodies } = setup(extra);
      const result = await ask();
      // The block's "Current time" line is the only part that may differ between two runs.
      const prependContext = result?.prependContext?.replace(/^Current time - .*$/m, "<now>");
      return { prependContext, bodies: bodies(), timeouts: [...timeouts.requested] };
    } finally {
      timeouts.restore();
      vi.unstubAllGlobals();
    }
  }

  it("behaves exactly as without the key for an empty map or an unknown agent", async () => {
    const globals = {
      recallTopK: 4,
      recallTimeoutMs: 3_000,
      recallMinScore: 0.1,
      recallTypes: ["world"],
      recallQueryShaping: "strip",
    };
    const without = await observe(globals);
    expect(without.bodies).toHaveLength(1);
    expect(await observe({ ...globals, agents: {} })).toEqual(without);
    expect(
      await observe({
        ...globals,
        agents: {
          ops: {
            autoRecall: false,
            recallTimeoutMs: 250,
            recallTopK: 1,
            recallMinScore: 0.9,
            recallQueryShaping: "off",
            recallTypes: ["experience"],
          },
        },
      }),
    ).toEqual(without);
  });

  it("applies the agent's own keys on its turns", async () => {
    const seen = await observe({
      recallTopK: 9,
      agents: {
        dev: {
          recallTimeoutMs: 2_000,
          recallTopK: 2,
          recallMinScore: 0.5,
          recallTypes: ["observation"],
          recallQueryShaping: "strip",
        },
      },
    });
    const body = seen.bodies[0] as Record<string, unknown>;
    expect(body.types).toEqual(["observation"]);
    expect(body.min_scores).toEqual({ final: 0.5 });
    expect(body.query).toBe("where does hindsight run?");
    expect(seen.timeouts).toContain(2_000);
    const lines = (seen.prependContext ?? "").split("\n").filter((l) => l.startsWith("- fact"));
    expect(lines).toHaveLength(2);
  });

  it("turns auto-recall off for one agent with autoRecall: false", async () => {
    const seen = await observe({ agents: { dev: { autoRecall: false } } });
    expect(seen.prependContext).toBeUndefined();
    expect(seen.bodies).toHaveLength(0);
  });

  it("turns auto-recall on for one agent when the global key is off", async () => {
    const seen = await observe({ autoRecall: false, agents: { dev: { autoRecall: true } } });
    expect(seen.bodies).toHaveLength(1);
  });
});
