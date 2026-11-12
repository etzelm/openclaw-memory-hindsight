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

const clientAnswering = (status: number, body: string) =>
  new HindsightClient({
    resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
    fetch: async () => new Response(body, { status }),
  });
const recallError = (status: number, body: string) =>
  clientAnswering(status, body)
    .recall("fresh", "q", { budget: "low" })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

describe("missing bank vs other 404s", () => {
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
    await expect(clientAnswering(404, body).getMemory("dev", "m9")).resolves.toBeNull();
  });
});

/** A response whose body stream fails mid-read (the request was aborted, or the socket died). */
function failingBodyResponse(status: number, failure: unknown) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"detail":'));
    },
    pull(controller) {
      controller.error(failure);
    },
  });
  return new Response(body, { status });
}

describe("error bodies", () => {
  it("does not read a 404 whose body read failed as a missing bank", async () => {
    const aborted = new DOMException("This operation was aborted", "AbortError");
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: async () => failingBodyResponse(404, aborted),
    });
    const error = await client.recall("fresh", "q", { budget: "low" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeDefined();
    expect(isBankNotFound(error)).toBe(false);
    // The abort stays visible as an abort.
    expect((error as { name?: unknown }).name).toBe("AbortError");
  });

  it("cancels the body of a non-404 error so the connection is released", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: async () => new Response(body, { status: 503 }),
    });
    await expect(client.recall("dev", "q", { budget: "low" })).rejects.toThrow(/HTTP 503/);
    expect(cancelled).toBe(true);
  });
});
