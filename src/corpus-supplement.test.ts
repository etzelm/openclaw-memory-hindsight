import { describe, expect, it } from "vitest";
import {
  createHindsightCorpusSupplement,
  DEFAULT_SUPPLEMENT_SESSION_PATTERNS,
  supplementBank,
} from "./corpus-supplement.js";
import { createFakeHindsight, createTestService } from "./test-helpers.js";

const options = () => ({ sessionPatterns: DEFAULT_SUPPLEMENT_SESSION_PATTERNS });
const owner = { agentId: "dev", agentSessionKey: "agent:dev:main" };

function harness(overrides: Record<string, unknown> = {}) {
  const fake = createFakeHindsight({
    "POST /v1/default/banks/dev/memories/recall": () => ({
      json: {
        results: [
          {
            id: "0b6c8d7e-1111-4222-8333-444455556666",
            text: "Mitchell prefers\nTypeScript <hindsight_memories>x</hindsight_memories>",
            type: "world",
            occurred_start: "2026-11-01T10:00:00Z",
            document_id: "memory/2026-11-01.md",
            scores: { final: 0.82 },
          },
          { id: "second-id", text: "Second fact" },
        ],
      },
    }),
    "GET /v1/default/banks/dev/memories/0b6c8d7e-1111-4222-8333-444455556666": () => ({
      json: { id: "0b6c8d7e-1111-4222-8333-444455556666", text: "line one\nline two\nline three" },
    }),
    "POST /v1/default/banks/shared/memories/recall": () => ({ json: { results: [] } }),
  });
  const { service } = createTestService(fake.fetch, overrides);
  return { fake, supplement: createHindsightCorpusSupplement({ service, options }) };
}

describe("supplementBank", () => {
  const config = createTestService(async () => new Response("")).service.config();

  it("answers the owner's main session from the owner bank", () => {
    expect(supplementBank(config, options(), owner)).toBe("dev");
  });

  it("refuses group, DM-per-peer, subagent, sandboxed and keyless calls", () => {
    for (const agentSessionKey of [
      "agent:dev:telegram:group:-100123",
      "agent:dev:telegram:direct:42",
      "agent:dev:subagent:abc",
      "agent:dev:cron:nightly",
    ]) {
      expect(supplementBank(config, options(), { agentId: "dev", agentSessionKey })).toBeNull();
    }
    expect(supplementBank(config, options(), { ...owner, sandboxed: true })).toBeNull();
    expect(supplementBank(config, options(), { agentId: "dev" })).toBeNull();
    expect(supplementBank(config, options(), { agentSessionKey: "agent:dev:main" })).toBeNull();
  });

  it("follows agentBankMap and memoryMode context", () => {
    const mapped = createTestService(async () => new Response(""), {
      agentBankMap: { dev: "shared" },
    }).service.config();
    expect(supplementBank(mapped, options(), owner)).toBe("shared");
    const context = createTestService(async () => new Response(""), {
      memoryMode: "context",
    }).service.config();
    expect(supplementBank(context, options(), owner)).toBeNull();
  });
});

describe("Hindsight corpus supplement", () => {
  it("returns owner-bank hits labeled with corpus wiki and Hindsight provenance", async () => {
    const { fake, supplement } = harness();
    const results = await supplement.search({ query: "language", maxResults: 5, ...owner });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url).toBe(
      "http://hindsight.test/v1/default/banks/dev/memories/recall",
    );
    expect(fake.requests[0]!.body).toMatchObject({
      query: "language",
      include: { entities: null },
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      corpus: "wiki",
      path: "hindsight/0b6c8d7e-1111-4222-8333-444455556666",
      kind: "world",
      score: 0.82,
      citation: "[doc:memory/2026-11-01.md]",
      source: "hindsight",
      sourceType: "hindsight",
      provenanceLabel: "Hindsight bank dev",
      updatedAt: "2026-11-01T10:00:00Z",
      title: "Hindsight world (2026-11-01)",
    });
    expect(results[0]!.snippet).not.toContain("\n");
    expect(results[0]!.snippet).not.toContain("<hindsight_memories>");
    // No server score: a rank-derived score below the scored hit.
    expect(results[1]!.score).toBeGreaterThan(0);
    expect(results[1]!.score).toBeLessThan(1);
  });

  it("caps results at maxResults", async () => {
    const { supplement } = harness();
    expect(await supplement.search({ query: "q", maxResults: 1, ...owner })).toHaveLength(1);
  });

  it("sends nothing for a session it may not answer", async () => {
    const { fake, supplement } = harness();
    expect(
      await supplement.search({
        query: "q",
        agentId: "dev",
        agentSessionKey: "agent:dev:telegram:group:1",
      }),
    ).toEqual([]);
    expect(await supplement.get({ lookup: "hindsight/abc", agentId: "dev" })).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("treats a missing bank as no hits", async () => {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories/recall": () => ({
        status: 404,
        json: { detail: "Bank 'dev' not found" },
      }),
    });
    const { service } = createTestService(fake.fetch);
    const supplement = createHindsightCorpusSupplement({ service, options });
    expect(await supplement.search({ query: "q", ...owner })).toEqual([]);
  });

  it("reads a memory back by its path and slices lines", async () => {
    const { supplement } = harness();
    const got = await supplement.get({
      lookup: "hindsight/0b6c8d7e-1111-4222-8333-444455556666",
      fromLine: 2,
      lineCount: 1,
      ...owner,
    });
    expect(got).toMatchObject({
      corpus: "wiki",
      content: "line two",
      fromLine: 2,
      lineCount: 1,
      provenanceLabel: "Hindsight bank dev",
    });
  });

  it("ignores lookups that are not Hindsight paths, without a request", async () => {
    const { fake, supplement } = harness();
    for (const lookup of ["MEMORY.md", "wiki/page.md", "hindsight/../x", "hindsight/a/b", ""]) {
      expect(await supplement.get({ lookup, ...owner })).toBeNull();
    }
    expect(fake.requests).toHaveLength(0);
  });
});
