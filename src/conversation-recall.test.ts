import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot, StoredSession } from "./conversation-recall-policy.js";
import {
  CONVERSATION_RECALL_TOOL,
  conversationRecallCapabilityFields,
  createConversationRecallTool,
  createSessionStoreAccess,
  queryTerms,
  textWindow,
  type SessionStoreAccess,
} from "./conversation-recall.js";
import { runDocumentId } from "./document-ids.js";
import { createFakeHindsight, createTestService } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

const ANCHOR = "agent:dev:telegram:direct:42";
const PRIOR = "agent:dev:dashboard:prior";
const GROUP = "agent:dev:telegram:group:-100";
const SANDBOXED = "agent:dev:dashboard:sandboxed";
const FORGOTTEN = "agent:dev:dashboard:forgotten";
const RESET = "agent:dev:dashboard:reset";
const REQUESTER = `${ANCHOR}:active-memory:0123456789ab`;
const OWNER = { kind: "owner-private" as const, agentId: "dev" };

const row = (sessionKey: string, sessionId: string, chatTypes = ["direct"]): StoredSession => ({
  sessionKey,
  sessionId,
  chatTypes,
});
const BASE_ROWS = [
  row(ANCHOR, "s-anchor"),
  row(PRIOR, "s-prior"),
  row(GROUP, "s-group", ["group"]),
  row(SANDBOXED, "s-sandboxed"),
  row(FORGOTTEN, "s-forgotten"),
  row(RESET, "s-reset-now"),
];

function storeOf(...snapshots: StoredSession[][]): SessionStoreAccess & { calls: number } {
  const access = {
    calls: 0,
    async snapshot(): Promise<SessionSnapshot> {
      const rows = snapshots[Math.min(access.calls, snapshots.length - 1)]!;
      access.calls += 1;
      return new Map(rows.map((r) => [r.sessionKey, r]));
    },
    resolveAgentId: (key: string) => /^agent:([^:]+):/.exec(key)?.[1],
  };
  return access;
}

function meta(key: string, sessionId: string, extra: Record<string, string> = {}) {
  return {
    source: "openclaw",
    retention_scope: "turn",
    audience: "owner-private",
    agent_id: "dev",
    session_key: key,
    session_id: sessionId,
    sandboxed: "false",
    ...extra,
  };
}

/** Each document: its id, stored metadata (null: deleted) and its chunk text. */
const DOCS: Array<{ id: string; metadata: Record<string, string> | null; text: string }> = [
  { id: runDocumentId(PRIOR, "r1"), metadata: meta(PRIOR, "s-prior"), text: "PRIOR-PRIVATE" },
  { id: runDocumentId(GROUP, "r1"), metadata: meta(GROUP, "s-group"), text: "GROUP-LEAK" },
  {
    id: runDocumentId(SANDBOXED, "r1"),
    metadata: meta(SANDBOXED, "s-sandboxed", { sandboxed: "true" }),
    text: "SANDBOX-LEAK",
  },
  // Forgotten with `openclaw hindsight forget`: the document is gone from the bank.
  { id: runDocumentId(FORGOTTEN, "r1"), metadata: null, text: "FORGOTTEN-LEAK" },
  // A run from before /reset: its transcript id is not the session's current one.
  { id: runDocumentId(RESET, "r1"), metadata: meta(RESET, "s-reset-old"), text: "PRE-RESET-LEAK" },
  { id: runDocumentId(ANCHOR, "r0"), metadata: meta(ANCHOR, "s-anchor"), text: "ANCHOR-SELF" },
];

