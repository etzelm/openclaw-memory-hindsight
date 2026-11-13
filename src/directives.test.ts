import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdminCommands,
  type AdminIo,
  formatDirective,
  registerAdminCommands,
} from "./cli-admin.js";
import { HindsightClient, type HindsightDirective, toDirective } from "./client.js";
import { hindsightConfigSchema } from "./config.js";
import {
  createDirectiveCache,
  directiveLines,
  MAX_DIRECTIVE_CHARS,
  MAX_PROMPT_DIRECTIVES,
  promptDirectives,
} from "./directives.js";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { createFakeHindsight } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

afterEach(() => {
  vi.unstubAllGlobals();
});

const D = (over: Partial<HindsightDirective> & { id: string }): HindsightDirective => ({
  name: over.id,
  content: `rule ${over.id}`,
  priority: 0,
  isActive: true,
  tags: [],
  ...over,
});

const raw = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  bank_id: "dev",
  name: `n-${id}`,
  content: `c-${id}`,
  priority: 0,
  is_active: true,
  tags: [],
  ...extra,
});

function clientFor(routes: Parameters<typeof createFakeHindsight>[0]) {
  const fake = createFakeHindsight(routes);
  const client = new HindsightClient({
    resolveEndpoint: () => ({ apiUrl: "http://hindsight.test", apiToken: "t" }),
    fetch: fake.fetch,
  });
  return { client, fake };
}

describe("directive client", () => {
  it("lists every page with active_only and skips malformed items", async () => {
    const first = Array.from({ length: 100 }, (_, i) => raw(`d${i}`));
    const { client, fake } = clientFor({
      "GET /v1/default/banks/dev/directives": () => ({ json: { items: [] } }),
    });
    fake.fetch.mockImplementation(async (url: string) => {
      const offset = new URL(url).searchParams.get("offset");
      const items = offset === "0" ? first : [raw("last"), { id: 7 }, null];
      return new Response(JSON.stringify({ items, total: 101, limit: 100, offset: 0 }));
    });
    const list = await client.listDirectives("dev", { activeOnly: true });
    expect(list).toHaveLength(101);
    expect(list.at(-1)).toEqual({
      id: "last",
      name: "n-last",
      content: "c-last",
      priority: 0,
      isActive: true,
      tags: [],
    });
    const urls = fake.fetch.mock.calls.map(([u]) => new URL(u));
    expect(urls.map((u) => u.searchParams.get("offset"))).toEqual(["0", "100"]);
    expect(urls.every((u) => u.searchParams.get("active_only") === "true")).toBe(true);
  });

  it("returns [] for a bank that does not exist and throws on other errors", async () => {
    const { client } = clientFor({
      "GET /v1/default/banks/new/directives": () => ({
        status: 404,
        json: { detail: "Bank 'new' not found" },
      }),
      "GET /v1/default/banks/bad/directives": () => ({ status: 500, json: {} }),
    });
    expect(await client.listDirectives("new")).toEqual([]);
    await expect(client.listDirectives("bad")).rejects.toThrow("HTTP 500");
  });

  it("creates, gets and deletes, with null and false for a missing directive", async () => {
    const { client, fake } = clientFor({
      "POST /v1/default/banks/dev/directives": (body) => ({
        json: raw("new", body as Record<string, unknown>),
      }),
      "GET /v1/default/banks/dev/directives/d1": () => ({ json: raw("d1") }),
      "GET /v1/default/banks/dev/directives/gone": () => ({
        status: 404,
        json: { detail: "Directive 'gone' not found" },
      }),
      "DELETE /v1/default/banks/dev/directives/d1": () => ({ json: { success: true } }),
      "DELETE /v1/default/banks/dev/directives/gone": () => ({
        status: 404,
        json: { detail: "Directive 'gone' not found" },
      }),
    });
    const created = await client.createDirective("dev", {
      name: "No merges",
      content: "Never merge your own MR.",
      priority: 5,
      tags: ["scope:x"],
    });
    expect(fake.requests[0]!.body).toEqual({
      name: "No merges",
      content: "Never merge your own MR.",
      priority: 5,
      tags: ["scope:x"],
    });
    expect(created).toMatchObject({ name: "No merges", priority: 5, tags: ["scope:x"] });
    expect((await client.getDirective("dev", "d1"))?.id).toBe("d1");
    expect(await client.getDirective("dev", "gone")).toBeNull();
    expect(await client.deleteDirective("dev", "d1")).toBe(true);
    expect(await client.deleteDirective("dev", "gone")).toBe(false);
  });

  it("keeps a route 404 loud on get and delete", async () => {
    const route = clientFor({
      "GET /v1/default/banks/dev/directives/d1": () => ({
        status: 404,
        json: { detail: "Not Found" },
      }),
      "DELETE /v1/default/banks/dev/directives/d1": () => ({
        status: 404,
        json: { detail: "Not Found" },
      }),
    }).client;
    await expect(route.getDirective("dev", "d1")).rejects.toThrow("HTTP 404");
    await expect(route.deleteDirective("dev", "d1")).rejects.toThrow("HTTP 404");
  });

  it("toDirective needs id, name and content", () => {
    expect(toDirective({ id: "a", name: "b" })).toBeNull();
    expect(toDirective("x")).toBeNull();
    expect(
      toDirective({ id: "a", name: "b", content: "c", is_active: false, tags: [1, "t"] }),
    ).toEqual({ id: "a", name: "b", content: "c", priority: 0, isActive: false, tags: ["t"] });
  });
});

