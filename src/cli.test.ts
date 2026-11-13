import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_COMMAND, type CliRuntime, registerHindsightCli } from "./cli.js";
import { runDocumentId, sessionDocumentPrefix } from "./document-ids.js";
import memoryPlugin, { PLUGIN_ID } from "./index.js";
import { retainQueuePath } from "./retain-queue.js";
import { conversationBankId } from "./routing.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

/** The part of a Commander command the CLI uses; actions are kept so tests can run them. */
class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  readonly options: string[] = [];
  desc = "";
  run: AnyFn | undefined;
  constructor(readonly name: string) {}
  command(name: string) {
    const child = new FakeCommand(name.split(" ")[0]!);
    this.children.set(child.name, child);
    return child;
  }
  description(text: string) {
    this.desc = text;
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

const SESSION = "agent:dev:telegram:direct:42";
const PREFIX = sessionDocumentPrefix(SESSION);
const CONV_BANK = conversationBankId("dev", SESSION);
const documentsPath = (bank: string) => `/v1/default/banks/${encodeURIComponent(bank)}/documents`;

type Route = (url: URL, init?: RequestInit) => { status?: number; json?: unknown };

let stateDir: string;
let calls: Array<{ method: string; url: URL; auth?: string }>;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-cli-"));
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(stateDir, { recursive: true, force: true });
});

function serve(routes: Record<string, Route>) {
  vi.stubGlobal(
    "fetch",
    vi.fn<AnyFn>(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, url, auth: headers.Authorization });
      const route = routes[`${method} ${url.pathname}`];
      const answer = route ? route(url, init) : { status: 404, json: { detail: "Not Found" } };
      return new Response(answer.json === undefined ? "" : JSON.stringify(answer.json), {
        status: answer.status ?? 200,
      });
    }),
  );
}

