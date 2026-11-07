import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { hindsightConfigSchema } from "./config.js";
import {
  createLearnContribution,
  createLegacyLearnFields,
  createProviderFlushPlanResolver,
  LEARN_TOOL_NAMES,
  RECALL_TOOL_NAMES,
} from "./memory-capability.js";
import {
  createFakeHindsight,
  createHangingFetch,
  createTestService,
  spyOnTimeouts,
} from "./test-helpers.js";
import {
  createFlushDeduper,
  createRecallTool,
  createReflectTool,
  createRetainTool,
  flushDocumentId,
} from "./tools.js";

const ownerCtx = (extra: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext => ({
  agentId: "dev",
  sessionKey: "agent:dev:main",
  memoryAudience: { kind: "owner-private", agentId: "dev" },
  ...extra,
});

function harness(overrides: Record<string, unknown> = {}) {
  const fake = createFakeHindsight({
    "PUT /v1/default/banks/dev": () => ({ json: {} }),
    "POST /v1/default/banks/dev/memories": () => ({ json: { success: true } }),
    "POST /v1/default/banks/dev/memories/recall": () => ({
      json: { results: [{ id: "m1", text: "Mitchell prefers TypeScript" }] },
    }),
    "POST /v1/default/banks/dev/reflect": () => ({
      json: { text: "He prefers TypeScript." },
    }),
  });
  const { service } = createTestService(fake.fetch, {
    retainMission: "Keep durable facts.",
    ...overrides,
  });
  return { fake, service, deduper: createFlushDeduper() };
}

describe("hindsight tools", () => {
  it("retains to the audience bank after applying the bank mission once", async () => {
    const { fake, service, deduper } = harness();
    const tool = createRetainTool(service, deduper, ownerCtx())!;
    await tool.execute("c1", {
      content: "Use pnpm",
      tags: ["tooling"],
      occurred_at: "2026-11-01",
    });
    await tool.execute("c2", { content: "Use vitest" });
    expect(fake.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "PUT /v1/default/banks/dev",
      "POST /v1/default/banks/dev/memories",
      "POST /v1/default/banks/dev/memories",
    ]);
    expect(fake.requests[0]?.body).toEqual({
      retain_mission: "Keep durable facts.",
    });
    expect(fake.requests[1]?.body).toMatchObject({
      async: true,
      items: [
        {
          content: "Use pnpm",
          tags: ["tooling"],
          timestamp: "2026-11-01",
          metadata: {
            source: "openclaw",
            session_key: "agent:dev:main",
            agent_id: "dev",
          },
        },
      ],
    });
  });

  it("is withheld without an audience, in context mode, incognito or excluded sessions", () => {
    const { service, deduper } = harness();
    expect(createRetainTool(service, deduper, ownerCtx({ memoryAudience: undefined }))).toBeNull();
    expect(createRecallTool(service, ownerCtx({ sessionKey: "agent:dev:cron:x:y" }))).toBeNull();
    expect(
      createRecallTool(
        service,
        ownerCtx({
          memoryAudience: { kind: "owner-private", agentId: "main" },
        }),
      ),
    ).toBeNull();
    const context = harness({ memoryMode: "context" });
    expect(createRecallTool(context.service, ownerCtx())).toBeNull();
  });

  it("recalls and reflects on the audience bank", async () => {
    const { fake, service } = harness({
      recallTypes: ["observation"],
      recallBudget: "high",
    });
    const recall = await createRecallTool(service, ownerCtx())!.execute("c", {
      query: "language",
    });
    expect(JSON.stringify(recall)).toContain("1. Mitchell prefers TypeScript");
    expect(fake.requests[0]?.body).toMatchObject({
      query: "language",
      budget: "high",
      types: ["observation"],
    });
    const reflect = await createReflectTool(service, ownerCtx())!.execute("c", {
      query: "language",
    });
    expect(JSON.stringify(reflect)).toContain("He prefers TypeScript.");
  });

  it("treats an unwritten bank as empty", async () => {
    const fake = createFakeHindsight({});
    const { service } = createTestService(fake.fetch);
    const result = await createRecallTool(service, ownerCtx())!.execute("c", {
      query: "x y z",
    });
    expect(JSON.stringify(result)).toContain("No relevant memories found.");
  });

  it("dedupes retries within one flush and uses a stable document id", async () => {
    const { fake, service, deduper } = harness();
    const ctx = ownerCtx({ memoryFlush: { flushId: "flush-1" } });
    const tool = createRetainTool(service, deduper, ctx)!;
    await tool.execute("c1", { content: "Decision: ship native plugin" });
    const second = await tool.execute("c2", {
      content: "Decision: ship native plugin",
    });
    expect(JSON.stringify(second)).toContain("already queued");
    const retains = fake.requests.filter((r) => r.url.endsWith("/memories"));
    expect(retains).toHaveLength(1);
    expect(retains[0]?.body).toMatchObject({
      items: [
        {
          document_id: flushDocumentId("flush-1", "Decision: ship native plugin"),
          update_mode: "replace",
          metadata: { retention_scope: "pre_compaction_flush" },
        },
      ],
    });
    // Another flush cycle stores the same content again.
    const next = createRetainTool(
      service,
      deduper,
      ownerCtx({ memoryFlush: { flushId: "flush-2" } }),
    )!;
    await next.execute("c3", { content: "Decision: ship native plugin" });
    expect(fake.requests.filter((r) => r.url.endsWith("/memories"))).toHaveLength(2);
  });

  it("releases a flush claim when the write fails so a retry can persist", async () => {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories": () => ({ status: 503 }),
    });
    const { service } = createTestService(fake.fetch);
    const deduper = createFlushDeduper();
    const tool = createRetainTool(service, deduper, ownerCtx({ memoryFlush: { flushId: "f" } }))!;
    await expect(tool.execute("c1", { content: "x fact" })).rejects.toThrow(/HTTP 503/);
    await expect(tool.execute("c2", { content: "x fact" })).rejects.toThrow(/HTTP 503/);
  });

  it("checks audience currency before writing", async () => {
    const { fake, service, deduper } = harness();
    const assertMemoryAudienceCurrent = vi.fn<() => void>(() => {
      throw new Error("memory audience is no longer current");
    });
    const tool = createRetainTool(service, deduper, ownerCtx({ assertMemoryAudienceCurrent }))!;
    await expect(tool.execute("c", { content: "x fact" })).rejects.toThrow(/no longer current/);
    expect(fake.requests).toEqual([]);
  });
});

