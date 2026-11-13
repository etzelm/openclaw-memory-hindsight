import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { AdminIo, CommandLike } from "./cli-admin.js";
import type { HindsightClient } from "./client.js";
import { type HindsightConfig, PLUGIN_ID } from "./config.js";
import {
  buildBankExport,
  createHttpExportSource,
  EXPORT_DEFAULT_MAX_ITEMS,
  EXPORT_TYPES,
  type ExportSource,
  type ExportType,
  writeBankExport,
} from "./export.js";
import {
  type MemoryFileSyncService,
  parseLegacyState,
  readSyncState,
  syncMemoryFiles,
  writeSyncState,
} from "./memory-file-sync.js";
import { ownerBankId } from "./routing.js";

/**
 * `openclaw hindsight export` and `openclaw hindsight sync-memory-files`. Same rules as the other
 * operator commands: config from the host snapshot, Hindsight called directly, the token never
 * printed.
 */

export type SidecarCliDeps = {
  io: () => AdminIo;
  parseConfig: (tokenFile?: string) => { config: HindsightConfig } | { error: string };
  clientFor: (config: HindsightConfig) => HindsightClient;
  hostConfig: () => unknown;
  stateDir: () => string | undefined;
  /** Tests pass a fake; default reads the API with the config's URL and token. */
  exportSource?: (config: HindsightConfig) => ExportSource;
  /** Tests pass a fake; default retains through the client (no offline queue in the CLI). */
  syncService?: (config: HindsightConfig) => MemoryFileSyncService;
};

type ExportOpts = {
  out?: string;
  agent?: string;
  bank?: string;
  types?: string;
  mentalModels?: boolean;
  maxItems?: string;
  overwrite?: boolean;
  tokenFile?: string;
};

type SyncOpts = {
  agent?: string;
  dryRun?: boolean;
  importLegacyState?: string;
  tokenFile?: string;
};

export function syncStatePath(stateDir: string, agentId: string): string {
  return path.join(
    stateDir,
    "plugins",
    PLUGIN_ID,
    "memory-file-sync",
    `${normalizeAgentId(agentId)}.json`,
  );
}

