import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { HindsightClient, HindsightHttpError, isBankNotFound } from "./client.js";
import {
  type HindsightConfig,
  hindsightConfigSchema,
  PLUGIN_ID,
  readPluginConfigEntry,
} from "./config.js";
import { sessionDocumentPrefix } from "./document-ids.js";
import { type QueuedRetain, readQueueFile, retainQueuePath } from "./retain-queue.js";
import { conversationBankId, ownerBankId } from "./routing.js";

/**
 * `openclaw hindsight status | doctor | forget`. Runs in the CLI process, not the Gateway: it reads
 * the plugin's config from the host's config snapshot, talks to Hindsight directly, and only reads
 * the Gateway's retain queue file (the Gateway owns it). Output never carries the token.
 */

export const CLI_COMMAND = "hindsight";
export const CLI_DESCRIPTOR = {
  name: CLI_COMMAND,
  description: "Inspect and maintain Hindsight memory (status, doctor, forget)",
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
  deps: { runtime?: CliRuntime } = {},
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
      io.log(`Memory slot: ${memorySlot() ?? "(not set)"}`);
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
    const slot = memorySlot();
    if (slot === PLUGIN_ID) {
      report("PASS", "memory slot", `${PLUGIN_ID} owns plugins.slots.memory`);
    } else {
      report(
        "WARN",
        "memory slot",
        slot
          ? `${slot} owns plugins.slots.memory, so this plugin's provider runtime is not used`
          : "plugins.slots.memory is not set",
        `openclaw config set plugins.slots.memory ${PLUGIN_ID}`,
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
    const agent = opts.agent?.trim() || /^agent:([^:]+):/.exec(session)?.[1];
    if (!opts.bank && !agent) {
      io.error(
        "forget: cannot tell the agent from this session key; pass --agent <id> or --bank <id>",
      );
      io.exit(1);
      return;
    }
    const banks = opts.bank
      ? [opts.bank]
      : [
          ...new Set([
            ownerBankId(agent!, config.agentBankMap),
            conversationBankId(agent!, session, config.agentBankMap),
          ]),
        ];
    const prefix = sessionDocumentPrefix(session);
    // A queued copy would be sent again after the delete and bring the text back.
    const queued = queueEntries().entries.filter(
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
    },
    { descriptors: [CLI_DESCRIPTOR] },
  );
}
