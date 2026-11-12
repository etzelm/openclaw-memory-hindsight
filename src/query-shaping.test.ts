import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hindsightConfigSchema, RECALL_MAX_QUERY_CHARS } from "./config.js";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { shapeRecallQuery, stripInternalContext } from "./query-shaping.js";
import { createFakeHindsight } from "./test-helpers.js";
import { extractRecallQuery, previousUserQuery } from "./transcript.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

const OWNER = { kind: "owner-private" as const, agentId: "dev" };

/** The envelope OpenClaw 2026.11 puts around a subagent task (shape from real transcripts). */
function subagentTask(body: string): string {
  return [
    "[Sat 2026-11-07 13:14 PST] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "",
    "[Subagent Context] You are running as a subagent (depth 1/5). Complete the current [Subagent Task]; inherited conversation is background context, not your assignment.",
    "",
    "## Current Run",
    "2. Finish: The final reply returns to the requester as a completion event.",
    "## Sub-Agent Spawning",
    "Follow each descendant's accepted completion mode; synthesize all required results before your final reply.",
    "## Session Context",
    "- Label: review R1",
    "- Requester session: agent:main:dashboard:69970e1c-3a42-49bb-9902-9d9278cce4b1.",
    "- Requester channel: webchat.",
    "- Your session: agent:dev:subagent:4adc754f-882b-4656-b48c-8bc5b7765329.",
    "",
    "[Subagent Task]",
    "",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    "",
    body,
    "",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "",
    "Begin. Execute the assigned task to completion.",
    "",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ].join("\n");
}

const BODY =
  "Review MR !2 on GitLab project claw/openclaw-memory-hindsight, branch fix/review-p2s -> develop.";

describe("stripInternalContext", () => {
  it("removes every internal-context block and keeps the task body", () => {
    const out = stripInternalContext(subagentTask(BODY));
    expect(out).toBe(BODY);
  });

  it("drops an unterminated block to the end of the text", () => {
    expect(
      stripInternalContext(`${BODY}\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n## Current Run`),
    ).toBe(BODY);
  });

  it("leaves an inter-session message (no block) unchanged", () => {
    const text =
      "[Inter-session message] sourceSession=agent:main:dashboard:x sourceChannel=webchat isUser=false\nMR !14 is merged.";
    expect(stripInternalContext(text)).toBe(text);
  });

  it("leaves text without a block unchanged", () => {
    const text = "  where does hindsight run?  ";
    expect(stripInternalContext(text)).toBe(text);
  });
});

describe("shapeRecallQuery", () => {
  const text = subagentTask(BODY);

  it("off is the plain cap (today's behavior)", () => {
    expect(shapeRecallQuery(text, "off", 800)).toBe(text.slice(0, 800));
  });

  it("strip sends the task, not the envelope", () => {
    expect(shapeRecallQuery(text, "strip", 800)).toBe(BODY);
  });

  it("strip caps a long task body", () => {
    const long = subagentTask("x".repeat(2000));
    expect(shapeRecallQuery(long, "strip", 800)).toBe("x".repeat(800));
  });
});

describe("extractRecallQuery with recallQueryShaping", () => {
  it("defaults to off: the envelope fills the query as before", () => {
    const q = extractRecallQuery(subagentTask(BODY), "");
    expect(q?.startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")).toBe(true);
    expect(q?.length).toBeLessThanOrEqual(RECALL_MAX_QUERY_CHARS);
  });

  it("strip returns the task body", () => {
    expect(extractRecallQuery(subagentTask(BODY), "", "strip")).toBe(BODY);
  });

  it("an envelope with no task body gives no query", () => {
    expect(extractRecallQuery(subagentTask(""), "", "strip")).toBeNull();
  });

  it("leaves short questions untouched in every mode", () => {
    for (const mode of ["off", "strip"] as const) {
      expect(extractRecallQuery("Which Airflow version does claw-jobs run?", "", mode)).toBe(
        "Which Airflow version does claw-jobs run?",
      );
    }
  });

  it("previousUserQuery shapes the earlier message the same way", () => {
    const messages = [
      { role: "user", content: subagentTask(BODY) },
      { role: "user", content: "go" },
    ];
    expect(previousUserQuery(messages, "go", "strip")).toBe(BODY);
  });
});

describe("recallQueryShaping config", () => {
  const base = { hindsightApiUrl: "http://hindsight.test", allowInsecureHttp: true };

  it("defaults to off", () => {
    expect(hindsightConfigSchema.parse(base).recallQueryShaping).toBe("off");
  });

  it("accepts off and strip", () => {
    for (const mode of ["off", "strip"]) {
      expect(
        hindsightConfigSchema.parse({ ...base, recallQueryShaping: mode }).recallQueryShaping,
      ).toBe(mode);
    }
  });

  it("rejects other values", () => {
    expect(() => hindsightConfigSchema.parse({ ...base, recallQueryShaping: "focus" })).toThrow(
      /recallQueryShaping must be one of: off, strip/,
    );
  });
});

function setup(extra: Record<string, unknown>) {
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
    ...extra,
  };
  const on = vi.fn<AnyFn>();
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
    runtime: { config: { current: () => ({}) } },
    on,
    registerMemoryCapability: vi.fn<AnyFn>(),
    registerTool: vi.fn<AnyFn>(),
    registerService: vi.fn<AnyFn>(),
  };
  // SAFETY: register() only uses the members above; the rest of the host API is never reached.
  memoryPlugin.register(api as unknown as OpenClawPluginApi);
  const hook = on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
  return { fake, hook };
}

describe("auto-recall with recallQueryShaping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ctx = { agentId: "dev", sessionKey: "agent:dev:main", memoryAudience: OWNER };
  const event = {
    prompt: subagentTask(BODY),
    currentUserMessage: subagentTask(BODY),
    messages: [],
  };

  it("sends the envelope when the key is unset", async () => {
    const { fake, hook } = setup({});
    await hook(event, ctx);
    const body = fake.requests[0]?.body as { query: string };
    expect(body.query.startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")).toBe(true);
  });

  it("sends the task body with recallQueryShaping strip", async () => {
    const { fake, hook } = setup({ recallQueryShaping: "strip" });
    await expect(hook(event, ctx)).resolves.toMatchObject({
      prependContext: expect.stringContaining("fact"),
    });
    expect(fake.requests[0]?.body).toMatchObject({ query: BODY });
  });
});
