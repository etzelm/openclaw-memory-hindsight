import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { HindsightClient } from "./client.js";
import { createFakeHindsight, createTestService } from "./test-helpers.js";
import { createReflectTool } from "./tools.js";

const REFLECT = "POST /v1/default/banks/dev/reflect";

const ownerCtx = (): OpenClawPluginToolContext => ({
  agentId: "dev",
  sessionKey: "agent:dev:main",
  memoryAudience: { kind: "owner-private", agentId: "dev" },
});

function harness(overrides: Record<string, unknown> = {}) {
  const fake = createFakeHindsight({ [REFLECT]: () => ({ json: { text: "An answer." } }) });
  const { service } = createTestService(fake.fetch, overrides);
  const bodies = () => fake.requests.filter((r) => r.url.endsWith("/reflect")).map((r) => r.body);
  return { tool: createReflectTool(service, ownerCtx())!, bodies, fake };
}

describe("hindsight_reflect types (Q5 reflect half)", () => {
  it("offers an optional types parameter and no since or until", () => {
    const { tool } = harness();
    const params = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties).toSorted()).toEqual(["query", "types"]);
    expect(params.required).toEqual(["query"]);
  });

  it("keeps a query-only call byte-identical", async () => {
    for (const extra of [{}, { types: null }, { types: "" }, { types: "  " }]) {
      const { tool, fake } = harness({ recallTypes: ["world"] });
      await tool.execute("c", { query: "what do we know?", ...extra });
      const raw = fake.fetch.mock.calls[0]![1]!.body;
      expect({ extra, raw }).toEqual({
        extra,
        raw: JSON.stringify({ query: "what do we know?", budget: "mid" }),
      });
    }
  });

  it("maps types to Hindsight's fact_types, deduplicated", async () => {
    const { tool, bodies } = harness();
    await tool.execute("c", { query: "q", types: ["observation", "world", "observation"] });
    expect(bodies()[0]).toEqual({
      query: "q",
      budget: "mid",
      fact_types: ["observation", "world"],
    });
  });

  it("refuses an empty or unknown types list without a request", async () => {
    for (const types of [[], ["facts"], "world"]) {
      const { tool, bodies } = harness();
      await expect(tool.execute("c", { query: "q", types })).rejects.toThrow(
        "types must be a list of world, experience, observation",
      );
      expect(bodies()).toHaveLength(0);
    }
  });

  it("client: sends fact_types only when given", async () => {
    const fake = createFakeHindsight({ [REFLECT]: () => ({ json: { text: "x" } }) });
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: fake.fetch,
    });
    await client.reflect("dev", "q", { budget: "low" });
    await client.reflect("dev", "q", { budget: "low", types: ["experience"] });
    expect(fake.requests.map((r) => r.body)).toEqual([
      { query: "q", budget: "low" },
      { query: "q", budget: "low", fact_types: ["experience"] },
    ]);
  });
});