export function createSidecarCommands(deps: SidecarCliDeps) {
  const setup = (command: string, tokenFile?: string) => {
    const io = deps.io();
    const fail = (message: string) => {
      io.error(`${command}: ${message}`);
      io.exit(1);
      return null;
    };
    const parsed = deps.parseConfig(tokenFile);
    if ("error" in parsed) {
      return fail(`config invalid (${parsed.error}); run openclaw hindsight doctor`);
    }
    return { io, fail, config: parsed.config };
  };

  async function exportBank(opts: ExportOpts) {
    const ctx = setup("export", opts.tokenFile);
    if (!ctx) {
      return;
    }
    if (!opts.out?.trim()) {
      return ctx.fail("--out <dir> is required");
    }
    const bankOpt = opts.bank?.trim();
    if (opts.bank !== undefined && (!bankOpt || bankOpt === "." || bankOpt === "..")) {
      return ctx.fail('--bank must be a bank id (not empty, "." or "..")');
    }
    const types = (opts.types ?? EXPORT_TYPES.join(","))
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const unknown = types.filter((t) => !(EXPORT_TYPES as readonly string[]).includes(t));
    if (unknown.length || types.length === 0) {
      return ctx.fail(
        `--types takes ${EXPORT_TYPES.join(", ")} (got ${unknown.join(", ") || "none"})`,
      );
    }
    const maxItems = opts.maxItems === undefined ? EXPORT_DEFAULT_MAX_ITEMS : Number(opts.maxItems);
    if (!Number.isInteger(maxItems) || maxItems < 1) {
      return ctx.fail("--max-items must be a positive integer");
    }
    const agent = normalizeAgentId(opts.agent?.trim() || "main");
    const bankId = bankOpt ?? ownerBankId(agent, ctx.config.agentBankMap);
    const source =
      deps.exportSource?.(ctx.config) ??
      createHttpExportSource({ apiUrl: ctx.config.apiUrl, apiToken: ctx.config.apiToken });
    try {
      const { files, summary } = await buildBankExport({
        source,
        bankId,
        types: types as ExportType[],
        mentalModels: Boolean(opts.mentalModels),
        maxItems,
      });
      const target = await writeBankExport({
        outDir: opts.out,
        bankId,
        files,
        overwrite: Boolean(opts.overwrite),
      });
      for (const t of summary.types) {
        ctx.io.log(
          `${t.file}: ${t.count}${t.truncated ? ` of ${t.total} (stopped at --max-items)` : ""}`,
        );
      }
      if (summary.mentalModels) {
        ctx.io.log(`mental-models/: ${summary.mentalModels.count}`);
      }
      ctx.io.log(`Exported bank ${bankId} to ${target}`);
    } catch (error) {
      return ctx.fail(formatErrorMessage(error));
    }
  }

  async function syncFiles(opts: SyncOpts) {
    const ctx = setup("sync-memory-files", opts.tokenFile);
    if (!ctx) {
      return;
    }
    const stateDir = deps.stateDir();
    if (!stateDir) {
      return ctx.fail("the host gave no state dir");
    }
    const agent = normalizeAgentId(opts.agent?.trim() || "main");
    const bankId = ownerBankId(agent, ctx.config.agentBankMap);
    const statePath = syncStatePath(stateDir, agent);
    if (opts.importLegacyState) {
      let legacy;
      try {
        legacy = parseLegacyState(readFileSync(opts.importLegacyState, "utf8"));
      } catch (error) {
        return ctx.fail(`cannot read ${opts.importLegacyState} (${formatErrorMessage(error)})`);
      }
      const merged = { ...legacy, ...(await readSyncState(statePath)) };
      if (!opts.dryRun) {
        await writeSyncState(statePath, merged);
      }
      ctx.io.log(
        `${opts.dryRun ? "Would import" : "Imported"} ${Object.keys(legacy).length} finished files from ${opts.importLegacyState}`,
      );
    }
    let workspaceDir: string;
    try {
      workspaceDir = resolveAgentWorkspaceDir(
        deps.hostConfig() as Parameters<typeof resolveAgentWorkspaceDir>[0],
        agent,
      );
    } catch (error) {
      return ctx.fail(`cannot resolve the workspace of ${agent} (${formatErrorMessage(error)})`);
    }
    const client = deps.clientFor(ctx.config);
    const service: MemoryFileSyncService = deps.syncService?.(ctx.config) ?? {
      retainOrQueue: async (bank, item, signal) => {
        await client.retain(bank, item, { async: true, signal });
        return "sent";
      },
      client,
    };
    try {
      const result = await syncMemoryFiles({
        service,
        workspaceDir,
        bankId,
        statePath,
        extraTags: ctx.config.retainTags,
        dryRun: Boolean(opts.dryRun),
      });
      const verb = opts.dryRun ? "would send" : "sent";
      ctx.io.log(
        `${agent} -> bank ${bankId}: ${verb} ${opts.dryRun ? result.plan.retain.length : result.sent}, unchanged ${result.unchanged}, ${opts.dryRun ? "would delete" : "deleted"} ${opts.dryRun ? result.plan.delete.length : result.deleted}, skipped ${result.skipped.length}`,
      );
      if (opts.dryRun) {
        for (const f of result.plan.retain) {
          ctx.io.log(`  send ${f.rel}`);
        }
        for (const rel of result.plan.delete) {
          ctx.io.log(`  delete ${rel}`);
        }
      }
      for (const f of result.failed) {
        ctx.io.error(`  failed ${f.rel}: ${f.error}`);
      }
      if (result.failed.length) {
        ctx.io.exit(1);
      }
    } catch (error) {
      return ctx.fail(formatErrorMessage(error));
    }
  }

  return { exportBank, syncFiles };
}

export function registerSidecarCommands(root: CommandLike, deps: SidecarCliDeps): void {
  const commands = createSidecarCommands(deps);
  root
    .command("export")
    .description("Write a bank's memories (facts, experiences, observations) to markdown files")
    .option("--out <dir>", "Directory to write into; the export goes to <dir>/<bank>/")
    .option("--agent <id>", "Export this agent's owner bank (default main)")
    .option("--bank <id>", "Export this bank instead of an agent's owner bank")
    .option("--types <list>", `Comma-separated memory types (default ${EXPORT_TYPES.join(",")})`)
    .option("--mental-models", "Also write each mental model to mental-models/<name>.md")
    .option(
      "--max-items <n>",
      `Stop each type after n memories (default ${EXPORT_DEFAULT_MAX_ITEMS})`,
    )
    .option("--overwrite", "Replace files in a non-empty target directory")
    .option(
      "--token-file <path>",
      "Read the Hindsight token from this file (for a SecretRef the CLI does not resolve)",
    )
    .action(async (opts: ExportOpts) => commands.exportBank(opts));
  root
    .command("sync-memory-files")
    .description(
      "Retain the agent's MEMORY.md, USER.md and memory/*.md into its owner bank now (what memoryFileSync does on a timer)",
    )
    .option("--agent <id>", "Agent whose workspace is synced (default main)")
    .option("--dry-run", "List what would be sent and deleted; send nothing")
    .option(
      "--import-legacy-state <tsv>",
      "First import the finished files from hindsight-memory-sync.sh's state, so unchanged files are not sent again",
    )
    .option(
      "--token-file <path>",
      "Read the Hindsight token from this file (for a SecretRef the CLI does not resolve)",
    )
    .action(async (opts: SyncOpts) => commands.syncFiles(opts));
}
