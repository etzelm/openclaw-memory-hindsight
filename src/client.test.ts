import { describe, expect, it } from "vitest";
import { HindsightClient, isBankMissingBody, isBankNotFound } from "./client.js";
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

  it("refuses redirects on every request so a body cannot follow a 307/308 to plain http", async () => {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories/recall": () => ({ json: { results: [] } }),
      "GET /health": () => ({ json: {} }),
    });
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "https://hindsight.test" }),
      fetch: fake.fetch,
    });
    await client.recall("dev", "q", { budget: "low" });
    await client.healthy();
    expect(fake.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fake.fetch.mock.calls) {
      expect(init?.redirect).toBe("error");
    }
  });
});

describe("missing bank vs other 404s", () => {
  const client = (status: number, body: string) =>
    new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: async () => new Response(body, { status }),
    });
  const recallError = (status: number, body: string) =>
    client(status, body)
      .recall("fresh", "q", { budget: "low" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

  it("reads Hindsight's bank-not-found body as a missing bank", async () => {
    const error = await recallError(404, JSON.stringify({ detail: "Bank 'fresh' not found" }));
    expect(isBankNotFound(error)).toBe(true);
    // The body never reaches the message.
    expect(String(error)).toBe("HindsightHttpError: Hindsight recall failed: HTTP 404");
  });

  it("does not read an unknown route, an HTML page or a 500 as a missing bank", async () => {
    expect(isBankNotFound(await recallError(404, JSON.stringify({ detail: "Not Found" })))).toBe(
      false,
    );
    expect(isBankNotFound(await recallError(404, "<html>404</html>"))).toBe(false);
    expect(isBankNotFound(await recallError(500, ""))).toBe(false);
  });

  it("keeps an empty 404 body as a missing bank", () => {
    expect(isBankMissingBody("")).toBe(true);
  });

  it("returns null from getMemory for a missing memory unit", async () => {
    const body = JSON.stringify({ detail: "Memory unit 'm9' not found" });
    await expect(client(404, body).getMemory("dev", "m9")).resolves.toBeNull();
  });
});