describe("memory capability fields", () => {
  it("declares recall and learn tools", () => {
    expect(RECALL_TOOL_NAMES).toEqual(["hindsight_recall", "hindsight_reflect"]);
    expect(LEARN_TOOL_NAMES).toEqual(["hindsight_retain"]);
  });

  it("returns a tools-arm flush plan unless mode is context", () => {
    let config = hindsightConfigSchema.parse({
      hindsightApiUrl: "http://h",
      allowInsecureHttp: true,
    });
    const resolve = createProviderFlushPlanResolver(() => config);
    const plan = resolve({});
    expect(plan).toMatchObject({
      persistenceToolNames: ["hindsight_retain"],
      lookupToolNames: ["hindsight_recall"],
    });
    expect(plan && "relativePath" in plan).toBe(false);
    config = hindsightConfigSchema.parse({
      hindsightApiUrl: "http://h",
      allowInsecureHttp: true,
      memoryMode: "context",
    });
    expect(resolve({})).toBeNull();
  });

  it("builds legacy learn guidance only when retain is allowed", () => {
    const { learnToolNames, learnGuidanceBuilder: build } = createLegacyLearnFields();
    expect(learnToolNames).toEqual(["hindsight_retain"]);
    expect(build({ availableTools: new Set() })).toEqual([]);
    expect(build({ availableTools: new Set(["hindsight_retain"]) })).toHaveLength(2);
    expect(
      build({
        availableTools: new Set(["hindsight_retain", "hindsight_recall"]),
      }),
    ).toHaveLength(3);
  });

  it("builds a memory learn contribution for the generic /learn seam", () => {
    const contribution = createLearnContribution();
    expect(contribution.medium).toBe("memory");
    expect(contribution.toolNames).toEqual(["hindsight_retain"]);
    expect(contribution.requiredToolNames).toEqual(["hindsight_retain"]);
    const media = new Set(["memory" as const]);
    expect(contribution.buildGuidance({ availableTools: new Set(), media }).lines).toEqual([]);
    expect(
      contribution.buildGuidance({
        availableTools: new Set(["hindsight_retain", "hindsight_recall"]),
        media,
      }).lines,
    ).toHaveLength(3);
  });
});

describe("hindsight tool timeouts", () => {
  it("aborts a hung retain and reflect after the fixed timeout without a host signal", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { service, deduper } = {
        service: createTestService(createHangingFetch()).service,
        deduper: createFlushDeduper(),
      };
      const retain = createRetainTool(service, deduper, ownerCtx())!;
      await expect(retain.execute("c1", { content: "x" })).rejects.toBeDefined();
      const reflect = createReflectTool(service, ownerCtx())!;
      await expect(reflect.execute("c2", { query: "q" })).rejects.toBeDefined();
      expect(timeouts.requested).toEqual(expect.arrayContaining([30_000]));
      expect(timeouts.requested.every((ms) => ms === 30_000)).toBe(true);
    } finally {
      timeouts.restore();
    }
  });

  it("lets the host signal win over the timeout", async () => {
    const { service, deduper } = {
      service: createTestService(createHangingFetch()).service,
      deduper: createFlushDeduper(),
    };
    const host = new AbortController();
    const retain = createRetainTool(service, deduper, ownerCtx())!;
    const pending = retain.execute("c1", { content: "x" }, host.signal);
    host.abort(new Error("host cancelled"));
    await expect(pending).rejects.toThrow("host cancelled");
  });
});