function boot(params: {
  pluginConfig?: Record<string, unknown>;
  slot?: string;
  tty?: boolean;
  confirm?: boolean;
  hasMemoryKind?: boolean;
}) {
  const pluginConfig = params.pluginConfig ?? {
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "secret-token-value",
  };
  const config = {
    plugins: {
      slots: { memory: params.slot ?? PLUGIN_ID },
      entries: { [PLUGIN_ID]: { config: pluginConfig } },
    },
  };
  const registerCli = vi.fn<AnyFn>();
  const api = {
    id: PLUGIN_ID,
    pluginConfig,
    config,
    logger: {
      info: vi.fn<AnyFn>(),
      warn: vi.fn<AnyFn>(),
      error: vi.fn<AnyFn>(),
      debug: vi.fn<AnyFn>(),
    },
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
  registerHindsightCli(api, {
    runtime,
    ...(params.hasMemoryKind === undefined ? {} : { hasMemoryKind: () => params.hasMemoryKind! }),
  });
  const [registrar, opts] = registerCli.mock.calls[0]!;
  const program = new FakeCommand("openclaw");
  registrar({ program, parentPath: [], config, logger: api.logger });
  const root = program.children.get(CLI_COMMAND)!;
  const run = async (name: string, options: Record<string, unknown> = {}) => {
    out.length = 0;
    err.length = 0;
    exits.length = 0;
    await root.children.get(name)!.run!(options);
    return { out: out.join("\n"), err: err.join("\n"), exit: exits.at(-1) ?? 0 };
  };
  return { opts, root, run, asked };
}

function queueItem(bankId: string, documentId: string) {
  const file = retainQueuePath(stateDir);
  mkdirSync(join(stateDir, "hindsight-native"), { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    `${JSON.stringify({ bankId, documentId, item: { content: "x", document_id: documentId }, queuedAt: Date.now() })}\n`,
    { mode: 0o600 },
  );
}

const healthy: Record<string, Route> = {
  "GET /health": () => ({ json: { status: "healthy" } }),
  "GET /version": () => ({ json: { api_version: "1.2.1", features: {} } }),
  "GET /v1/default/banks": () => ({ json: { banks: [] } }),
};

describe("openclaw hindsight: registration", () => {
  it("registers one root command with a descriptor that matches the manifest", async () => {
    const { opts, root } = boot({});
    expect(opts).toEqual({
      descriptors: [
        {
          name: "hindsight",
          description:
            "Inspect and maintain Hindsight memory (status, doctor, recall, queue, forget, directives, memory, consolidate, export, sync-memory-files)",
          hasSubcommands: true,
        },
      ],
    });
    expect([...root.children.keys()]).toEqual([
      "status",
      "doctor",
      "recall",
      "queue",
      "forget",
      "directives",
      "memory",
      "consolidate",
      "export",
      "sync-memory-files",
    ]);
    expect([...root.children.get("directives")!.children.keys()]).toEqual(["list", "add", "rm"]);
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { cliCommands?: unknown };
    expect(manifest.cliCommands).toEqual(opts.descriptors);
  });

  it("is registered even when the plugin config is invalid, so doctor can explain it", () => {
    const registerCli = vi.fn<AnyFn>();
    const api = {
      id: PLUGIN_ID,
      pluginConfig: {},
      config: {},
      logger: {
        info: vi.fn<AnyFn>(),
        warn: vi.fn<AnyFn>(),
        error: vi.fn<AnyFn>(),
        debug: vi.fn<AnyFn>(),
      },
      runtime: { config: { current: () => ({}) } },
      on: vi.fn<AnyFn>(),
      registerService: vi.fn<AnyFn>(),
      registerTool: vi.fn<AnyFn>(),
      registerMemoryCapability: vi.fn<AnyFn>(),
      registerCli,
    } as unknown as OpenClawPluginApi;
    memoryPlugin.register(api);
    expect(registerCli).toHaveBeenCalledTimes(1);
  });

  it("registers only the CLI in cli-metadata mode", () => {
    const registerCli = vi.fn<AnyFn>();
    const registerMemoryCapability = vi.fn<AnyFn>();
    const api = {
      id: PLUGIN_ID,
      registrationMode: "cli-metadata",
      pluginConfig: { hindsightApiUrl: "http://hindsight.test", allowInsecureHttp: true },
      config: {},
      logger: {
        info: vi.fn<AnyFn>(),
        warn: vi.fn<AnyFn>(),
        error: vi.fn<AnyFn>(),
        debug: vi.fn<AnyFn>(),
      },
      on: vi.fn<AnyFn>(),
      registerService: vi.fn<AnyFn>(),
      registerTool: vi.fn<AnyFn>(),
      registerMemoryCapability,
      registerCli,
    } as unknown as OpenClawPluginApi;
    memoryPlugin.register(api);
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerMemoryCapability).not.toHaveBeenCalled();
  });
});

describe("openclaw hindsight status", () => {
  it("prints the server, version, slot owner, mode and queue depth without the token", async () => {
    serve(healthy);
    queueItem("dev", "openclaw:x:run:1");
    const { run } = boot({});
    const res = await run("status");
    expect(res.exit).toBe(0);
    expect(res.out).toContain("Hindsight: http://hindsight.test (reachable, API 1.2.1)");
    expect(res.out).toMatch(/Plugin: @etzelm\/openclaw-memory-hindsight \d+\.\d+\.\d+/);
    expect(res.out).toContain("Memory slot: hindsight-native");
    expect(res.out).toContain("Mode: hybrid (auto-recall on, auto-retain on)");
    expect(res.out).toContain("Retain queue: 1 pending (dev: 1)");
    expect(res.out).not.toContain("secret-token-value");
  });

  it("prints JSON with --json", async () => {
    serve(healthy);
    const { run } = boot({});
    const res = await run("status", { json: true });
    const parsed = JSON.parse(res.out) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      apiUrl: "http://hindsight.test",
      reachable: true,
      serverVersion: "1.2.1",
      memorySlot: "hindsight-native",
      queue: { pending: 0, byBank: {} },
    });
    expect(res.out).not.toContain("secret-token-value");
  });

  it("says when Hindsight is unreachable and exits 1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<AnyFn>(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { run } = boot({});
    const res = await run("status");
    expect(res.out).toContain("Hindsight: http://hindsight.test (unreachable)");
    expect(res.exit).toBe(1);
  });
});

