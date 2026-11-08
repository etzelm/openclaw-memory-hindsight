import { readFileSync } from "node:fs";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { HindsightClient, isExplicitPageMissingBody } from "./client.js";
import { type HindsightConfig, hindsightConfigSchema } from "./config.js";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { conversationBankId } from "./routing.js";
import { createHindsightService } from "./service.js";
import { createFakeHindsight, createTestService } from "./test-helpers.js";
import {
  createKnowledgePageTool,
  createKnowledgeSearchTool,
  createKnowledgeTreeTool,
  KNOWLEDGE_TOOL_NAMES,
} from "./tools.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

const BASE = {
  hindsightApiUrl: "http://hindsight.test",
  allowInsecureHttp: true,
  hindsightApiToken: "test-token",
};
const ON = { knowledgeReadTools: true };
const GROUP_SESSION = "agent:dev:telegram:group:-100";

const ownerCtx = (extra: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext => ({
  agentId: "dev",
  sessionKey: "agent:dev:main",
  memoryAudience: { kind: "owner-private", agentId: "dev" },
  ...extra,
});
const conversationCtx = (): OpenClawPluginToolContext => ({
  agentId: "dev",
  sessionKey: GROUP_SESSION,
  memoryAudience: {
    kind: "conversation",
    agentId: "dev",
    sessionKey: GROUP_SESSION,
    sessionId: "s1",
  },
});

const factories = [createKnowledgeTreeTool, createKnowledgeSearchTool, createKnowledgePageTool];
const paths = (requests: Array<{ url: string }>) => requests.map((r) => new URL(r.url).pathname);
const respond = (status: number, detail?: string) =>
  createTestService(
    async () => new Response(detail === undefined ? "" : JSON.stringify({ detail }), { status }),
    ON,
  ).service;

const TREE = {
  roots: [
    {
      id: "kf-1",
      kind: "folder",
      name: "Infra",
      children: [{ id: "kp-a", kind: "page", name: "Studio", is_stale: true, children: [] }],
    },
    { id: "kp-b", kind: "page", name: "Preferences", is_stale: false },
  ],
};

function harness(overrides: Record<string, unknown> = ON) {
  const fake = createFakeHindsight({
    "GET /v1/default/banks/dev/knowledge-base/tree": () => ({ json: TREE }),
    "GET /v1/default/banks/dev/knowledge-base/search": () => ({
      json: { results: [{ id: "kp-b", name: "Preferences", snippet: "Likes TS", score: 1 }] },
    }),
    // What Hindsight answers for another bank's page id (page ids are bank-scoped).
    [`GET /v1/default/banks/${encodeURIComponent(conversationBankId("dev", GROUP_SESSION))}/knowledge-base/pages/kp-b`]:
      () => ({ status: 404, json: { detail: "Knowledge page 'kp-b' not found" } }),
    "GET /v1/default/banks/dev/knowledge-base/pages/kp-b": () => ({
      json: { id: "kp-b", name: "Preferences", type: "knowledge-page", markdown: "# Prefs\nTS" },
    }),
  });
  return { fake, service: createTestService(fake.fetch, overrides).service };
}

describe("knowledgeReadTools config", () => {
  it("defaults to off and rejects a non-boolean", () => {
    expect(hindsightConfigSchema.parse(BASE).knowledgeReadTools).toBe(false);
    expect(hindsightConfigSchema.parse({ ...BASE, ...ON }).knowledgeReadTools).toBe(true);
    expect(() => hindsightConfigSchema.parse({ ...BASE, knowledgeReadTools: "yes" })).toThrow(
      "knowledgeReadTools must be a boolean",
    );
  });

  it("is declared in the manifest schema and tool contracts", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      contracts: { tools: string[] };
      configSchema: { properties: Record<string, { type?: string; default?: unknown }> };
    };
    expect(manifest.configSchema.properties.knowledgeReadTools).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(manifest.contracts.tools).toEqual(expect.arrayContaining([...KNOWLEDGE_TOOL_NAMES]));
  });
});

