import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { type CommandLike, registerAdminCommands } from "./cli-admin.js";
import { registerSidecarCommands } from "./cli-sidecar.js";
import {
  HindsightClient,
  HindsightHttpError,
  type HindsightRecallResult,
  isBankNotFound,
} from "./client.js";
import {
  autoRecallRequest,
  configForAgent,
  type HindsightConfig,
  hindsightConfigSchema,
  PLUGIN_ID,
  RECALL_TYPES,
  type RecallType,
  readPluginConfigEntry,
} from "./config.js";
import { sessionDocumentPrefix } from "./document-ids.js";
import {
  appendQueueTombstone,
  type QueuedRetain,
  readQueueFile,
  retainQueuePath,
} from "./retain-queue.js";
import { conversationBankId, ownerBankId } from "./routing.js";
import { memorySlotIsSet, resolveSlotRole, slotDoctorLine } from "./slot-mode.js";
import { extractRecallQuery } from "./transcript.js";

/**
 * `openclaw hindsight status | doctor | recall | queue | forget | directives | memory | consolidate`. Runs in the CLI process, not the Gateway: it reads
 * the plugin's config from the host's config snapshot, talks to Hindsight directly, and only reads
 * the Gateway's retain queue file (the Gateway owns it; `queue --drop` only appends a tombstone
 * line, which the Gateway's queue honors). Output never carries the token.
 */

export const CLI_COMMAND = "hindsight";
export const CLI_DESCRIPTOR = {
  name: CLI_COMMAND,
  description:
    "Inspect and maintain Hindsight memory (status, doctor, recall, queue, forget, directives, memory, consolidate, export, sync-memory-files)",
  hasSubcommands: true,
} as const;
/** Hindsight version this release was tested against. */
export const TESTED_HINDSIGHT_VERSION = "1.2.1";
const LIST_PAGE = 100;
const MAX_LIST_PAGES = 100;

export type CliRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
  isTTY: boolean;
  confirm: (question: string) => Promise<boolean>;
};

function defaultCliRuntime(): CliRuntime {
  return {
    log: (...args) => defaultRuntime.log(...args),
    error: (...args) => defaultRuntime.error(...args),
    exit: (code) => defaultRuntime.exit(code),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^(y|yes)$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** True when this build's manifest declares kind memory (the kind-less test build does not). */
export function manifestHasMemoryKind(): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { kind?: unknown };
    const kind = manifest.kind;
    return kind === "memory" || (Array.isArray(kind) && kind.includes("memory"));
  } catch {
    return true;
  }
}

function packageInfo(): { name: string; version: string } {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      name: typeof pkg.name === "string" ? pkg.name : "unknown",
      version: typeof pkg.version === "string" ? pkg.version : "unknown",
    };
  } catch {
    return { name: "@etzelm/openclaw-memory-hindsight", version: "unknown" };
  }
}

/** Short stable id of a queued item (bank and document id), for `queue --drop`. */
export function queueItemId(bankId: string, documentId: string): string {
  return createHash("sha256").update(`${bankId}\n${documentId}`).digest("hex").slice(0, 12);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Numeric compare of dotted versions; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

const clientFor = (config: HindsightConfig) =>
  new HindsightClient({
    resolveEndpoint: () => ({
      apiUrl: config.apiUrl,
      ...(config.apiToken ? { apiToken: config.apiToken } : {}),
    }),
    userAgent: "openclaw-memory-hindsight-cli",
  });

const byBank = (entries: QueuedRetain[]) => {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    counts[e.bankId] = (counts[e.bankId] ?? 0) + 1;
  }
  return counts;
};