describe("directive prompt lines", () => {
  it("lists active global directives, highest priority first, then by name", () => {
    const lines = directiveLines([
      D({ id: "b", name: "B", priority: 1 }),
      D({ id: "a", name: "A", priority: 1 }),
      D({ id: "top", name: "Top", priority: 9, content: "Never  push\n to main." }),
      D({ id: "off", isActive: false }),
      D({ id: "scoped", tags: ["x"] }),
      D({ id: "blank", content: "   " }),
    ]);
    expect(lines).toEqual([
      "## Hindsight directives",
      "Hard rules from this agent's memory bank. Follow them in every reply and tool call:",
      "- Top: Never push to main.",
      "- A: rule a",
      "- B: rule b",
    ]);
  });

  it("is empty without directives, caps the count and cuts long text", () => {
    expect(directiveLines([])).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) =>
      D({ id: `d${String(i).padStart(2, "0")}`, content: "x".repeat(MAX_DIRECTIVE_CHARS + 10) }),
    );
    expect(promptDirectives(many)).toHaveLength(MAX_PROMPT_DIRECTIVES);
    const lines = directiveLines(many);
    expect(lines).toHaveLength(MAX_PROMPT_DIRECTIVES + 2);
    expect(lines[2]).toBe(`- d00: ${"x".repeat(MAX_DIRECTIVE_CHARS)}...`);
  });

  it("renders the same lines for the same set in any order", () => {
    const set = [D({ id: "a" }), D({ id: "b", priority: 2 }), D({ id: "c" })];
    expect(directiveLines(set)).toEqual(directiveLines(set.toReversed()));
  });
});

