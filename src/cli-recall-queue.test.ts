import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_COMMAND, type CliRuntime, queueItemId, registerHindsightCli } from "./cli.js";
import { PLUGIN_ID } from "./index.js";
import {
  appendQueueTombstone,
  readQueueFile,
  RetainQueue,
  retainQueuePath,
} from "./retain-queue.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

/** The part of a Commander command the CLI uses; actions are kept so tests can run them. */
class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  readonly options: string[] = [];
  usage = "";
  run: AnyFn | undefined;
  constructor(readonly name: string) {}
  command(name: string) {
    const child = new FakeCommand(name.split(" ")[0]!);
    child.usage = name;
    this.children.set(child.name, child);
    return child;
  }
  description() {
    return this;
  }
  option(flags: string) {
    this.options.push(flags);
    return this;
  }
  requiredOption(flags: string) {
    this.options.push(`${flags} (required)`);
    return this;
  }
  action(fn: AnyFn) {
    this.run = fn;
    return this;
  }
}

const TOKEN = "secret-token-value";
const SECRET_TEXT = "the private memory text of a queued retain";
let stateDir: string;
let calls: Array<{ method: string; url: URL; body?: Record<string, unknown> }>;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-cli2-"));
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(stateDir, { recursive: true, force: true });
});

function serveRecall(results: unknown[] | "down") {
  vi.stubGlobal(
    "fetch",
    vi.fn<AnyFn>(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({ method: init?.method ?? "GET", url, ...(body ? { body } : {}) });
      if (results === "down") {
        throw new TypeError("fetch failed");
      }
      if (url.pathname.endsWith("/memories/recall")) {
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }),
  );
}

function boot(params: { extra?: Record<string, unknown>; tty?: boolean; confirm?: boolean } = {}) {
  const pluginConfig = {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: TOKEN,
    ...params.extra,
  };
  const config = { plugins: { entries: { [PLUGIN_ID]: { config: pluginConfig } } } };
  const registerCli = vi.fn<AnyFn>();
  const api = {
    id: PLUGIN_ID,
    pluginConfig,
    config,
    logger: { info: vi.fn<AnyFn>(), warn: vi.fn<AnyFn>(), debug: vi.fn<AnyFn>() },
    runtime: {
      config: { current: () => config },
      state: { resolveStateDir: () => stateDir },
    },
    registerCli,
  } as unknown as OpenClawPluginApi;
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const asked: string[] = [];
  const runtime: CliRuntime = {
    log: (...args) => out.push(args.join(" ")),
    error: (...args) => err.push(args.join(" ")),
    exit: (code) => exits.push(code),
    isTTY: params.tty ?? true,
    confirm: async (question) => {
      asked.push(question);
      return params.confirm ?? false;
    },
  };
  registerHindsightCli(api, { runtime });
  const [registrar] = registerCli.mock.calls[0]!;
  const program = new FakeCommand("openclaw");
  registrar({ program, parentPath: [], config, logger: api.logger });
  const root = program.children.get(CLI_COMMAND)!;
  const run = async (name: string, ...args: unknown[]) => {
    out.length = 0;
    err.length = 0;
    exits.length = 0;
    await root.children.get(name)!.run!(...args);
    return { out: out.join("\n"), err: err.join("\n"), exit: exits.at(-1) ?? 0 };
  };
  return { root, run, asked };
}

const RESULTS = [
  { id: "m1", text: "Hindsight runs on the Studio", type: "world", scores: { final: 0.91 } },
  { id: "m2", text: "The API listens on 8888", type: "observation", scores: { final: 0.5 } },
  { id: "m3", text: "A third fact", type: "experience" },
];