describe("openclaw hindsight doctor", () => {
  it("passes every check on a healthy setup", async () => {
    serve(healthy);
    const { run } = boot({});
    const res = await run("doctor");
    expect(res.exit).toBe(0);
    for (const check of [
      "PASS config",
      "PASS memory slot",
      "PASS token source",
      "PASS reachable",
      "PASS server version",
      "PASS auth",
      "PASS retain queue",
    ]) {
      expect(res.out).toContain(check);
    }
    // The host's console redaction masks the word after "token:", so no line may contain it.
    expect(res.out).not.toMatch(/\btoken:\s/i);
    expect(res.out).not.toContain("secret-token-value");
  });

  it("explains an invalid config with the fix, and stops there", async () => {
    serve(healthy);
    const { run } = boot({ pluginConfig: { hindsightApiUrl: "ftp://x" } });
    const res = await run("doctor");
    expect(res.exit).toBe(1);
    expect(res.out).toContain("FAIL config: hindsightApiUrl must be an absolute http(s) URL");
    expect(res.out).toContain("fix: openclaw config set plugins.entries.hindsight-native.config");
    expect(calls).toEqual([]);
  });

  it("fails the slot check when a build without manifest kind owns the slot", async () => {
    serve(healthy);
    const { run } = boot({ hasMemoryKind: false });
    const res = await run("doctor");
    expect(res.out).toContain(
      "FAIL memory slot: this build has no manifest kind memory, so the host refuses its memory runtime while plugins.slots.memory names it",
    );
    expect(res.exit).toBe(1);
    const ok = boot({ hasMemoryKind: true });
    expect((await ok.run("doctor")).out).toContain("PASS memory slot: owner");
  });

  it("passes a sidecar beside the slot owner, and fails a rejected token", async () => {
    serve({ ...healthy, "GET /v1/default/banks": () => ({ status: 401, json: {} }) });
    const { run } = boot({ slot: "memory-core" });
    const res = await run("doctor");
    expect(res.out).toContain('PASS memory slot: sidecar beside "memory-core" (mode auto)');
    expect(res.out).toContain("FAIL auth: Hindsight answered HTTP 401");
    expect(res.exit).toBe(1);
  });

  it("uses --token-file for a SecretRef this process cannot resolve, and never prints it", async () => {
    serve(healthy);
    const tokenFile = join(stateDir, "token");
    writeFileSync(tokenFile, "file-token-value\n", { mode: 0o600 });
    const { run } = boot({
      pluginConfig: {
        hindsightApiUrl: "http://hindsight.test",
        allowInsecureHttp: true,
        hindsightApiToken: { source: "file", provider: "f", id: "/x" },
      },
    });
    const res = await run("doctor", { tokenFile });
    expect(res.out).toContain("PASS token source: --token-file (not shown)");
    expect(res.exit).toBe(0);
    expect(calls.filter((c) => c.url.pathname === "/v1/default/banks")[0]?.auth).toBe(
      "Bearer file-token-value",
    );
    const status = await run("status", { tokenFile, json: true });
    expect(`${res.out}${status.out}${status.err}`).not.toContain("file-token-value");
    const unreadable = await run("forget", {
      session: SESSION,
      dryRun: true,
      tokenFile: join(stateDir, "missing"),
    });
    expect(unreadable.err).toContain("cannot read --token-file (ENOENT)");
    expect(unreadable.exit).toBe(1);
  });

  it("fails an empty --token-file instead of sending no token (G5)", async () => {
    serve(healthy);
    const tokenFile = join(stateDir, "token");
    writeFileSync(tokenFile, "  \n", { mode: 0o600 });
    const { run } = boot({});
    const res = await run("doctor", { tokenFile });
    expect(res.out).not.toContain("PASS token source");
    expect(`${res.out}${res.err}`).toContain("--token-file is empty");
    expect(res.exit).toBe(1);
    expect(calls).toEqual([]);
  });

  it("warns about an unresolved SecretRef, an old server and queued retains", async () => {
    serve({
      ...healthy,
      "GET /version": () => ({ json: { api_version: "1.1.9", features: {} } }),
    });
    queueItem("dev", "openclaw:x:run:1");
    const { run } = boot({
      pluginConfig: {
        hindsightApiUrl: "http://hindsight.test",
        allowInsecureHttp: true,
        hindsightApiToken: { source: "file", provider: "f", id: "/x" },
      },
    });
    const res = await run("doctor");
    expect(res.out).toContain("WARN token source: a SecretRef this CLI process does not resolve");
    expect(res.out).toContain("fix: pass --token-file <path>");
    expect(res.out).toContain("WARN server version: 1.1.9");
    expect(res.out).toContain("WARN retain queue: 1 pending");
    expect(res.exit).toBe(0);
  });

  it("fails an unreachable server with the fix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<AnyFn>(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { run } = boot({});
    const res = await run("doctor");
    expect(res.out).toContain("FAIL reachable: cannot reach http://hindsight.test");
    expect(res.out).toContain("fix: check hindsightApiUrl");
    expect(res.exit).toBe(1);
  });
});