describe("directive cache", () => {
  it("serves nothing until the first fetch, then the cached lines without refetching", async () => {
    let now = 0;
    const fetch = vi.fn<AnyFn>(async () => [D({ id: "a" })]);
    const cache = createDirectiveCache({ fetch, now: () => now, ttlMs: 1000 });
    expect(cache.lines("dev")).toEqual([]);
    expect(cache.lines("dev")).toEqual([]);
    await vi.waitFor(() => expect(cache.lines("dev")).toHaveLength(3));
    now = 999;
    cache.lines("dev");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("prefetches at start, refetches after the TTL and serves old lines meanwhile", async () => {
    let now = 0;
    let content = "first";
    const fetch = vi.fn<AnyFn>(async () => [D({ id: "a", content })]);
    const cache = createDirectiveCache({ fetch, now: () => now, ttlMs: 1000 });
    await cache.prefetch(["dev", "dev"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.lines("dev")[2]).toBe("- a: first");
    now = 1000;
    content = "second";
    expect(cache.lines("dev")[2]).toBe("- a: first");
    await vi.waitFor(() => expect(cache.lines("dev")[2]).toBe("- a: second"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the last lines when a refresh fails and reports the error", async () => {
    let now = 0;
    let fail = false;
    const onError = vi.fn<AnyFn>();
    const fetch = vi.fn<AnyFn>(async () => {
      if (fail) {
        throw new Error("down");
      }
      return [D({ id: "a" })];
    });
    const cache = createDirectiveCache({ fetch, onError, now: () => now, ttlMs: 1000 });
    await cache.prefetch(["dev"]);
    fail = true;
    now = 2000;
    cache.lines("dev");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("dev", expect.any(Error)));
    expect(cache.lines("dev")).toHaveLength(3);
    // The failure counts as a fetch: no retry before the next TTL.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps banks apart", async () => {
    const fetch = vi.fn<AnyFn>(async (bank: string) => [D({ id: bank })]);
    const cache = createDirectiveCache({ fetch });
    await cache.prefetch(["a", "b"]);
    expect(cache.lines("a")[2]).toBe("- a: rule a");
    expect(cache.lines("b")[2]).toBe("- b: rule b");
  });
});

function boot(extra: Record<string, unknown>) {
  const fake = createFakeHindsight({
    "GET /v1/default/banks/main/directives": () => ({
      json: { items: [raw("d1", { name: "No self-merge", content: "Never merge your own MR." })] },
    }),
    "GET /v1/default/banks/shared/directives": () => ({
      json: { items: [raw("d2", { name: "Shared", content: "Shared rule." })] },
    }),
  });
  vi.stubGlobal("fetch", fake.fetch);
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "t",
    ...extra,
  };
  const registerMemoryCapability = vi.fn<AnyFn>();
  const registerService = vi.fn<AnyFn>();
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
    registerMemoryCapability,
    registerTool: vi.fn<AnyFn>(),
    registerService,
  } as unknown as OpenClawPluginApi;
  memoryPlugin.register(api);
  const capability = registerMemoryCapability.mock.calls[0]![0] as {
    promptBuilder?: (p: { availableTools: Set<string>; agentId?: string }) => string[];
  };
  const service = registerService.mock.calls.at(-1)![0] as { start: AnyFn; stop: AnyFn };
  return { fake, capability, service };
}

describe("promptDirectives in the plugin", () => {
  it("is off by default: no promptBuilder and no directive request", () => {
    const { capability, service, fake } = boot({});
    expect(capability.promptBuilder).toBeUndefined();
    service.start({});
    service.stop();
    expect(fake.requests.filter((r) => r.url.includes("/directives"))).toEqual([]);
  });

  it("prefetches at start and lists the owner bank's directives without the base section", async () => {
    const { capability, service, fake } = boot({
      promptDirectives: true,
      agentBankMap: { ops: "shared" },
    });
    service.start({});
    const build = capability.promptBuilder!;
    await vi.waitFor(() =>
      expect(build({ availableTools: new Set() })).toEqual([
        "## Hindsight directives",
        "Hard rules from this agent's memory bank. Follow them in every reply and tool call:",
        "- No self-merge: Never merge your own MR.",
      ]),
    );
    expect(build({ availableTools: new Set(), agentId: "ops" })[2]).toBe("- Shared: Shared rule.");
    const before = fake.requests.length;
    // Builds within the TTL send nothing: the prompt prefix stays stable and the turn never waits.
    for (let i = 0; i < 5; i++) {
      build({ availableTools: new Set(), agentId: "main" });
    }
    expect(fake.requests.length).toBe(before);
    const urls = fake.requests.map((r) => new URL(r.url));
    expect(urls.every((u) => u.searchParams.get("active_only") === "true")).toBe(true);
    service.stop();
  });

  it("appends the directives after the memory section when both are on", async () => {
    const { capability, service } = boot({ promptDirectives: true, memoryPromptSection: true });
    service.start({});
    const build = capability.promptBuilder!;
    await vi.waitFor(() =>
      expect(build({ availableTools: new Set() }).at(-1)).toBe(
        "- No self-merge: Never merge your own MR.",
      ),
    );
    const lines = build({ availableTools: new Set() });
    expect(lines[0]).toBe("## Hindsight memory");
    expect(lines.at(-1)).toBe("- No self-merge: Never merge your own MR.");
    service.stop();
  });

  it("parses promptDirectives as a boolean, default false", () => {
    const base = { hindsightApiUrl: "http://hindsight.test", allowInsecureHttp: true };
    expect(hindsightConfigSchema.parse(base).promptDirectives).toBe(false);
    expect(hindsightConfigSchema.parse({ ...base, promptDirectives: true }).promptDirectives).toBe(
      true,
    );
    expect(() => hindsightConfigSchema.parse({ ...base, promptDirectives: "yes" })).toThrow(
      /promptDirectives/,
    );
  });
});

function admin(params: {
  tty?: boolean;
  confirm?: boolean;
  routes?: Parameters<typeof createFakeHindsight>[0];
}) {
  const fake = createFakeHindsight({
    "GET /v1/default/banks/main/directives": () => ({
      json: { items: [raw("d1", { name: "A", content: "Rule A" }), raw("d2", { tags: ["x"] })] },
    }),
    "GET /v1/default/banks/main/directives/d1": () => ({ json: raw("d1") }),
    "GET /v1/default/banks/main/directives/gone": () => ({
      status: 404,
      json: { detail: "Directive 'gone' not found" },
    }),
    "DELETE /v1/default/banks/main/directives/d1": () => ({ json: { success: true } }),
    "POST /v1/default/banks/main/directives": (body) => ({
      json: raw("new", body as Record<string, unknown>),
    }),
    ...params.routes,
  });
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const asked: string[] = [];
  const io: AdminIo = {
    log: (...a) => out.push(a.join(" ")),
    error: (...a) => err.push(a.join(" ")),
    exit: (c) => exits.push(c),
    isTTY: params.tty ?? true,
    confirm: async (q) => {
      asked.push(q);
      return params.confirm ?? false;
    },
  };
  const config = hindsightConfigSchema.parse({
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "secret-token-value",
  });
  const commands = createAdminCommands({
    io: () => io,
    parseConfig: () => ({ config }),
    clientFor: (c) =>
      new HindsightClient({
        resolveEndpoint: () => ({ apiUrl: c.apiUrl, apiToken: c.apiToken }),
        fetch: fake.fetch,
      }),
  });
  const result = () => ({
    out: out.join("\n"),
    err: err.join("\n"),
    exit: exits.at(-1) ?? 0,
    asked,
    writes: fake.requests.filter((r) => r.method !== "GET"),
  });
  return { commands, result, fake };
}

describe("openclaw hindsight directives", () => {
  it("list prints active directives of the agent's owner bank and marks the prompt ones", async () => {
    const { commands, result, fake } = admin({});
    await commands.directivesList({});
    const r = result();
    expect(r.out).toContain("Bank main: 2 active directive(s)");
    expect(r.out).toContain(
      "d1  A  (active, priority 0, global)\n    Rule A\n    (listed by promptDirectives)",
    );
    expect(r.out).toContain("d2  n-d2  (active, priority 0, tags x)");
    expect(r.out).not.toContain("secret-token-value");
    expect(new URL(fake.requests[0]!.url).searchParams.get("active_only")).toBe("true");
    const second = admin({});
    await second.commands.directivesList({ all: true, json: true });
    const json = JSON.parse(second.result().out) as {
      directives: Array<{ id: string; inPrompt: boolean }>;
    };
    expect(json.directives.map((d) => [d.id, d.inPrompt])).toEqual([
      ["d1", true],
      ["d2", false],
    ]);
    expect(new URL(second.fake.requests[0]!.url).searchParams.has("active_only")).toBe(false);
  });

  it("add previews, honors --dry-run, needs --yes outside a terminal and asks in one", async () => {
    const dry = admin({});
    await dry.commands.directivesAdd({ name: "N", content: "C", dryRun: true });
    expect(dry.result().out).toContain("Dry run: nothing was changed.");
    expect(dry.result().writes).toEqual([]);

    const noTty = admin({ tty: false });
    await noTty.commands.directivesAdd({ name: "N", content: "C" });
    expect(noTty.result().exit).toBe(1);
    expect(noTty.result().err).toContain("pass --yes");
    expect(noTty.result().writes).toEqual([]);

    const declined = admin({ confirm: false });
    await declined.commands.directivesAdd({ name: "N", content: "C" });
    expect(declined.result().asked).toEqual(["Add this directive to bank main? [y/N] "]);
    expect(declined.result().writes).toEqual([]);

    const yes = admin({ tty: false });
    await yes.commands.directivesAdd({ name: "N", content: "C", yes: true, bank: "main" });
    expect(yes.result().asked).toEqual([]);
    expect(yes.result().writes).toHaveLength(1);

    const ok = admin({ confirm: true });
    await ok.commands.directivesAdd({ name: "N", content: "C", priority: "3", tags: "a, b" });
    expect(ok.result().writes.map((w) => w.body)).toEqual([
      { name: "N", content: "C", priority: 3, tags: ["a", "b"] },
    ]);
    expect(ok.result().out).toContain("Added directive new.");
  });

  it("add validates name, content and priority before any request", async () => {
    for (const opts of [
      { content: "C" },
      { name: "N" },
      { name: "N", content: "C", priority: "1.5" },
      { name: "N".repeat(201), content: "C" },
      { name: "N", content: "C".repeat(2001) },
    ]) {
      const { commands, result, fake } = admin({});
      await commands.directivesAdd({ ...opts, yes: true });
      expect(result().exit).toBe(1);
      expect(fake.requests).toEqual([]);
    }
  });

  it("rm shows the directive, asks, and deletes only after a yes", async () => {
    const declined = admin({ confirm: false });
    await declined.commands.directivesRm("d1", {});
    expect(declined.result().out).toContain("d1  n-d1");
    expect(declined.result().writes).toEqual([]);

    const ok = admin({ confirm: true });
    await ok.commands.directivesRm("d1", {});
    expect(ok.result().writes.map((w) => `${w.method} ${new URL(w.url).pathname}`)).toEqual([
      "DELETE /v1/default/banks/main/directives/d1",
    ]);
    expect(ok.result().out).toContain("Deleted directive d1.");

    const missing = admin({ confirm: true });
    await missing.commands.directivesRm("gone", {});
    expect(missing.result().err).toContain("no directive gone in bank main");
    expect(missing.result().writes).toEqual([]);

    const empty = admin({});
    await empty.commands.directivesRm("  ", {});
    expect(empty.result().exit).toBe(1);
  });

  it("refuses a bad --bank and a bad config", async () => {
    const { commands, result } = admin({});
    await commands.directivesList({ bank: ".." });
    expect(result().err).toContain("--bank must be a bank id");
    const io = {
      log: vi.fn<AnyFn>(),
      error: vi.fn<AnyFn>(),
      exit: vi.fn<AnyFn>(),
      isTTY: true,
      confirm: vi.fn<AnyFn>(),
    };
    await createAdminCommands({
      io: () => io,
      parseConfig: () => ({ error: "bad url" }),
      clientFor: () => {
        throw new Error("unreachable");
      },
    }).directivesList({});
    expect(io.error).toHaveBeenCalledWith(
      "directives list: config invalid (bad url); run openclaw hindsight doctor",
    );
  });

  it("formats a directive on two lines", () => {
    expect(formatDirective(D({ id: "x", content: "a\n b", priority: -1, isActive: false }))).toBe(
      "x  x  (inactive, priority -1, global)\n    a b",
    );
  });

  it("registers directives list, add and rm under the root command", () => {
    const made: string[] = [];
    const node = (path: string): Record<string, AnyFn> => {
      const self: Record<string, AnyFn> = {
        command: (name: string) => {
          made.push(`${path} ${name}`.trim());
          return node(`${path} ${name.split(" ")[0]}`.trim());
        },
        description: () => self,
        option: () => self,
        requiredOption: () => self,
        action: () => self,
      };
      return self;
    };
    registerAdminCommands(node("") as never, {
      io: () => ({}) as AdminIo,
      parseConfig: () => ({ error: "x" }),
      clientFor: () => ({}) as HindsightClient,
    });
    expect(made.filter((m) => m.startsWith("directives"))).toEqual([
      "directives",
      "directives list",
      "directives add",
      "directives rm <id>",
    ]);
  });
});