export function registerHindsightCli(
  api: OpenClawPluginApi,
  deps: { runtime?: CliRuntime; hasMemoryKind?: () => boolean } = {},
): void {
  const runtime = (): CliRuntime => deps.runtime ?? defaultCliRuntime();
  const hostConfig = (): unknown => {
    try {
      return api.runtime?.config?.current?.() ?? api.config;
    } catch {
      return api.config;
    }
  };
  const rawPluginConfig = (): unknown =>
    readPluginConfigEntry(hostConfig(), PLUGIN_ID) ?? api.pluginConfig;
  /**
   * The plugin config as this process sees it. `tokenFile` replaces the token: the CLI does not
   * resolve SecretRefs the way the Gateway does, so an operator can pass the token in a file.
   */
  const parseConfig = (
    tokenFile?: string,
  ): { config: HindsightConfig; tokenFromFile: boolean } | { error: string } => {
    let raw = rawPluginConfig();
    if (tokenFile) {
      let token: string;
      try {
        token = readFileSync(tokenFile, "utf8").trim();
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return { error: `cannot read --token-file (${typeof code === "string" ? code : "error"})` };
      }
      if (!token) {
        // An empty token means "no token": the requests would go out unauthenticated.
        return { error: "--token-file is empty" };
      }
      raw = { ...asOptionalRecord(raw), hindsightApiToken: token };
    }
    try {
      return { config: hindsightConfigSchema.parse(raw), tokenFromFile: Boolean(tokenFile) };
    } catch (error) {
      return { error: formatErrorMessage(error) };
    }
  };
  const memorySlot = (): string | undefined => {
    const slots = asOptionalRecord(
      asOptionalRecord(asOptionalRecord(hostConfig())?.plugins)?.slots,
    );
    return typeof slots?.memory === "string" ? slots.memory : undefined;
  };
  const queueEntries = (): { entries: QueuedRetain[]; skipped: number; error?: string } => {
    try {
      const stateDir = api.runtime?.state?.resolveStateDir?.();
      if (!stateDir) {
        return { entries: [], skipped: 0, error: "the host gave no state dir" };
      }
      return readQueueFile(retainQueuePath(stateDir));
    } catch (error) {
      return { entries: [], skipped: 0, error: formatErrorMessage(error) };
    }
  };

  async function status(opts: { json?: boolean; tokenFile?: string }) {
    const io = runtime();
    const parsed = parseConfig(opts.tokenFile);
    if ("error" in parsed) {
      io.error(`memory-hindsight: config invalid (${parsed.error}); run openclaw hindsight doctor`);
      io.exit(1);
      return;
    }
    const { config } = parsed;
    const client = clientFor(config);
    const reachable = await client.healthy();
    const serverVersion = reachable ? await client.version().catch(() => undefined) : undefined;
    const queue = queueEntries();
    const pkg = packageInfo();
    const counts = byBank(queue.entries);
    const role = resolveSlotRole({
      mode: config.slotMode,
      hostConfig: hostConfig(),
      pluginId: PLUGIN_ID,
    }).role;
    if (opts.json) {
      io.log(
        JSON.stringify(
          {
            plugin: pkg.name,
            version: pkg.version,
            apiUrl: config.apiUrl,
            reachable,
            serverVersion: serverVersion ?? null,
            memorySlot: memorySlot() ?? null,
            slotRole: role,
            memoryMode: config.memoryMode,
            autoRecall: config.autoRecall,
            autoRetain: config.autoRetain,
            queue: { pending: queue.entries.length, byBank: counts, error: queue.error ?? null },
          },
          null,
          2,
        ),
      );
    } else {
      const banks = Object.entries(counts)
        .map(([bank, n]) => `${bank}: ${n}`)
        .join(", ");
      io.log(`Plugin: ${pkg.name} ${pkg.version}`);
      io.log(
        `Hindsight: ${config.apiUrl} (${reachable ? `reachable, API ${serverVersion ?? "version unknown"}` : "unreachable"})`,
      );
      io.log(`Memory slot: ${memorySlot() ?? "(not set)"} (this plugin: ${role})`);
      io.log(
        `Mode: ${config.memoryMode} (auto-recall ${config.autoRecall ? "on" : "off"}, auto-retain ${config.autoRetain ? "on" : "off"})`,
      );
      io.log(
        queue.error
          ? `Retain queue: not readable (${queue.error})`
          : `Retain queue: ${queue.entries.length} pending${banks ? ` (${banks})` : ""}`,
      );
    }
    if (!reachable) {
      io.exit(1);
    }
  }

  async function doctor(opts: { tokenFile?: string } = {}) {
    const io = runtime();
    let failed = false;
    const report = (level: "PASS" | "WARN" | "FAIL", check: string, text: string, fix?: string) => {
      io.log(`${level} ${check}: ${text}`);
      if (fix) {
        io.log(`     fix: ${fix}`);
      }
      failed ||= level === "FAIL";
    };
    const parsed = parseConfig(opts.tokenFile);
    if ("error" in parsed) {
      report(
        "FAIL",
        "config",
        parsed.error,
        `openclaw config set plugins.entries.${PLUGIN_ID}.config.<key> <value> (see the README's Configuration table)`,
      );
      io.exit(1);
      return;
    }
    const { config } = parsed;
    report("PASS", "config", `valid (${config.apiUrl}, mode ${config.memoryMode})`);
    // Replace or sidecar (slot-mode.ts): a sidecar beside memory-core is a supported setup.
    const slotRole = resolveSlotRole({
      mode: config.slotMode,
      hostConfig: hostConfig(),
      pluginId: PLUGIN_ID,
    });
    const slotLine = slotDoctorLine(slotRole, PLUGIN_ID);
    if (
      slotRole.role === "owner" &&
      memorySlotIsSet(hostConfig()) &&
      !(deps.hasMemoryKind ?? manifestHasMemoryKind)()
    ) {
      report(
        "FAIL",
        "memory slot",
        "this build has no manifest kind memory, so the host refuses its memory runtime while plugins.slots.memory names it",
        "install the regular package, or: openclaw config set plugins.slots.memory memory-core",
      );
    } else {
      report(
        slotLine.status,
        "memory slot",
        slotLine.text.replace(/^memory slot: /, ""),
        ...(slotLine.status === "FAIL"
          ? [
              config.slotMode === "replace"
                ? `openclaw config set plugins.slots.memory ${PLUGIN_ID}`
                : "openclaw config set plugins.slots.memory memory-core",
            ]
          : []),
      );
    }
    const raw = asOptionalRecord(rawPluginConfig());
    if (parsed.tokenFromFile) {
      report("PASS", "token source", "--token-file (not shown)");
    } else if (config.apiToken) {
      report("PASS", "token source", "plugin config (not shown)");
    } else if (asOptionalRecord(raw?.hindsightApiToken)) {
      report(
        "WARN",
        "token source",
        "a SecretRef this CLI process does not resolve; requests from here go unauthenticated",
        "pass --token-file <path> with the token (the Gateway resolves the SecretRef itself)",
      );
    } else {
      report("WARN", "token source", "none set; fine only if Hindsight runs without auth");
    }
    const client = clientFor(config);
    if (!(await client.healthy())) {
      report(
        "FAIL",
        "reachable",
        `cannot reach ${config.apiUrl}/health`,
        "check hindsightApiUrl and that Hindsight is running",
      );
      io.log("SKIP server version, auth: Hindsight is not reachable");
    } else {
      report("PASS", "reachable", `${config.apiUrl}/health answered`);
      const version = await client.version().catch(() => undefined);
      if (!version) {
        report("WARN", "server version", "GET /version gave no api_version");
      } else if (compareVersions(version, TESTED_HINDSIGHT_VERSION) < 0) {
        report(
          "WARN",
          "server version",
          `${version} is older than ${TESTED_HINDSIGHT_VERSION}, the version this release is tested against`,
          `upgrade Hindsight to ${TESTED_HINDSIGHT_VERSION} or later`,
        );
      } else {
        report("PASS", "server version", version);
      }
      try {
        await client.listBanks();
        report("PASS", "auth", "the token is accepted");
      } catch (error) {
        const httpStatus = error instanceof HindsightHttpError ? error.status : undefined;
        report(
          "FAIL",
          "auth",
          httpStatus ? `Hindsight answered HTTP ${httpStatus}` : formatErrorMessage(error),
          httpStatus === 401 || httpStatus === 403
            ? "check hindsightApiToken (and the secret it points to)"
            : undefined,
        );
      }
    }
    const queue = queueEntries();
    if (queue.error) {
      report("WARN", "retain queue", `not readable (${queue.error})`);
    } else if (queue.entries.length > 0) {
      const oldest = Math.min(...queue.entries.map((e) => e.queuedAt));
      const minutes = Math.max(0, Math.round((Date.now() - oldest) / 60_000));
      report(
        "WARN",
        "retain queue",
        `${queue.entries.length} pending, oldest ${minutes} min; the Gateway replays them while Hindsight is reachable`,
      );
    } else {
      report(
        "PASS",
        "retain queue",
        queue.skipped > 0 ? `empty (${plural(queue.skipped, "unreadable line")})` : "empty",
      );
    }
    if (failed) {
      io.exit(1);
    }
  }

  async function forget(opts: {
    session?: string;
    agent?: string;
    bank?: string;
    dryRun?: boolean;
    yes?: boolean;
    tokenFile?: string;
  }) {
    const io = runtime();
    const session = opts.session?.trim();
    if (!session) {
      io.error("forget: --session <key> is required");
      io.exit(1);
      return;
    }
    const parsed = parseConfig(opts.tokenFile);
    if ("error" in parsed) {
      io.error(`forget: config invalid (${parsed.error}); run openclaw hindsight doctor`);
      io.exit(1);
      return;
    }
    const { config } = parsed;
    const bankOpt = opts.bank === undefined ? undefined : opts.bank.trim();
    if (bankOpt !== undefined && (!bankOpt || bankOpt === "." || bankOpt === "..")) {
      // As in agentBankMap: "." and ".." would collapse the request path.
      io.error('forget: --bank must be a bank id (not empty, "." or "..")');
      io.exit(1);
      return;
    }
    const agent = opts.agent?.trim() || /^agent:([^:]+):/.exec(session)?.[1];
    if (!bankOpt && !agent) {
      io.error(
        "forget: cannot tell the agent from this session key; pass --agent <id> or --bank <id>",
      );
      io.exit(1);
      return;
    }
    const banks = bankOpt
      ? [bankOpt]
      : [
          ...new Set([
            ownerBankId(agent!, config.agentBankMap),
            conversationBankId(agent!, session, config.agentBankMap),
          ]),
        ];
    const prefix = sessionDocumentPrefix(session);
    // A queued copy would be sent again after the delete and bring the text back.
    const queue = queueEntries();
    if (queue.error) {
      io.error(
        `forget: cannot read the retain queue (${queue.error}); a queued copy could bring the text back after the delete, so nothing was deleted; check with openclaw hindsight doctor`,
      );
      io.exit(1);
      return;
    }
    const queued = queue.entries.filter(
      (e) => banks.includes(e.bankId) && e.documentId.startsWith(prefix),
    );
    if (queued.length > 0) {
      io.error(
        `forget: ${plural(queued.length, "retain")} of this session ${queued.length === 1 ? "is" : "are"} still queued in the Gateway's retain queue and would be sent again after the delete; run forget again once the queue is empty (openclaw hindsight status shows it)`,
      );
      io.exit(1);
      return;
    }
    const client = clientFor(config);
    const found: Array<{ bank: string; id: string; units: number }> = [];
    try {
      for (const bank of banks) {
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          let items;
          try {
            items = await client.listDocuments(bank, {
              q: prefix,
              limit: LIST_PAGE,
              offset: page * LIST_PAGE,
            });
          } catch (error) {
            if (isBankNotFound(error)) {
              break;
            }
            throw error;
          }
          for (const item of items) {
            if (item.id.startsWith(prefix)) {
              found.push({ bank, id: item.id, units: item.memoryUnits });
            }
          }
          if (items.length < LIST_PAGE) {
            break;
          }
          if (page === MAX_LIST_PAGES - 1) {
            io.error(
              `forget: stopped listing ${bank} after ${MAX_LIST_PAGES * LIST_PAGE} documents; run forget again after this one to find the rest`,
            );
          }
        }
      }
    } catch (error) {
      io.error(`forget: could not list documents: ${formatErrorMessage(error)}`);
      io.exit(1);
      return;
    }
    if (found.length === 0) {
      io.log(`No documents of this session found in: ${banks.join(", ")}`);
      return;
    }
    for (const doc of found) {
      io.log(`${doc.bank}  ${doc.id}  (${plural(doc.units, "memory unit")})`);
    }
    const units = found.reduce((sum, d) => sum + d.units, 0);
    const what = `${plural(found.length, "document")} (${plural(units, "memory unit")})`;
    if (opts.dryRun) {
      io.log(`Dry run: ${what} would be deleted; nothing was deleted.`);
      return;
    }
    if (!opts.yes) {
      if (!io.isTTY) {
        io.error("forget: not a terminal: pass --yes to delete, or --dry-run to list");
        io.exit(1);
        return;
      }
      if (!(await io.confirm(`Delete ${what} from Hindsight? This cannot be undone. [y/N] `))) {
        io.log("Nothing deleted.");
        io.exit(1);
        return;
      }
    }
    let deleted = 0;
    let deletedUnits = 0;
    let failures = 0;
    for (const doc of found) {
      try {
        const result = await client.deleteDocument(doc.bank, doc.id);
        deleted += 1;
        deletedUnits += result?.memoryUnitsDeleted ?? 0;
      } catch (error) {
        failures += 1;
        io.error(
          `forget: could not delete ${doc.id} from ${doc.bank}: ${formatErrorMessage(error)}`,
        );
      }
    }
    io.log(`Deleted ${plural(deleted, "document")} (${plural(deletedUnits, "memory unit")}).`);
    if (failures > 0) {
      io.exit(1);
    }
  }

  /** `recall <query>`: the request auto-recall would send for an agent, and what it would inject. */
  async function recall(
    queryArg: unknown,
    opts: { agent?: string; bank?: string; types?: string; json?: boolean; tokenFile?: string },
  ) {
    const io = runtime();
    const fail = (message: string) => {
      io.error(`recall: ${message}`);
      io.exit(1);
    };
    const query = typeof queryArg === "string" ? queryArg.trim() : "";
    if (!query) {
      fail("a query is required");
      return;
    }
    let types: RecallType[] | undefined;
    if (opts.types !== undefined) {
      const names = opts.types
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      const parsedTypes = names.map((name) => RECALL_TYPES.find((type) => type === name));
      if (names.length === 0 || parsedTypes.some((type) => type === undefined)) {
        fail(`--types must be a comma list of ${RECALL_TYPES.join(", ")}`);
        return;
      }
      types = [...new Set(parsedTypes as RecallType[])];
    }
    const bankOpt = opts.bank === undefined ? undefined : opts.bank.trim();
    if (bankOpt !== undefined && (!bankOpt || bankOpt === "." || bankOpt === "..")) {
      fail('--bank must be a bank id (not empty, "." or "..")');
      return;
    }
    const parsed = parseConfig(opts.tokenFile);
    if ("error" in parsed) {
      fail(`config invalid (${parsed.error}); run openclaw hindsight doctor`);
      return;
    }
    const agent = normalizeAgentId(opts.agent?.trim() || "main");
    const agentConfig = configForAgent(parsed.config, agent);
    const config = types ? { ...agentConfig, recallTypes: types } : agentConfig;
    const bank = bankOpt ?? ownerBankId(agent, config.agentBankMap);
    const sent = extractRecallQuery(query, query, config.recallQueryShaping) || query;
    const request = autoRecallRequest(config, sent);
    let results: HindsightRecallResult[];
    try {
      results = await clientFor(config).recall(bank, sent, {
        ...request.options,
        signal: AbortSignal.timeout(config.recallTimeoutMs),
      });
    } catch (error) {
      if (!isBankNotFound(error)) {
        fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
        return;
      }
      results = [];
    }
    const injected = config.recallTopK
      ? Math.min(config.recallTopK, results.length)
      : results.length;
    if (opts.json) {
      io.log(
        JSON.stringify(
          {
            bank,
            agent,
            injected,
            results: results.map((r) => ({
              id: r.id,
              type: r.type ?? null,
              score: r.scores?.final ?? null,
              text: r.text,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    const off = config.autoRecall ? "" : " (auto-recall is off for this agent)";
    if (results.length === 0) {
      io.log(`Bank: ${bank} (agent ${agent}); no memories${off}`);
      return;
    }
    const cap = config.recallTopK ? ` (recallTopK ${config.recallTopK})` : "";
    io.log(
      `Bank: ${bank} (agent ${agent}); ${plural(results.length, "result")}, auto-recall would inject ${injected}${cap}${off}`,
    );
    results.forEach((r, i) => {
      const score = typeof r.scores?.final === "number" ? r.scores.final.toFixed(3) : "-";
      const line = `${i + 1}. [${r.type ?? "?"}] score ${score}  ${r.text.replace(/\s+/g, " ").trim()}`;
      io.log(i < injected ? line : `   (not injected) ${line}`);
    });
  }

  /** `queue --list | --drop <id>`: the Gateway's retain queue, never with memory text. */
  async function queueCommand(opts: { list?: boolean; drop?: string; yes?: boolean }) {
    const io = runtime();
    const fail = (message: string) => {
      io.error(`queue: ${message}`);
      io.exit(1);
    };
    const drop = opts.drop?.trim();
    if (Boolean(opts.list) === Boolean(drop)) {
      fail("pass --list, or --drop <id>");
      return;
    }
    const stateDir = api.runtime?.state?.resolveStateDir?.();
    const read = queueEntries();
    if (!stateDir || read.error) {
      fail(`cannot read the retain queue (${read.error ?? "the host gave no state dir"})`);
      return;
    }
    if (opts.list) {
      if (read.entries.length === 0) {
        io.log("Retain queue: empty");
        return;
      }
      io.log(`Retain queue: ${plural(read.entries.length, "item")}`);
      for (const e of read.entries) {
        io.log(
          `${queueItemId(e.bankId, e.documentId)}  ${e.bankId}  ${e.documentId}  queued ${new Date(e.queuedAt).toISOString()}  ${Buffer.byteLength(JSON.stringify(e), "utf8")} bytes`,
        );
      }
      return;
    }
    const entry = read.entries.find((e) => queueItemId(e.bankId, e.documentId) === drop);
    if (!entry) {
      fail(`no queued item with id ${drop} (see openclaw hindsight queue --list)`);
      return;
    }
    const what = `${drop} (${entry.bankId}, ${entry.documentId})`;
    if (!opts.yes) {
      if (!io.isTTY) {
        fail("not a terminal: pass --yes to drop");
        return;
      }
      if (!(await io.confirm(`Drop queued retain ${what}? It will not be sent. [y/N] `))) {
        io.log("Nothing dropped.");
        io.exit(1);
        return;
      }
    }
    const filePath = retainQueuePath(stateDir);
    const still = () =>
      readQueueFile(filePath).entries.some(
        (e) => e.bankId === entry.bankId && e.documentId === entry.documentId,
      );
    try {
      // A Gateway rewrite (atomic rename) at the same moment can lose the append; check, retry once.
      for (let attempt = 0; attempt < 2 && still(); attempt++) {
        appendQueueTombstone(filePath, entry);
      }
      if (still()) {
        fail("the queue file changed during the drop; run the command again");
        return;
      }
    } catch (error) {
      fail(`could not write the retain queue (${formatErrorMessage(error)})`);
      return;
    }
    io.log(`Dropped ${what}.`);
    io.log(
      "A running Gateway forgets it before its next replay step; a replay already sending it is not stopped.",
    );
  }

  if (typeof api.registerCli !== "function") {
    return;
  }
  api.registerCli(
    ({ program }) => {
      const root = program.command(CLI_COMMAND).description(CLI_DESCRIPTOR.description);
      root
        .command("status")
        .description("Show the Hindsight server, memory slot, mode and retain queue")
        .option("--json", "Print JSON")
        .option(
          "--token-file <path>",
          "Read the Hindsight token from this file (for a SecretRef the CLI does not resolve)",
        )
        .action(async (opts: { json?: boolean; tokenFile?: string }) => status(opts));
      root
        .command("doctor")
        .description(
          "Check config, slot, token, server, auth and queue, with a fix for each failure",
        )
        .option(
          "--token-file <path>",
          "Read the Hindsight token from this file (for a SecretRef the CLI does not resolve)",
        )
        .action(async (opts: { tokenFile?: string }) => doctor(opts));
      root
        .command("recall <query>")
        .description(
          "Run the recall auto-recall would send for an agent (read-only) and show what it would inject, with scores",
        )
        .option("--agent <id>", "Agent whose config and bank to use (default main)")
        .option("--bank <id>", "Recall from this bank instead of the agent's owner bank")
        .option(
          "--types <list>",
          "Comma list of world, experience, observation; replaces recallTypes",
        )
        .option("--json", "Print JSON")
        .option(
          "--token-file <path>",
          "Read the Hindsight token from this file (for a SecretRef the CLI does not resolve)",
        )
        .action(async (query: unknown, opts: Parameters<typeof recall>[1]) => recall(query, opts));
      root
        .command("queue")
        .description(
          "List the Gateway's retain queue (no memory text), or drop one queued item so it is never sent",
        )
        .option("--list", "List queued items: id, bank, document id, time, size")
        .option("--drop <id>", "Drop the item with this id (from --list)")
        .option("--yes", "Drop without asking (needed outside a terminal)")
        .action(async (opts: Parameters<typeof queueCommand>[0]) => queueCommand(opts));
      root
        .command("forget")
        .description(
          "Delete a session's auto-retained documents (and their memory units) from Hindsight. Memories saved with hindsight_retain or the pre-compaction flush are not tied to a session and stay",
        )
        .requiredOption("--session <key>", "Session key whose run documents to delete")
        .option("--agent <id>", "Agent id, when the session key does not start with agent:<id>:")
        .option(
          "--bank <id>",
          "Search this bank only, instead of the agent's owner and conversation banks",
        )
        .option("--dry-run", "List what would be deleted and delete nothing")
        .option("--yes", "Delete without asking (needed outside a terminal)")
        .option(
          "--token-file <path>",
          "Read the Hindsight token from this file (for a SecretRef the CLI does not resolve)",
        )
        .action(async (opts: Parameters<typeof forget>[0]) => forget(opts));
      // SAFETY: CommandLike names only Commander methods the host's program has.
      registerAdminCommands(root as unknown as CommandLike, {
        io: runtime,
        parseConfig,
        clientFor,
      });
      registerSidecarCommands(root as unknown as CommandLike, {
        io: runtime,
        parseConfig,
        clientFor,
        hostConfig,
        stateDir: () => api.runtime?.state?.resolveStateDir?.(),
      });
    },
    { descriptors: [CLI_DESCRIPTOR] },
  );
}
