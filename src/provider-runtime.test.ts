import { describe, expect, it } from "vitest";
import { createHindsightProviderRuntime } from "./provider-runtime.js";
import type { MemoryPluginCapability } from "./sdk-types.js";
import {
  createFakeHindsight,
  createHangingFetch,
  createTestService,
  spyOnTimeouts,
} from "./test-helpers.js";

type OpenParams = Parameters<NonNullable<MemoryPluginCapability["providerRuntime"]>["open"]>[0];
type Authority = OpenParams["context"]["authority"];

const OPERATOR: Authority = { kind: "operator", scopes: ["operator.read"] };
const HOST = { kind: "host", operation: "status" } as unknown as Authority;
const owner = (agentId = "dev"): Authority => ({
  kind: "session",
  sessionKey: `agent:${agentId}:main`,
  sandboxed: false,
  audience: { kind: "owner-private", agentId },
});
const noAudience: Authority = { kind: "session", sessionKey: "agent:dev:x", sandboxed: false };

const RESULTS = [
  { id: "m1", text: "Studio hosts Hindsight", scores: { final: 0.9 } },
  { id: "m2", text: "Mini runs the gateway", scores: { final: 0.4 } },
  { id: "m3", text: "unscored" },
];

function harness() {
  const fake = createFakeHindsight({
    "POST /v1/default/banks/dev/memories/recall": () => ({ json: { results: RESULTS } }),
    "GET /v1/default/banks/dev/memories/m1": () => ({ json: { id: "m1", text: "line1\nline2" } }),
    "GET /health": () => ({ json: { status: "ok" } }),
  });
  const { service } = createTestService(fake.fetch);
  const runtime = createHindsightProviderRuntime({ providerId: "memory-hindsight", service });
  const open = async (authority: Authority, assertCurrent = () => {}) => {
    const result = await runtime.open({
      cfg: {},
      agentId: "dev",
      purpose: "default",
      context: { authority, assertCurrent },
    } as OpenParams);
    if (!result.provider) {
      throw new Error(result.error);
    }
    return result.provider;
  };
  return { fake, open };
}

describe("memory-hindsight provider runtime", () => {
  it("declares memory-only capabilities", async () => {
    const provider = await harness().open(OPERATOR);
    expect(provider.capabilities).toEqual({
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
    });
  });

  it.each([OPERATOR, owner()])("searches the owner bank for $kind", async (authority) => {
    const { fake, open } = harness();
    const provider = await open(authority);
    const result = await provider.search({ query: "where is hindsight", maxResults: 2 });
    expect(result.hits.map((h) => h.reference.id)).toEqual(["m1", "m2"]);
    expect(result.hits[0]).toMatchObject({
      reference: { providerId: "memory-hindsight", id: "m1" },
      excerpt: "Studio hosts Hindsight",
      score: 0.9,
      source: "memory",
    });
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      url: "http://hindsight.test/v1/default/banks/dev/memories/recall",
      auth: "Bearer test-token",
    });
  });

  it("honors minScore, dropping unscored hits, and forwards it as the final floor", async () => {
    const { fake, open } = harness();
    const provider = await open(OPERATOR);
    const result = await provider.search({ query: "hindsight", minScore: 0.5 });
    expect(result.hits.map((h) => h.reference.id)).toEqual(["m1"]);
    const body = fake.requests[0]?.body as { min_scores?: unknown } | undefined;
    expect(body?.min_scores).toEqual({ final: 0.5 });
  });

  it("returns no rows with a warning for host callers and sessions without an audience", async () => {
    for (const authority of [HOST, noAudience, owner("main")]) {
      const { fake, open } = harness();
      const provider = await open(authority);
      const result = await provider.search({ query: "hindsight" });
      expect(result.hits).toEqual([]);
      expect(result.warning).toMatch(/not searched/);
      expect(fake.requests).toEqual([]);
      await expect(
        provider.get({ reference: { providerId: "memory-hindsight", id: "m1" } }),
      ).rejects.toThrow(/access denied/);
    }
  });

  it("gets a memory with line bounds and reports not_found for foreign or revisioned refs", async () => {
    const { open } = harness();
    const provider = await open(OPERATOR);
    await expect(
      provider.get({ reference: { providerId: "memory-hindsight", id: "m1" }, from: 2, lines: 1 }),
    ).resolves.toMatchObject({ status: "ok", text: "line2", from: 2, lines: 1, truncated: false });
    await expect(
      provider.get({ reference: { providerId: "memory-lancedb", id: "m1" } }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      provider.get({ reference: { providerId: "memory-hindsight", id: "m1", revision: "r1" } }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      provider.get({ reference: { providerId: "memory-hindsight", id: "missing" } }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("answers health for every caller without content", async () => {
    const { open } = harness();
    const provider = await open(HOST);
    const health = await provider.health();
    expect(health.status).toBe("ready");
    expect(JSON.stringify(health)).not.toMatch(/token|hindsight\.test/);
  });

  it("refuses to read after the caller goes stale", async () => {
    const { fake, open } = harness();
    let current = true;
    const provider = await open(OPERATOR, () => {
      if (!current) {
        throw new Error("stale caller");
      }
    });
    current = false;
    await expect(provider.search({ query: "hindsight" })).rejects.toThrow(/stale caller/);
    expect(fake.requests).toEqual([]);
  });
});

describe("memory-hindsight provider runtime get timeout", () => {
  it("aborts a hung get after 10 s and keeps the host signal precedence", async () => {
    const timeouts = spyOnTimeouts();
    try {
      const { service } = createTestService(createHangingFetch());
      const runtime = createHindsightProviderRuntime({ providerId: "memory-hindsight", service });
      const open = async (signal?: AbortSignal) => {
        const result = await runtime.open({
          cfg: {},
          agentId: "dev",
          purpose: "default",
          context: { authority: OPERATOR, assertCurrent: () => {}, ...(signal ? { signal } : {}) },
        } as OpenParams);
        return result.provider!;
      };
      const reference = { providerId: "memory-hindsight", id: "m1" };
      await expect((await open()).get({ reference })).rejects.toBeDefined();
      expect(timeouts.requested).toEqual([10_000]);
      const host = new AbortController();
      const pending = (await open(host.signal)).get({ reference });
      host.abort(new Error("host cancelled"));
      await expect(pending).rejects.toThrow("host cancelled");
    } finally {
      timeouts.restore();
    }
  });
});

describe("memory-hindsight provider runtime on a bank that does not exist yet", () => {
  const openWith = async (detail: string) => {
    const { service } = createTestService(
      async () => new Response(JSON.stringify({ detail }), { status: 404 }),
    );
    const runtime = createHindsightProviderRuntime({ providerId: "memory-hindsight", service });
    const result = await runtime.open({
      cfg: {},
      agentId: "dev",
      purpose: "default",
      context: { authority: OPERATOR, assertCurrent: () => {} },
    } as OpenParams);
    return result.provider!;
  };

  it("returns no hits for Hindsight's bank-not-found 404", async () => {
    const provider = await openWith("Bank 'dev' not found");
    await expect(provider.search({ query: "hindsight" })).resolves.toEqual({
      hits: [],
      coverage: "complete",
    });
  });

  it("fails the search for a 404 from a route that does not exist", async () => {
    const provider = await openWith("Not Found");
    await expect(provider.search({ query: "hindsight" })).rejects.toThrow(
      "memory-hindsight: memory search failed: Hindsight recall failed: HTTP 404",
    );
  });
});