describe("knowledge tool availability", () => {
  it("withholds every knowledge tool while the key is off", () => {
    const { service } = harness({});
    for (const create of factories) {
      expect(create(service, ownerCtx())).toBeNull();
    }
  });

  it("follows the recall tools' session rules when on", () => {
    const { service } = harness();
    const context = harness({ ...ON, memoryMode: "context" }).service;
    for (const create of factories) {
      expect(create(service, ownerCtx())).not.toBeNull();
      expect(create(service, ownerCtx({ memoryAudience: undefined }))).toBeNull();
      expect(
        create(service, ownerCtx({ memoryAudience: { kind: "owner-private", agentId: "main" } })),
      ).toBeNull();
      expect(create(service, ownerCtx({ sessionKey: "agent:dev:cron:x:y" }))).toBeNull();
      expect(create(context, ownerCtx())).toBeNull();
    }
  });

  it("withholds the tools once the live key is turned off", () => {
    let config: HindsightConfig = hindsightConfigSchema.parse({ ...BASE, ...ON });
    const service = createHindsightService({
      config: () => config,
      logger: { warn: vi.fn<AnyFn>(), info: vi.fn<AnyFn>(), debug: vi.fn<AnyFn>() },
      fetch: createFakeHindsight().fetch,
    });
    expect(createKnowledgeTreeTool(service, ownerCtx())).not.toBeNull();
    config = hindsightConfigSchema.parse(BASE);
    expect(createKnowledgeTreeTool(service, ownerCtx())).toBeNull();
  });
});

describe("knowledge tool bank routing", () => {
  it("reads the owner bank for an owner-private audience", async () => {
    const { fake, service } = harness();
    await createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {});
    await createKnowledgeSearchTool(service, ownerCtx())!.execute("c", { query: "ts" });
    await createKnowledgePageTool(service, ownerCtx())!.execute("c", { page_id: "kp-b" });
    expect(paths(fake.requests)).toEqual([
      "/v1/default/banks/dev/knowledge-base/tree",
      "/v1/default/banks/dev/knowledge-base/search",
      "/v1/default/banks/dev/knowledge-base/pages/kp-b",
    ]);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("never reads the owner bank for a conversation audience", async () => {
    const { fake, service } = harness();
    const conv = encodeURIComponent(conversationBankId("dev", GROUP_SESSION));
    await createKnowledgeTreeTool(service, conversationCtx())!.execute("c", {});
    await createKnowledgeSearchTool(service, conversationCtx())!.execute("c", { query: "ts" });
    const page = await createKnowledgePageTool(service, conversationCtx())!.execute("c", {
      page_id: "kp-b",
    });
    expect(paths(fake.requests)).toEqual([
      `/v1/default/banks/${conv}/knowledge-base/tree`,
      `/v1/default/banks/${conv}/knowledge-base/search`,
      `/v1/default/banks/${conv}/knowledge-base/pages/kp-b`,
    ]);
    // The owner bank's page id does not resolve through the conversation bank.
    expect(JSON.stringify(page)).toContain("Knowledge page not found.");
  });

  it("honors agentBankMap for the owner bank", async () => {
    const fake = createFakeHindsight({
      "GET /v1/default/banks/wb/knowledge-base/tree": () => ({ json: { roots: [] } }),
    });
    const { service } = createTestService(fake.fetch, { ...ON, agentBankMap: { dev: "wb" } });
    await createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {});
    expect(paths(fake.requests)).toEqual(["/v1/default/banks/wb/knowledge-base/tree"]);
  });
});

