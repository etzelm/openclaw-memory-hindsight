import { describe, expect, it } from "vitest";
import { HindsightClient } from "./client.js";
import { createFakeHindsight } from "./test-helpers.js";

describe("HindsightClient bank urls", () => {
  it("encodes a bank id exactly once", async () => {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/team%2Fshared/memories/recall": () => ({ json: { results: [] } }),
    });
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: fake.fetch,
    });
    await client.recall("team/shared", "q", { budget: "low" });
    expect(fake.requests[0]?.url).toBe(
      "http://hindsight.test/v1/default/banks/team%2Fshared/memories/recall",
    );
  });

  it("leaves a-z0-9_- bank ids unchanged in the url", async () => {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/researcher/reflect": () => ({ json: { text: "x" } }),
    });
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: fake.fetch,
    });
    await client.reflect("researcher", "q", { budget: "low" });
    expect(fake.requests[0]?.url).toBe("http://hindsight.test/v1/default/banks/researcher/reflect");
  });
});