function harness(opts: { recallResults?: unknown[]; chunks?: Record<string, unknown> } = {}) {
  const routes: Record<string, (body: unknown) => { status?: number; json?: unknown }> = {
    "POST /v1/default/banks/dev/memories/recall": () => ({
      json: {
        results:
          opts.recallResults ??
          DOCS.map((d, i) => ({
            id: `f${i}`,
            text: `FACT-TEXT-${i}`,
            type: "world",
            document_id: d.id,
            chunk_id: `dev_${d.id}_0`,
          })),
        chunks:
          opts.chunks ??
          Object.fromEntries(
            DOCS.map((d) => [`dev_${d.id}_0`, { id: `dev_${d.id}_0`, text: d.text }]),
          ),
      },
    }),
  };
  for (const d of DOCS) {
    routes[`GET /v1/default/banks/dev/documents/${encodeURIComponent(d.id)}`] = () =>
      d.metadata
        ? { json: { id: d.id, document_metadata: d.metadata } }
        : { status: 404, json: { detail: "Document not found" } };
  }
  const fake = createFakeHindsight(routes);
  const { service } = createTestService(fake.fetch, { privateTranscriptRecall: true });
  return { fake, service };
}

const ctx = (extra: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext => ({
  agentId: "dev",
  sessionKey: REQUESTER,
  memoryAudience: OWNER,
  sandboxed: false,
  conversationRecall: { anchorSessionKey: ANCHOR, scope: "same-agent-private", corpus: "sessions" },
  ...extra,
});

async function run(
  service: ReturnType<typeof harness>["service"],
  store: SessionStoreAccess,
  c: OpenClawPluginToolContext,
  params: unknown = { query: "what did we decide" },
) {
  const tool = createConversationRecallTool(service, c, store)!;
  const result = (await tool.execute("c1", params as never, undefined as never)) as {
    content: Array<{ text: string }>;
    details: { count: number; reason?: string };
  };
  return { text: result.content[0]!.text, details: result.details };
}

describe("hindsight_conversation_recall", () => {
  it("returns only the prior private run's raw chunk, never fact text (R1)", async () => {
    const { service } = harness();
    const { text, details } = await run(service, storeOf(BASE_ROWS), ctx());
    expect(details.count).toBe(1);
    expect(text).toContain("PRIOR-PRIVATE");
    expect(text).not.toMatch(/FACT-TEXT/);
    expect(text).toContain("untrusted historical data");
  });

  it("leaks nothing from a group chat, a sandboxed run, a pre-reset run, a forgotten session or the anchor", async () => {
    const { service } = harness();
    const { text } = await run(service, storeOf(BASE_ROWS), ctx());
    for (const leak of [
      "GROUP-LEAK",
      "SANDBOX-LEAK",
      "PRE-RESET-LEAK",
      "FORGOTTEN-LEAK",
      "ANCHOR-SELF",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it("asks Hindsight for ranking facts and chunks only, never observations", async () => {
    const { fake, service } = harness();
    await run(service, storeOf(BASE_ROWS), ctx());
    const recall = fake.requests.find((r) => r.url.endsWith("/memories/recall"))!;
    expect(recall.body).toMatchObject({
      types: ["world", "experience"],
      include: { entities: null, chunks: {} },
    });
  });

  it("drops observation hits and chunks whose id does not belong to the document (R10)", async () => {
    const prior = runDocumentId(PRIOR, "r1");
    const { service } = harness({
      recallResults: [
        { id: "o", text: "x", type: "observation", document_id: prior, chunk_id: `dev_${prior}_0` },
        { id: "f", text: "x", type: "world", document_id: prior, chunk_id: `dev_${DOCS[1]!.id}_0` },
      ],
    });
    const { details } = await run(service, storeOf(BASE_ROWS), ctx());
    expect(details.count).toBe(0);
  });

  it.each([
    ["no grant (older host or ordinary turn)", { conversationRecall: undefined }],
    [
      "bad scope",
      { conversationRecall: { anchorSessionKey: ANCHOR, scope: "x", corpus: "sessions" } as never },
    ],
    ["sandboxed requester (R3)", { sandboxed: true }],
    ["untrusted requester (R6)", { sessionKey: "agent:dev:main" }],
    ["no requester key (R2)", { sessionKey: undefined }],
    ["other agent (R7)", { agentId: "main", memoryAudience: { ...OWNER, agentId: "main" } }],
    [
      "group or other-sender audience",
      {
        memoryAudience: {
          kind: "conversation" as const,
          agentId: "dev",
          sessionKey: GROUP,
          sessionId: "s-group",
        },
      },
    ],
    ["no audience", { memoryAudience: undefined }],
  ])("returns nothing and calls no Hindsight route: %s (R19)", async (_label, extra) => {
    const { fake, service } = harness();
    const { details } = await run(service, storeOf(BASE_ROWS), ctx(extra as never));
    expect(details.count).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  it("ignores a grant passed as a model parameter (R4)", async () => {
    const { fake, service } = harness();
    const { details } = await run(
      service,
      storeOf(BASE_ROWS),
      ctx({ conversationRecall: undefined }),
      {
        query: "x",
        conversationRecall: {
          anchorSessionKey: ANCHOR,
          scope: "same-agent-private",
          corpus: "sessions",
        },
      },
    );
    expect(details.count).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  it("refuses when the anchor is not private (R8) or shares its transcript with a group (R9)", async () => {
    const { service } = harness();
    const groupAnchor = BASE_ROWS.map((r) =>
      r.sessionKey === ANCHOR ? row(ANCHOR, "s-anchor", ["group"]) : r,
    );
    expect((await run(service, storeOf(groupAnchor), ctx())).details.count).toBe(0);
    const aliased = [...BASE_ROWS, row("agent:dev:telegram:group:-7", "s-anchor", ["group"])];
    expect((await run(service, storeOf(aliased), ctx())).details.count).toBe(0);
  });

  it("judges eligibility on a fresh snapshot taken after Hindsight answers (R20)", async () => {
    const { service } = harness();
    const later = BASE_ROWS.filter((r) => r.sessionKey !== PRIOR);
    const store = storeOf(BASE_ROWS, later);
    const { details } = await run(service, store, ctx());
    expect(details.count).toBe(0);
    expect(store.calls).toBe(2);
  });

  it("drops the result when the anchor turned shared while Hindsight answered", async () => {
    const { service } = harness();
    const later = [...BASE_ROWS, row("agent:dev:telegram:group:-7", "s-anchor", ["group"])];
    expect((await run(service, storeOf(BASE_ROWS, later), ctx())).details.count).toBe(0);
  });

  it("keeps a corpus=configured grant to transcript chunks too (R1)", async () => {
    const { service } = harness();
    const { text } = await run(
      service,
      storeOf(BASE_ROWS),
      ctx({
        conversationRecall: {
          anchorSessionKey: ANCHOR,
          scope: "same-agent-private",
          corpus: "configured",
        },
      }),
    );
    expect(text).toContain("PRIOR-PRIVATE");
    expect(text).not.toMatch(/FACT-TEXT/);
  });

  it("is absent when the key is off", () => {
    const fake = createFakeHindsight();
    const { service } = createTestService(fake.fetch, {});
    expect(createConversationRecallTool(service, ctx(), storeOf(BASE_ROWS))).toBeNull();
  });

  it("answers nothing when the bank does not exist yet", async () => {
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories/recall": () => ({
        status: 404,
        json: { detail: "Bank 'dev' not found" },
      }),
    });
    const { service } = createTestService(fake.fetch, { privateTranscriptRecall: true });
    expect((await run(service, storeOf(BASE_ROWS), ctx())).details.count).toBe(0);
  });
});

describe("feature detection (R22)", () => {
  it("declares the capability only when enabled and the host has the session readers", () => {
    expect(conversationRecallCapabilityFields({ enabled: true, storeAvailable: true })).toEqual({
      deterministicRecallToolName: CONVERSATION_RECALL_TOOL,
      supportsPrivateTranscriptRecall: true,
    });
    expect(conversationRecallCapabilityFields({ enabled: false, storeAvailable: true })).toEqual(
      {},
    );
    expect(conversationRecallCapabilityFields({ enabled: true, storeAvailable: false })).toEqual(
      {},
    );
  });

  it("returns no store access on a host without the public readers", () => {
    expect(createSessionStoreAccess(() => ({}), { store: {}, scope: {} })).toBeUndefined();
    expect(
      createSessionStoreAccess(() => ({}), {
        store: {
          listSessionEntriesAsync: vi.fn<AnyFn>(),
          resolveStorePath: vi.fn<AnyFn>(),
          sessionDeliveryOrigin: vi.fn<AnyFn>(),
        },
        scope: {},
      }),
    ).toBeUndefined();
  });

  it("reads chat types from the entry and its delivery origin, under the configured store", async () => {
    const list = vi.fn<
      (params: {
        agentId: string;
        storePath?: string;
      }) => Promise<Array<{ sessionKey: string; entry: Record<string, unknown> }>>
    >(async () => [
      { sessionKey: ANCHOR, entry: { sessionId: "s-anchor", chatType: "direct" } },
      {
        sessionKey: PRIOR,
        entry: { sessionId: "s-prior", delivery: { origin: { chatType: "group" } } },
      },
    ]);
    const access = createSessionStoreAccess(() => ({ session: { store: "/x/{agentId}.db" } }), {
      store: {
        listSessionEntriesAsync: list,
        resolveStorePath: (store?: string, opts?: { agentId?: string }) =>
          `${store}|${opts?.agentId}`,
        sessionDeliveryOrigin: ((entry: { delivery?: { origin?: unknown } }) =>
          entry.delivery?.origin) as never,
      },
      scope: { resolveSessionAgentIdStrict: ({ sessionKey }) => sessionKey!.split(":")[1]! },
    })!;
    const snapshot = await access.snapshot("dev");
    expect(list).toHaveBeenCalledWith({ agentId: "dev", storePath: "/x/{agentId}.db|dev" });
    expect(snapshot.get(ANCHOR)?.chatTypes).toEqual(["direct"]);
    expect(snapshot.get(PRIOR)?.chatTypes).toEqual(["group"]);
    expect(access.resolveAgentId(PRIOR)).toBe("dev");
  });

  it("finds the public readers on the supported host floor", () => {
    expect(createSessionStoreAccess(() => ({}))).toBeDefined();
  });
});

// Hindsight dedups a fact that repeats an existing one, so these runs have no fact of their own.
function lexicalHarness(
  chunkFor: (id: string, text: string) => unknown[] = (id, text) => [
    { chunk_id: `dev_${id}_0`, document_id: id, chunk_text: "unrelated opening" },
    { chunk_id: `dev_${id}_1`, document_id: id, chunk_text: text },
  ],
) {
  const routes: Record<string, (body: unknown) => { status?: number; json?: unknown }> = {
    "POST /v1/default/banks/dev/memories/recall": () => ({ json: { results: [], chunks: {} } }),
    "GET /v1/default/banks/dev/documents": () => ({
      json: {
        items: [
          { id: "workboard/x", document_metadata: {} },
          ...DOCS.filter((d) => d.metadata).map((d) => ({
            id: d.id,
            document_metadata: d.metadata,
          })),
        ],
      },
    }),
  };
  for (const d of DOCS) {
    routes[`GET /v1/default/banks/dev/documents/${encodeURIComponent(d.id)}/chunks`] = () => ({
      json: { items: chunkFor(d.id, `lighthouse codeword ${d.text}`) },
    });
  }
  const fake = createFakeHindsight(routes);
  const { service } = createTestService(fake.fetch, { privateTranscriptRecall: true });
  return { fake, service };
}

describe("hindsight_conversation_recall document text search", () => {
  it("finds a private run that has no fact of its own, and only that run", async () => {
    const { fake, service } = lexicalHarness();
    const { text, details } = await run(service, storeOf(BASE_ROWS), ctx(), {
      query: "what was the lighthouse codeword",
    });
    expect(details.count).toBe(1);
    expect(text).toContain("PRIOR-PRIVATE");
    for (const leak of ["GROUP-LEAK", "SANDBOX-LEAK", "PRE-RESET-LEAK", "ANCHOR-SELF"]) {
      expect(text).not.toContain(leak);
    }
    expect(text).not.toContain("unrelated opening");
    const searched = fake.requests
      .filter((r) => new URL(r.url).pathname === "/v1/default/banks/dev/documents")
      .map((r) => new URL(r.url).searchParams.get("q"));
    expect(searched.toSorted()).toEqual(["codeword", "lighthouse"]);
    // Chunks are read only for the eligible run.
    const chunkReads = fake.requests.filter((r) => r.url.includes("/chunks"));
    expect(chunkReads).toHaveLength(1);
    expect(chunkReads[0]!.url).toContain(encodeURIComponent(DOCS[0]!.id));
  });

  it("drops a chunk that claims another document", async () => {
    const { service } = lexicalHarness((id, text) => [
      { chunk_id: `dev_${DOCS[1]!.id}_0`, document_id: id, chunk_text: text },
      { chunk_id: `dev_${id}_0`, document_id: DOCS[1]!.id, chunk_text: text },
    ]);
    const { details } = await run(service, storeOf(BASE_ROWS), ctx(), {
      query: "lighthouse codeword",
    });
    expect(details.count).toBe(0);
  });

  it("keeps the content words of the query", () => {
    expect(queryTerms("What did we decide about the Lighthouse codeword, and when?")).toEqual([
      "lighthouse",
      "codeword",
      "decide",
    ]);
    expect(queryTerms("is it ok?")).toEqual([]);
  });

  it("excerpts the stored text of a run that has no chunks, and of that run only", async () => {
    const routes: Record<string, (body: unknown) => { status?: number; json?: unknown }> = {
      "POST /v1/default/banks/dev/memories/recall": () => ({ json: { results: [], chunks: {} } }),
      "GET /v1/default/banks/dev/documents": () => ({
        json: {
          items: DOCS.filter((d) => d.metadata).map((d) => ({
            id: d.id,
            document_metadata: d.metadata,
          })),
        },
      }),
    };
    for (const d of DOCS) {
      const path = `/v1/default/banks/dev/documents/${encodeURIComponent(d.id)}`;
      routes[`GET ${path}/chunks`] = () => ({ json: { items: [] } });
      routes[`GET ${path}`] = () => ({
        json: {
          id: d.id,
          document_metadata: d.metadata,
          original_text: `${"x".repeat(5000)} lighthouse codeword ${d.text}`,
        },
      });
    }
    const fake = createFakeHindsight(routes);
    const { service } = createTestService(fake.fetch, { privateTranscriptRecall: true });
    const { text, details } = await run(service, storeOf(BASE_ROWS), ctx(), {
      query: "lighthouse codeword",
    });
    expect(details.count).toBe(1);
    expect(text).toContain("PRIOR-PRIVATE");
    for (const leak of ["GROUP-LEAK", "SANDBOX-LEAK", "PRE-RESET-LEAK", "ANCHOR-SELF"]) {
      expect(text).not.toContain(leak);
    }
    // Only the eligible run's text is read.
    const textReads = fake.requests.filter(
      (r) => r.method === "GET" && /\/documents\/[^/]+$/.test(new URL(r.url).pathname),
    );
    expect(textReads).toHaveLength(1);
  });

  it("refuses stored text that the server returns under another id", async () => {
    const prior = DOCS[0]!;
    const fake = createFakeHindsight({
      "POST /v1/default/banks/dev/memories/recall": () => ({ json: { results: [], chunks: {} } }),
      "GET /v1/default/banks/dev/documents": () => ({
        json: { items: [{ id: prior.id, document_metadata: prior.metadata }] },
      }),
      [`GET /v1/default/banks/dev/documents/${encodeURIComponent(prior.id)}`]: () => ({
        json: { id: DOCS[1]!.id, original_text: "lighthouse codeword GROUP-LEAK" },
      }),
    });
    const { service } = createTestService(fake.fetch, { privateTranscriptRecall: true });
    const { details } = await run(service, storeOf(BASE_ROWS), ctx(), {
      query: "lighthouse codeword",
    });
    expect(details.count).toBe(0);
  });

  it("windows the stored text around the first query term", () => {
    const body = `${"a".repeat(3000)}lighthouse${"b".repeat(6000)}`;
    const window = textWindow(body, ["lighthouse"])!;
    expect(window).toContain("lighthouse");
    expect(window.length).toBe(4000);
    expect(textWindow("nothing here", ["lighthouse"])).toBeUndefined();
  });
});