describe("knowledge tool results", () => {
  it("renders the tree with page ids and stale marks as untrusted data", async () => {
    const { service } = harness();
    const result = JSON.stringify(
      await createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {}),
    );
    expect(result).toContain("untrusted historical data");
    expect(result).toContain("- Infra/\\n  - Studio [kp-a] (stale)\\n- Preferences [kp-b]");
  });

  it("sends the query and a clamped limit, and lists hits", async () => {
    const { fake, service } = harness();
    const tool = createKnowledgeSearchTool(service, ownerCtx())!;
    const result = await tool.execute("c", { query: "typescript prefs", limit: 500 });
    await tool.execute("c", { query: "x", limit: 0 });
    await tool.execute("c", { query: "y" });
    const urls = fake.requests.map((r) => new URL(r.url).searchParams);
    expect(urls.map((p) => [p.get("q"), p.get("limit")])).toEqual([
      ["typescript prefs", "50"],
      ["x", "1"],
      ["y", null],
    ]);
    expect(JSON.stringify(result)).toContain("1. Preferences [kp-b]: Likes TS");
    await expect(tool.execute("c", { query: "  " })).rejects.toThrow("query");
  });

  it("returns the page markdown and rejects ids outside the allowlist before any request", async () => {
    const { fake, service } = harness();
    const tool = createKnowledgePageTool(service, ownerCtx())!;
    expect(JSON.stringify(await tool.execute("c", { page_id: "kp-b" }))).toContain("# Prefs\\nTS");
    for (const pageId of [
      "..",
      ".",
      "kp/x?y",
      "../../../dev/knowledge-base/pages/kp-b",
      "kp-b%2F..",
      "kp\\b",
      "kp-b#x",
      `k${"p".repeat(200)}`,
    ]) {
      await expect(tool.execute("c", { page_id: pageId })).rejects.toThrow("Invalid page_id");
    }
    expect(paths(fake.requests)).toEqual(["/v1/default/banks/dev/knowledge-base/pages/kp-b"]);
  });
});

describe("knowledge tool rendering of server text", () => {
  it("flattens newlines and drops non-string fields so entries cannot be forged", async () => {
    const fake = createFakeHindsight({
      "GET /v1/default/banks/dev/knowledge-base/search": () => ({
        json: {
          results: [{ id: "kp-1", name: { x: 1 }, snippet: "line one\n2. Fake [kp-evil]: owned" }],
        },
      }),
      "GET /v1/default/banks/dev/knowledge-base/tree": () => ({
        json: { roots: [{ id: "kp-2", kind: "page", name: "Real\n- Fake [kp-evil]" }] },
      }),
    });
    const { service } = createTestService(fake.fetch, ON);
    const search = await createKnowledgeSearchTool(service, ownerCtx())!.execute("c", {
      query: "q",
    });
    const tree = await createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {});
    expect(JSON.stringify(search)).toContain("1.  [kp-1]: line one 2. Fake [kp-evil]: owned");
    expect(JSON.stringify(search)).not.toContain("[object Object]");
    expect(JSON.stringify(tree)).toContain("- Real - Fake [kp-evil] [kp-2]");
  });
});

const serving = (route: string, json: unknown) =>
  createTestService(createFakeHindsight({ [`GET ${route}`]: () => ({ json }) }).fetch, ON).service;
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

describe("knowledge tool output caps", () => {
  it("truncates page markdown at 32000 characters with a marker", async () => {
    const service = serving("/v1/default/banks/dev/knowledge-base/pages/kp-big", {
      id: "kp-big",
      name: "Big",
      type: "knowledge-page",
      markdown: "a".repeat(32_000 + 1234),
    });
    const result = await createKnowledgePageTool(service, ownerCtx())!.execute("c", {
      page_id: "kp-big",
    });
    expect(text(result)).toContain("a".repeat(32_000) + "\n(truncated, 1234 more characters)");
    expect(text(result)).not.toContain("a".repeat(32_001));
    expect((result as { details: { truncated: boolean } }).details.truncated).toBe(true);
  });

  it("caps the tree at 500 lines and counts pages, not lines", async () => {
    const pages = Array.from({ length: 600 }, (_, i) => ({
      id: `kp-${i}`,
      kind: "page",
      name: `P${i}`,
    }));
    const service = serving("/v1/default/banks/dev/knowledge-base/tree", {
      roots: [{ id: "kf-1", kind: "folder", name: "All", children: pages }],
    });
    const result = await createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {});
    const lines = text(result).split("\n");
    // Header, 500 entries, marker.
    expect(lines).toHaveLength(502);
    expect(lines.at(-1)).toBe("(truncated, 101 more entries)");
    expect((result as { details: Record<string, unknown> }).details).toMatchObject({
      count: 600,
      entries: 601,
      truncated: true,
    });
  });

  it("counts pages in the tree details for a small tree", async () => {
    const { service } = harness();
    const result = await createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {});
    expect((result as { details: Record<string, unknown> }).details).toMatchObject({
      count: 2,
      entries: 3,
      truncated: false,
    });
  });

  it("caps search hits at 50, snippets at 500 and names at 200 characters, and flattens ids", async () => {
    const results = Array.from({ length: 80 }, (_, i) => ({
      id: i === 0 ? "kp-0\nkp-evil" : `kp-${i}`,
      name: "n".repeat(300),
      snippet: "s".repeat(900),
      score: 1,
    }));
    const service = serving("/v1/default/banks/dev/knowledge-base/search", { results });
    const result = await createKnowledgeSearchTool(service, ownerCtx())!.execute("c", {
      query: "q",
    });
    const body = text(result);
    expect(body.split("\n")).toHaveLength(51);
    expect(body).toContain(`${"n".repeat(200)}... [`);
    expect(body).toContain(`]: ${"s".repeat(500)}...`);
    expect(body).not.toContain("s".repeat(501));
    const details = (result as { details: { count: number; ids: string[] } }).details;
    expect(details.count).toBe(50);
    expect(details.ids[0]).toBe("kp-0 kp-evil");
  });

  it("refuses a knowledge response body over 1 MiB without reading it all", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: async () => new Response(stream, { status: 200 }),
    });
    await expect(client.getKnowledgeBaseTree("dev")).rejects.toThrow(
      "Hindsight knowledge tree failed: response larger than 1048576 bytes",
    );
    expect(pulled).toBeLessThan(64);
  });

  it("refuses an oversized body announced by content-length before reading", async () => {
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: async () =>
        new Response("{}", { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } }),
    });
    await expect(client.getKnowledgePage("dev", "kp-1")).rejects.toThrow(
      "response larger than 1048576 bytes",
    );
  });
});