const docs =
  (bank: string, ids: string[]): Route =>
  () => ({
    json: {
      items: ids.map((id) => ({
        id,
        bank_id: bank,
        memory_unit_count: 3,
        updated_at: "2026-11-11",
      })),
      total: ids.length,
      limit: 100,
      offset: 0,
    },
  });
const deleteRoute = (): Route => (url) => ({
  json: {
    success: true,
    message: "ok",
    document_id: decodeURIComponent(url.pathname.split("/").pop()!),
    memory_units_deleted: 3,
  },
});

describe("openclaw hindsight forget", () => {
  const ownerDocs = [
    runDocumentId(SESSION, "r1"),
    runDocumentId(SESSION, "r2"),
    // Same text in another session's id must not match: the prefix is exact.
    runDocumentId("agent:dev:telegram:direct:420", "r1"),
    "openclaw-flush:abc",
  ];

  function forgetRoutes() {
    return {
      [`GET ${documentsPath("dev")}`]: docs("dev", ownerDocs),
      [`GET ${documentsPath(CONV_BANK)}`]: docs(CONV_BANK, [runDocumentId(SESSION, "r3")]),
      [`DELETE ${documentsPath("dev")}/${encodeURIComponent(runDocumentId(SESSION, "r1"))}`]:
        deleteRoute(),
      [`DELETE ${documentsPath("dev")}/${encodeURIComponent(runDocumentId(SESSION, "r2"))}`]:
        deleteRoute(),
      [`DELETE ${documentsPath(CONV_BANK)}/${encodeURIComponent(runDocumentId(SESSION, "r3"))}`]:
        deleteRoute(),
    };
  }

  it("dry run lists the session's documents in its owner and conversation banks, deletes none", async () => {
    serve(forgetRoutes());
    const { run, asked } = boot({});
    const res = await run("forget", { session: SESSION, dryRun: true });
    expect(res.exit).toBe(0);
    expect(res.out).toContain(`dev  ${runDocumentId(SESSION, "r1")}`);
    expect(res.out).toContain(`dev  ${runDocumentId(SESSION, "r2")}`);
    expect(res.out).toContain(`${CONV_BANK}  ${runDocumentId(SESSION, "r3")}`);
    expect(res.out).not.toContain("direct:420");
    expect(res.out).not.toContain("openclaw-flush");
    expect(res.out).toContain(
      "Dry run: 3 documents (9 memory units) would be deleted; nothing was deleted.",
    );
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(asked).toEqual([]);
    // The search narrows by the exact prefix on the server and again here.
    expect(calls.find((c) => c.method === "GET")?.url.searchParams.get("q")).toBe(PREFIX);
  });

  it("asks before deleting and deletes nothing when the answer is no", async () => {
    serve(forgetRoutes());
    const { run, asked } = boot({ confirm: false });
    const res = await run("forget", { session: SESSION });
    expect(asked).toEqual([
      "Delete 3 documents (9 memory units) from Hindsight? This cannot be undone. [y/N] ",
    ]);
    expect(res.out).toContain("Nothing deleted.");
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(res.exit).toBe(1);
  });

  it("deletes after a yes, and reports what Hindsight removed", async () => {
    serve(forgetRoutes());
    const { run } = boot({ confirm: true });
    const res = await run("forget", { session: SESSION });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(3);
    expect(res.out).toContain("Deleted 3 documents (9 memory units).");
    expect(res.exit).toBe(0);
  });

  it("refuses outside a terminal without --yes, and --yes skips the question", async () => {
    serve(forgetRoutes());
    const noTty = boot({ tty: false });
    const refused = await noTty.run("forget", { session: SESSION });
    expect(refused.err).toContain("not a terminal: pass --yes to delete, or --dry-run to list");
    expect(refused.exit).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    const yes = boot({ tty: false });
    const res = await yes.run("forget", { session: SESSION, yes: true });
    expect(yes.asked).toEqual([]);
    expect(res.out).toContain("Deleted 3 documents");
  });

  it("refuses while the retain queue still holds a copy of the session", async () => {
    serve(forgetRoutes());
    queueItem("dev", runDocumentId(SESSION, "r9"));
    const { run } = boot({ confirm: true });
    const res = await run("forget", { session: SESSION, yes: true });
    expect(res.err).toContain("1 retain of this session is still queued");
    expect(res.exit).toBe(1);
    expect(calls).toEqual([]);
  });

  it("refuses when the retain queue cannot be read (G4)", async () => {
    serve(forgetRoutes());
    // A directory where the queue file should be: reading it fails with EISDIR.
    mkdirSync(retainQueuePath(stateDir), { recursive: true });
    const { run } = boot({ confirm: true });
    const res = await run("forget", { session: SESSION, yes: true });
    expect(res.err).toContain("forget: cannot read the retain queue");
    expect(res.err).toContain("a queued copy could bring the text back after the delete");
    expect(res.exit).toBe(1);
    expect(calls).toEqual([]);
  });

  it("refuses a bank id of . or .. (G8)", async () => {
    serve(forgetRoutes());
    const { run } = boot({});
    for (const bank of [".", "..", " "]) {
      const res = await run("forget", { session: SESSION, bank, dryRun: true });
      expect(res.err).toContain("forget: --bank must be a bank id");
      expect(res.exit).toBe(1);
    }
    expect(calls).toEqual([]);
  });

  it("says when it stops listing at the page limit (G8)", async () => {
    serve({
      [`GET ${documentsPath("dev")}`]: (url) => {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return docs(
          "dev",
          Array.from({ length: 100 }, (_, i) => runDocumentId(SESSION, `r${offset + i}`)),
        )(url);
      },
      [`GET ${documentsPath(CONV_BANK)}`]: docs(CONV_BANK, []),
    });
    const { run } = boot({});
    const res = await run("forget", { session: SESSION, dryRun: true });
    expect(res.err).toContain(
      "forget: stopped listing dev after 10000 documents; run forget again after this one to find the rest",
    );
  });

  it("uses --bank and --agent when given, and needs an agent for a non-agent key", async () => {
    serve({ [`GET ${documentsPath("shared")}`]: docs("shared", []) });
    const { run } = boot({});
    const res = await run("forget", { session: SESSION, bank: "shared", dryRun: true });
    expect(res.out).toContain("No documents of this session found in: shared");
    expect(calls.map((c) => c.url.pathname)).toEqual([documentsPath("shared")]);
    const bare = await run("forget", { session: "main", dryRun: true });
    expect(bare.err).toContain("cannot tell the agent from this session key; pass --agent");
    expect(bare.exit).toBe(1);
  });

  it("pages through a long listing and treats a missing bank as empty", async () => {
    const many = Array.from({ length: 150 }, (_, i) => runDocumentId(SESSION, `r${i}`));
    serve({
      [`GET ${documentsPath("dev")}`]: (url) => {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return docs("dev", many.slice(offset, offset + limit))(url);
      },
      [`GET ${documentsPath(CONV_BANK)}`]: () => ({
        status: 404,
        json: { detail: `Bank '${CONV_BANK}' not found` },
      }),
    });
    const { run } = boot({});
    const res = await run("forget", { session: SESSION, dryRun: true });
    expect(res.out).toContain("Dry run: 150 documents (450 memory units) would be deleted");
  });

  it("reports a failed delete and exits 1", async () => {
    const routes = forgetRoutes();
    routes[`DELETE ${documentsPath("dev")}/${encodeURIComponent(runDocumentId(SESSION, "r2"))}`] =
      () => ({ status: 500, json: {} });
    serve(routes);
    const { run } = boot({});
    const res = await run("forget", { session: SESSION, yes: true });
    expect(res.out).toContain("Deleted 2 documents (6 memory units).");
    expect(res.err).toContain(
      `could not delete ${runDocumentId(SESSION, "r2")} from dev: Hindsight delete document failed: HTTP 500`,
    );
    expect(res.exit).toBe(1);
  });
});