describe("openclaw hindsight recall (N5)", () => {
  it("is registered with a query argument and the documented options", () => {
    const { root } = boot();
    const recall = root.children.get("recall")!;
    expect(recall.usage).toBe("recall <query>");
    expect(recall.options).toEqual([
      "--agent <id>",
      "--bank <id>",
      "--types <list>",
      "--json",
      "--token-file <path>",
    ]);
  });

  it("sends the agent's auto-recall request and prints what it would inject, with scores", async () => {
    serveRecall(RESULTS);
    const { run } = boot({
      extra: {
        recallTopK: 9,
        agents: {
          dev: { recallTopK: 2, recallMinScore: 0.3, recallTypes: ["world", "observation"] },
        },
      },
    });
    const res = await run("recall", "where does hindsight run?", { agent: "dev" });
    expect(res.exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/default/banks/dev/memories/recall");
    expect(calls[0]!.body).toEqual({
      query: "where does hindsight run?",
      budget: "mid",
      max_tokens: 1024,
      types: ["world", "observation"],
      min_scores: { final: 0.3 },
      include: { entities: null },
    });
    expect(res.out.split("\n")).toEqual([
      "Bank: dev (agent dev); 3 results, auto-recall would inject 2 (recallTopK 2)",
      "1. [world] score 0.910  Hindsight runs on the Studio",
      "2. [observation] score 0.500  The API listens on 8888",
      "   (not injected) 3. [experience] score -  A third fact",
    ]);
    expect(`${res.out}${res.err}`).not.toContain(TOKEN);
  });

  it("uses agent main by default, and --bank and --types replace the bank and the types", async () => {
    serveRecall([]);
    const { run } = boot();
    const plain = await run("recall", "q", {});
    expect(calls[0]!.url.pathname).toBe("/v1/default/banks/main/memories/recall");
    expect(plain.out).toBe("Bank: main (agent main); no memories");
    await run("recall", "q", { bank: "team", types: "observation, world" });
    expect(calls[1]!.url.pathname).toBe("/v1/default/banks/team/memories/recall");
    expect(calls[1]!.body?.types).toEqual(["observation", "world"]);
  });

  it("prints JSON with --json", async () => {
    serveRecall(RESULTS.slice(0, 1));
    const { run } = boot();
    const res = await run("recall", "q", { json: true });
    expect(JSON.parse(res.out)).toEqual({
      bank: "main",
      agent: "main",
      injected: 1,
      results: [{ id: "m1", type: "world", score: 0.91, text: "Hindsight runs on the Studio" }],
    });
  });

  it("refuses bad options without a request and fails on an unreachable server", async () => {
    serveRecall([]);
    const { run } = boot();
    for (const [query, opts, message] of [
      ["", {}, "recall: a query is required"],
      [
        "q",
        { types: "facts" },
        "recall: --types must be a comma list of world, experience, observation",
      ],
      ["q", { bank: ".." }, 'recall: --bank must be a bank id (not empty, "." or "..")'],
    ] as const) {
      const res = await run("recall", query, opts);
      expect({ err: res.err, exit: res.exit }).toEqual({ err: message, exit: 1 });
    }
    expect(calls).toHaveLength(0);
    serveRecall("down");
    const down = await run("recall", "q", {});
    expect(down.exit).toBe(1);
    expect(down.err).toContain("recall: Hindsight request failed");
    expect(down.err).not.toContain(TOKEN);
  });
});

function queueFile() {
  return retainQueuePath(stateDir);
}

function gatewayQueue() {
  const queue = new RetainQueue({
    filePath: queueFile(),
    limits: () => ({ maxItems: 100, maxAgeMs: 3_600_000 }),
    logger: { info: vi.fn<AnyFn>() },
  });
  queue.load();
  return queue;
}

function enqueue(queue: RetainQueue, bankId: string, documentId: string) {
  queue.enqueue({
    bankId,
    documentId,
    item: { content: SECRET_TEXT, document_id: documentId },
  });
}

describe("openclaw hindsight queue (N5)", () => {
  it("is registered with --list, --drop and --yes", () => {
    const { root } = boot();
    expect(root.children.get("queue")!.options).toEqual(["--list", "--drop <id>", "--yes"]);
  });

  it("lists items without memory text", async () => {
    const queue = gatewayQueue();
    enqueue(queue, "dev", "openclaw:run:a");
    enqueue(queue, "team", "openclaw:run:b");
    const { run } = boot();
    const res = await run("queue", { list: true });
    expect(res.exit).toBe(0);
    const lines = res.out.split("\n");
    expect(lines[0]).toBe("Retain queue: 2 items");
    expect(lines[1]).toMatch(
      new RegExp(
        `^${queueItemId("dev", "openclaw:run:a")}  dev  openclaw:run:a  queued \\S+Z  \\d+ bytes$`,
      ),
    );
    expect(lines[2]).toContain(`${queueItemId("team", "openclaw:run:b")}  team  openclaw:run:b`);
    expect(res.out).not.toContain(SECRET_TEXT);
    expect(queueItemId("dev", "openclaw:run:a")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("says so for an empty or missing queue", async () => {
    const { run } = boot();
    expect((await run("queue", { list: true })).out).toBe("Retain queue: empty");
  });

  it("drops one item after a yes, and the Gateway's queue forgets it before replay", async () => {
    const queue = gatewayQueue();
    enqueue(queue, "dev", "openclaw:run:a");
    enqueue(queue, "dev", "openclaw:run:b");
    const { run, asked } = boot({ confirm: true });
    const id = queueItemId("dev", "openclaw:run:a");
    const res = await run("queue", { drop: id });
    expect(asked).toEqual([
      `Drop queued retain ${id} (dev, openclaw:run:a)? It will not be sent. [y/N] `,
    ]);
    expect(res.exit).toBe(0);
    expect(res.out).toContain(`Dropped ${id} (dev, openclaw:run:a).`);
    expect(readQueueFile(queueFile()).entries.map((e) => e.documentId)).toEqual(["openclaw:run:b"]);
    // The running Gateway's queue drops it from memory at the next replay step or write.
    expect(queue.peek()?.documentId).toBe("openclaw:run:b");
    expect(queue.size()).toBe(1);
    enqueue(queue, "dev", "openclaw:run:c");
    expect(readQueueFile(queueFile()).entries.map((e) => e.documentId)).toEqual([
      "openclaw:run:b",
      "openclaw:run:c",
    ]);
    queue.remove(queue.peek()!);
    expect(readQueueFile(queueFile()).entries.map((e) => e.documentId)).toEqual(["openclaw:run:c"]);
  });

  it("drops with --yes outside a terminal; without it refuses; a no keeps the item", async () => {
    const queue = gatewayQueue();
    enqueue(queue, "dev", "openclaw:run:a");
    const id = queueItemId("dev", "openclaw:run:a");
    const refused = await boot({ tty: false }).run("queue", { drop: id });
    expect(refused).toMatchObject({
      exit: 1,
      err: "queue: not a terminal: pass --yes to drop",
    });
    const no = await boot({ confirm: false }).run("queue", { drop: id });
    expect(no).toMatchObject({ exit: 1, out: "Nothing dropped." });
    expect(readQueueFile(queueFile()).entries).toHaveLength(1);
    const yes = await boot({ tty: false }).run("queue", { drop: id, yes: true });
    expect(yes.exit).toBe(0);
    expect(readQueueFile(queueFile()).entries).toHaveLength(0);
  });

  it("fails for an unknown id, and needs exactly one of --list and --drop", async () => {
    const { run } = boot();
    expect(await run("queue", { drop: "000000000000" })).toMatchObject({
      exit: 1,
      err: "queue: no queued item with id 000000000000 (see openclaw hindsight queue --list)",
    });
    for (const opts of [{}, { list: true, drop: "x" }]) {
      expect(await run("queue", opts)).toMatchObject({
        exit: 1,
        err: "queue: pass --list, or --drop <id>",
      });
    }
  });

  it("appendQueueTombstone writes one line that removes only that item", () => {
    const queue = gatewayQueue();
    enqueue(queue, "dev", "a");
    enqueue(queue, "dev", "b");
    const before = readFileSync(queueFile(), "utf8");
    appendQueueTombstone(queueFile(), { bankId: "dev", documentId: "a" });
    const after = readFileSync(queueFile(), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(
      `${JSON.stringify({ tombstone: { bankId: "dev", documentId: "a" } })}\n`,
    );
  });
});