describe("knowledge tool 404 handling", () => {
  it("treats a missing bank as empty, like recall", async () => {
    const missing = respond(404, "Bank 'dev' not found");
    const empty = respond(404);
    for (const service of [missing, empty]) {
      expect(
        JSON.stringify(await createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {})),
      ).toContain("No knowledge pages yet.");
      expect(
        JSON.stringify(
          await createKnowledgeSearchTool(service, ownerCtx())!.execute("c", { query: "q" }),
        ),
      ).toContain("No knowledge pages yet.");
      expect(
        JSON.stringify(
          await createKnowledgePageTool(service, ownerCtx())!.execute("c", { page_id: "kp-x" }),
        ),
      ).toContain("Knowledge page not found.");
    }
  });

  it("reports a missing page as not found", async () => {
    const service = respond(404, "Knowledge page 'kp-x' not found");
    const result = await createKnowledgePageTool(service, ownerCtx())!.execute("c", {
      page_id: "kp-x",
    });
    expect(JSON.stringify(result)).toContain("Knowledge page not found.");
  });

  it("keeps a route 404 and other failures loud", async () => {
    for (const service of [respond(404, "Not Found"), respond(500, "boom")]) {
      await expect(createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {})).rejects.toThrow(
        "HTTP",
      );
      await expect(
        createKnowledgeSearchTool(service, ownerCtx())!.execute("c", { query: "q" }),
      ).rejects.toThrow("HTTP");
      await expect(
        createKnowledgePageTool(service, ownerCtx())!.execute("c", { page_id: "kp-x" }),
      ).rejects.toThrow("HTTP");
    }
  });

  it("reports a 200 page without markdown as an error, not as not found", async () => {
    const service = createTestService(
      async () => new Response(JSON.stringify({ id: "kp-x", name: "x" }), { status: 200 }),
      ON,
    ).service;
    await expect(
      createKnowledgePageTool(service, ownerCtx())!.execute("c", { page_id: "kp-x" }),
    ).rejects.toThrow("unexpected response");
  });

  it("classifies 404 bodies without copying them", async () => {
    expect(
      isExplicitPageMissingBody(JSON.stringify({ detail: "Knowledge page 'kp' not found" })),
    ).toBe(true);
    expect(isExplicitPageMissingBody(JSON.stringify({ detail: "Not Found" }))).toBe(false);
    expect(isExplicitPageMissingBody(JSON.stringify({ detail: "Memory unit 'm' not found" }))).toBe(
      false,
    );
    expect(isExplicitPageMissingBody("")).toBe(false);
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: async () => new Response(JSON.stringify({ detail: "secret body" }), { status: 404 }),
    });
    await expect(client.getKnowledgeBaseTree("dev")).rejects.toThrow(
      "Hindsight knowledge tree failed: HTTP 404",
    );
  });

  it("keeps an oversized 404 body loud instead of reading it as a missing bank", async () => {
    const service = createTestService(
      async () => new Response("x".repeat(70 * 1024), { status: 404 }),
      ON,
    ).service;
    await expect(createKnowledgeTreeTool(service, ownerCtx())!.execute("c", {})).rejects.toThrow(
      "HTTP 404",
    );
  });

  it("keeps a 404 for some other record loud on the page tool", async () => {
    const service = respond(404, "Memory unit 'kp-x' not found");
    await expect(
      createKnowledgePageTool(service, ownerCtx())!.execute("c", { page_id: "kp-x" }),
    ).rejects.toThrow("HTTP 404");
  });
});

function registeredTools(extra: Record<string, unknown>) {
  const pluginConfig = { ...BASE, ...extra };
  const registerTool = vi.fn<AnyFn>();
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
    on: vi.fn<AnyFn>(),
    registerMemoryCapability: vi.fn<AnyFn>(),
    registerTool,
    registerService: vi.fn<AnyFn>(),
  };
  // SAFETY: register() only uses the members above; the rest of the host API is never reached.
  memoryPlugin.register(api as unknown as OpenClawPluginApi);
  return registerTool.mock.calls.map(([factory, opts]) => ({
    name: String(opts.name),
    factory: factory as (ctx: OpenClawPluginToolContext) => { name: string } | null,
  }));
}

const registeredNames = (extra: Record<string, unknown>): string[] =>
  registeredTools(extra).map((tool) => tool.name);

describe("knowledge tool registration", () => {
  it("registers the knowledge tools only when enabled", () => {
    const base = ["hindsight_retain", "hindsight_recall", "hindsight_reflect"];
    expect(registeredNames({})).toEqual(base);
    expect(registeredNames(ON)).toEqual([...base, ...KNOWLEDGE_TOOL_NAMES]);
  });

  it("builds each registered tool for an audience session and withholds it without one", () => {
    for (const tool of registeredTools(ON)) {
      expect(tool.factory(ownerCtx())).toMatchObject({ name: tool.name });
      expect(tool.factory(ownerCtx({ memoryAudience: undefined }))).toBeNull();
    }
  });
});

const kbClient = (fetch: (url: string, init?: RequestInit) => Promise<Response>) =>
  new HindsightClient({ resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }), fetch });

const throwingCancel = (chunks: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunks; i += 1) {
        controller.enqueue(new Uint8Array(512 * 1024));
      }
    },
    cancel() {
      throw new Error("cancel failed");
    },
  });

describe("bounded body reader edges", () => {
  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ roots: [{ id: "kp-1", kind: "page", name: "caf\u00e9 \u{1F600}" }] }),
    );
    // Split inside the two-byte e-acute and inside the four-byte emoji.
    const cutA = bytes.indexOf(0xc3) + 1;
    const cutB = bytes.indexOf(0xf0) + 2;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cutA));
        controller.enqueue(bytes.slice(cutA, cutB));
        controller.enqueue(bytes.slice(cutB));
        controller.close();
      },
    });
    const roots = await kbClient(async () => new Response(stream)).getKnowledgeBaseTree("dev");
    expect(roots[0]?.name).toBe("caf\u00e9 \u{1F600}");
  });

  it("stops reading a 404 body after 64 KiB and keeps the error loud", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x78);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 40) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    await expect(
      kbClient(async () => new Response(stream, { status: 404 })).getKnowledgeBaseTree("dev"),
    ).rejects.toThrow("HTTP 404");
    // 64 KiB is 4 chunks; the fifth crosses the cap, and the stream may pull one ahead.
    expect(pulled).toBeLessThanOrEqual(7);
  });

  it("still fails as too large when cancelling the body throws", async () => {
    await expect(
      kbClient(async () => new Response(throwingCancel(3))).getKnowledgeBaseTree("dev"),
    ).rejects.toThrow("response larger than 1048576 bytes");
    await expect(
      kbClient(
        async () =>
          new Response(throwingCancel(1), {
            headers: { "content-length": String(4 * 1024 * 1024) },
          }),
      ).getKnowledgeBaseTree("dev"),
    ).rejects.toThrow("response larger than 1048576 bytes");
  });
});
