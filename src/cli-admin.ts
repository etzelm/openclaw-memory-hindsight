import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  type HindsightClient,
  type HindsightDirective,
  type HindsightMemoryDetail,
  type HindsightOperationStatus,
  TERMINAL_OPERATION_STATUSES,
} from "./client.js";
import type { HindsightConfig } from "./config.js";
import { promptDirectives } from "./directives.js";
import { ownerBankId } from "./routing.js";

/**
 * Bank administration under `openclaw hindsight`: `directives list | add | rm` and
 * `memory show | curate | invalidate` and `consolidate`. Same rules as the
 * other operator commands: config from the host snapshot, Hindsight called directly, the token
 * never printed, and every write shown first and confirmed (outside a terminal only with --yes).
 */

export type AdminIo = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
  isTTY: boolean;
  confirm: (question: string) => Promise<boolean>;
};

export type AdminDeps = {
  io: () => AdminIo;
  /** Waits between operation polls; tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
  parseConfig: (tokenFile?: string) => { config: HindsightConfig } | { error: string };
  clientFor: (config: HindsightConfig) => HindsightClient;
};

type BankOpts = { agent?: string; bank?: string; tokenFile?: string };
type WriteOpts = BankOpts & { dryRun?: boolean; yes?: boolean };

/** The longest directive name and text `directives add` accepts. */
export const MAX_DIRECTIVE_NAME = 200;
export const MAX_DIRECTIVE_CONTENT = 2000;

/** One-line form of a directive for listings. */
export function formatDirective(d: HindsightDirective): string {
  const flags = [
    d.isActive ? "active" : "inactive",
    `priority ${d.priority}`,
    ...(d.tags.length ? [`tags ${d.tags.join(",")}`] : ["global"]),
  ].join(", ");
  return `${d.id}  ${d.name}  (${flags})\n    ${d.content.replace(/\s+/g, " ").trim()}`;
}

/** Asks before a write; false (after saying why) when it must not go ahead. */
const allowed = async (
  io: AdminIo,
  fail: (m: string) => null,
  opts: WriteOpts,
  question: string,
) => {
  if (opts.dryRun) {
    io.log("Dry run: nothing was changed.");
    return false;
  }
  if (opts.yes) {
    return true;
  }
  if (!io.isTTY) {
    fail("not a terminal: pass --yes to go ahead, or --dry-run to preview");
    return false;
  }
  if (!(await io.confirm(`${question} [y/N] `))) {
    io.log("Nothing changed.");
    io.exit(1);
    return false;
  }
  return true;
};

/** The longest replacement text `memory curate --text` accepts. */
export const MAX_MEMORY_TEXT = 8000;

/** Multi-line form of a memory unit for `memory show` and the curate previews. */
export function formatMemory(m: HindsightMemoryDetail): string[] {
  const lines = [
    `${m.id}  [${m.type ?? "?"}]  state ${m.state ?? "valid"}`,
    `  text: ${m.text.replace(/\s+/g, " ").trim()}`,
  ];
  const dated = [
    m.mentionedAt ? `mentioned ${m.mentionedAt}` : "",
    m.occurredStart
      ? `occurred ${m.occurredStart}${m.occurredEnd ? ` to ${m.occurredEnd}` : ""}`
      : "",
    m.editedAt ? `edited ${m.editedAt}` : "",
    m.consolidatedAt ? `consolidated ${m.consolidatedAt}` : "",
  ].filter(Boolean);
  if (dated.length) {
    lines.push(`  ${dated.join(", ")}`);
  }
  if (m.documentId) {
    lines.push(`  document: ${m.documentId}`);
  }
  if (m.tags.length) {
    lines.push(`  tags: ${m.tags.join(", ")}`);
  }
  if (m.entities.length) {
    lines.push(`  entities: ${m.entities.join(", ")}`);
  }
  if (m.invalidationReason) {
    lines.push(`  invalidated because: ${m.invalidationReason}`);
  }
  return lines;
}

/** How often `consolidate --wait` polls, and its default and largest wait. */
export const CONSOLIDATE_POLL_MS = 2000;
export const CONSOLIDATE_DEFAULT_TIMEOUT_S = 600;
export const CONSOLIDATE_MAX_TIMEOUT_S = 3600;

/** One status line for an operation poll. */
export function formatOperation(op: HindsightOperationStatus): string {
  const p = op.progress;
  const done =
    p?.processed !== undefined
      ? ` ${p.processed}${p.total !== undefined ? `/${p.total}` : ""}`
      : "";
  const detail = p?.detail
    ? Object.entries(p.detail)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")
    : "";
  return [
    op.status,
    p?.stage ? `(${p.stage}${done})` : done.trim(),
    detail,
    op.error ? `error: ${op.error}` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

const isTerminal = (status: string) =>
  (TERMINAL_OPERATION_STATUSES as readonly string[]).includes(status);

export function createAdminCommands(deps: AdminDeps) {
  /** Config, client and bank for a command, or null after reporting the problem. */
  const setup = (command: string, opts: BankOpts) => {
    const io = deps.io();
    const fail = (message: string) => {
      io.error(`${command}: ${message}`);
      io.exit(1);
      return null;
    };
    const bankOpt = opts.bank === undefined ? undefined : opts.bank.trim();
    if (bankOpt !== undefined && (!bankOpt || bankOpt === "." || bankOpt === "..")) {
      return fail('--bank must be a bank id (not empty, "." or "..")');
    }
    const parsed = deps.parseConfig(opts.tokenFile);
    if ("error" in parsed) {
      return fail(`config invalid (${parsed.error}); run openclaw hindsight doctor`);
    }
    const agent = normalizeAgentId(opts.agent?.trim() || "main");
    const bank = bankOpt ?? ownerBankId(agent, parsed.config.agentBankMap);
    return { io, fail, bank, client: deps.clientFor(parsed.config) };
  };

  async function directivesList(opts: BankOpts & { all?: boolean; json?: boolean }) {
    const ctx = setup("directives list", opts);
    if (!ctx) {
      return;
    }
    let directives: HindsightDirective[];
    try {
      directives = await ctx.client.listDirectives(ctx.bank, { activeOnly: !opts.all });
    } catch (error) {
      ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
      return;
    }
    const inPrompt = new Set(promptDirectives(directives).map((d) => d.id));
    if (opts.json) {
      ctx.io.log(
        JSON.stringify(
          {
            bank: ctx.bank,
            directives: directives.map((d) => ({ ...d, inPrompt: inPrompt.has(d.id) })),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (directives.length === 0) {
      ctx.io.log(`Bank ${ctx.bank}: no ${opts.all ? "" : "active "}directives`);
      return;
    }
    ctx.io.log(`Bank ${ctx.bank}: ${directives.length} ${opts.all ? "" : "active "}directive(s)`);
    for (const d of directives) {
      ctx.io.log(
        formatDirective(d) + (inPrompt.has(d.id) ? "\n    (listed by promptDirectives)" : ""),
      );
    }
  }

  async function directivesAdd(
    opts: WriteOpts & { name?: string; content?: string; priority?: string; tags?: string },
  ) {
    const ctx = setup("directives add", opts);
    if (!ctx) {
      return;
    }
    const name = opts.name?.trim() ?? "";
    const content = opts.content?.trim() ?? "";
    if (!name || name.length > MAX_DIRECTIVE_NAME) {
      ctx.fail(`--name is required, at most ${MAX_DIRECTIVE_NAME} characters`);
      return;
    }
    if (!content || content.length > MAX_DIRECTIVE_CONTENT) {
      ctx.fail(`--content is required, at most ${MAX_DIRECTIVE_CONTENT} characters`);
      return;
    }
    let priority: number | undefined;
    if (opts.priority !== undefined) {
      priority = Number(opts.priority);
      if (!/^-?\d+$/.test(opts.priority.trim()) || !Number.isSafeInteger(priority)) {
        ctx.fail("--priority must be an integer");
        return;
      }
    }
    const tags = (opts.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const preview: HindsightDirective = {
      id: "(new)",
      name,
      content,
      priority: priority ?? 0,
      isActive: true,
      tags,
    };
    ctx.io.log(`Bank ${ctx.bank}: add directive`);
    ctx.io.log(formatDirective(preview));
    if (!(await allowed(ctx.io, ctx.fail, opts, `Add this directive to bank ${ctx.bank}?`))) {
      return;
    }
    try {
      const created = await ctx.client.createDirective(ctx.bank, {
        name,
        content,
        ...(priority === undefined ? {} : { priority }),
        ...(tags.length ? { tags } : {}),
      });
      ctx.io.log(`Added directive ${created.id}.`);
    } catch (error) {
      ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
    }
  }

  async function directivesRm(idArg: unknown, opts: WriteOpts) {
    const ctx = setup("directives rm", opts);
    if (!ctx) {
      return;
    }
    const id = typeof idArg === "string" ? idArg.trim() : "";
    if (!id) {
      ctx.fail("a directive id is required (see openclaw hindsight directives list --all)");
      return;
    }
    let directive: HindsightDirective | null;
    try {
      directive = await ctx.client.getDirective(ctx.bank, id);
    } catch (error) {
      ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
      return;
    }
    if (!directive) {
      ctx.fail(`no directive ${id} in bank ${ctx.bank}`);
      return;
    }
    ctx.io.log(`Bank ${ctx.bank}: delete directive`);
    ctx.io.log(formatDirective(directive));
    if (
      !(await allowed(
        ctx.io,
        ctx.fail,
        opts,
        `Delete this directive from bank ${ctx.bank}? This cannot be undone.`,
      ))
    ) {
      return;
    }
    try {
      const deleted = await ctx.client.deleteDirective(ctx.bank, id);
      ctx.io.log(deleted ? `Deleted directive ${id}.` : `Directive ${id} was already gone.`);
    } catch (error) {
      ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
    }
  }

  /** The memory for a curate command, or null after reporting why it cannot be curated. */
  async function curatable(
    ctx: NonNullable<ReturnType<typeof setup>>,
    idArg: unknown,
  ): Promise<HindsightMemoryDetail | null> {
    const id = typeof idArg === "string" ? idArg.trim() : "";
    if (!id) {
      return ctx.fail("a memory id is required (hindsight_recall and recall --json print ids)");
    }
    let memory: HindsightMemoryDetail | null;
    try {
      memory = await ctx.client.getMemoryDetail(ctx.bank, id);
    } catch (error) {
      return ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
    }
    if (!memory) {
      return ctx.fail(`no memory ${id} in bank ${ctx.bank}`);
    }
    if (memory.type === "observation") {
      return ctx.fail(
        "observations are derived and cannot be curated; curate the world or experience memory it came from",
      );
    }
    return memory;
  }

  async function memoryShow(idArg: unknown, opts: BankOpts & { json?: boolean }) {
    const ctx = setup("memory show", opts);
    if (!ctx) {
      return;
    }
    const id = typeof idArg === "string" ? idArg.trim() : "";
    if (!id) {
      ctx.fail("a memory id is required");
      return;
    }
    let memory: HindsightMemoryDetail | null;
    try {
      memory = await ctx.client.getMemoryDetail(ctx.bank, id);
    } catch (error) {
      ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
      return;
    }
    if (!memory) {
      ctx.fail(`no memory ${id} in bank ${ctx.bank}`);
      return;
    }
    if (opts.json) {
      ctx.io.log(JSON.stringify({ bank: ctx.bank, memory }, null, 2));
      return;
    }
    ctx.io.log(`Bank ${ctx.bank}:`);
    for (const line of formatMemory(memory)) {
      ctx.io.log(line);
    }
  }

  async function memoryCurate(
    idArg: unknown,
    opts: WriteOpts & { text?: string; restore?: boolean; clearObservations?: boolean },
  ) {
    const ctx = setup("memory curate", opts);
    if (!ctx) {
      return;
    }
    const text = opts.text?.trim();
    const chosen = [text !== undefined, Boolean(opts.restore), Boolean(opts.clearObservations)];
    if (chosen.filter(Boolean).length !== 1) {
      ctx.fail("pass exactly one of --text <text>, --restore or --clear-observations");
      return;
    }
    if (text !== undefined && (!text || text.length > MAX_MEMORY_TEXT)) {
      ctx.fail(`--text must not be empty and at most ${MAX_MEMORY_TEXT} characters`);
      return;
    }
    const memory = await curatable(ctx, idArg);
    if (!memory) {
      return;
    }
    if (opts.restore && memory.state !== "invalidated") {
      ctx.fail(`memory ${memory.id} is not invalidated; nothing to restore`);
      return;
    }
    ctx.io.log(`Bank ${ctx.bank}: before`);
    for (const line of formatMemory(memory)) {
      ctx.io.log(line);
    }
    const what =
      text !== undefined
        ? `Replace the text with:\n  ${text.replace(/\s+/g, " ")}\nHindsight re-embeds it, drops its observations and consolidates it again.`
        : opts.restore
          ? "Restore it: state valid, back in recall and consolidation."
          : "Delete the observations derived from it; Hindsight consolidates it again.";
    ctx.io.log(what);
    if (
      !(await allowed(ctx.io, ctx.fail, opts, `Curate memory ${memory.id} in bank ${ctx.bank}?`))
    ) {
      return;
    }
    try {
      if (opts.clearObservations) {
        const { deleted } = await ctx.client.clearMemoryObservations(ctx.bank, memory.id);
        ctx.io.log(`Deleted ${deleted} observation(s) of ${memory.id}; consolidation is queued.`);
        return;
      }
      await ctx.client.updateMemory(
        ctx.bank,
        memory.id,
        text !== undefined ? { text } : { state: "valid" },
      );
      ctx.io.log(`Curated memory ${memory.id}.`);
    } catch (error) {
      ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
    }
  }

  async function memoryInvalidate(idArg: unknown, opts: WriteOpts & { reason?: string }) {
    const ctx = setup("memory invalidate", opts);
    if (!ctx) {
      return;
    }
    const reason = opts.reason?.trim();
    if (reason !== undefined && reason.length > MAX_DIRECTIVE_CONTENT) {
      ctx.fail(`--reason is at most ${MAX_DIRECTIVE_CONTENT} characters`);
      return;
    }
    const memory = await curatable(ctx, idArg);
    if (!memory) {
      return;
    }
    if (memory.state === "invalidated") {
      ctx.io.log(`Memory ${memory.id} is already invalidated.`);
      return;
    }
    ctx.io.log(`Bank ${ctx.bank}:`);
    for (const line of formatMemory(memory)) {
      ctx.io.log(line);
    }
    ctx.io.log(
      "Invalidate it: out of recall and consolidation, its observations pruned, kept for audit; memory curate --restore reverts it.",
    );
    if (
      !(await allowed(
        ctx.io,
        ctx.fail,
        opts,
        `Invalidate memory ${memory.id} in bank ${ctx.bank}?`,
      ))
    ) {
      return;
    }
    try {
      await ctx.client.updateMemory(ctx.bank, memory.id, {
        state: "invalidated",
        ...(reason ? { reason } : {}),
      });
      ctx.io.log(`Invalidated memory ${memory.id}.`);
    } catch (error) {
      ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
    }
  }

  async function consolidate(opts: BankOpts & { wait?: boolean; timeout?: string }) {
    const ctx = setup("consolidate", opts);
    if (!ctx) {
      return;
    }
    let timeoutS = CONSOLIDATE_DEFAULT_TIMEOUT_S;
    if (opts.timeout !== undefined) {
      timeoutS = Number(opts.timeout);
      if (
        !/^\d+$/.test(opts.timeout.trim()) ||
        timeoutS < 1 ||
        timeoutS > CONSOLIDATE_MAX_TIMEOUT_S
      ) {
        ctx.fail(`--timeout must be whole seconds from 1 to ${CONSOLIDATE_MAX_TIMEOUT_S}`);
        return;
      }
    }
    let queued: { operationId: string; deduplicated: boolean };
    try {
      queued = await ctx.client.consolidate(ctx.bank);
    } catch (error) {
      ctx.fail(`Hindsight request failed: ${formatErrorMessage(error)}`);
      return;
    }
    ctx.io.log(
      `Bank ${ctx.bank}: consolidation ${queued.deduplicated ? "already queued" : "queued"}, operation ${queued.operationId}`,
    );
    if (!opts.wait) {
      return;
    }
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutS * 1000;
    let last = "";
    for (;;) {
      let op: HindsightOperationStatus;
      try {
        op = await ctx.client.operationStatus(ctx.bank, queued.operationId);
      } catch (error) {
        ctx.fail(`could not read the operation: ${formatErrorMessage(error)}`);
        return;
      }
      const line = formatOperation(op);
      if (line !== last) {
        ctx.io.log(line);
        last = line;
      }
      if (isTerminal(op.status)) {
        if (op.status !== "completed") {
          ctx.io.exit(1);
        }
        return;
      }
      if (Date.now() >= deadline) {
        ctx.fail(
          `still ${op.status} after ${timeoutS} s; it keeps running on the server (operation ${queued.operationId})`,
        );
        return;
      }
      await sleep(CONSOLIDATE_POLL_MS);
    }
  }

  return {
    directivesList,
    directivesAdd,
    directivesRm,
    memoryShow,
    memoryCurate,
    memoryInvalidate,
    consolidate,
  };
}

/** The part of a Commander command these registrations use. */
export type CommandLike = {
  command(nameAndArgs: string): CommandLike;
  description(text: string): CommandLike;
  option(flags: string, description?: string): CommandLike;
  requiredOption(flags: string, description?: string): CommandLike;
  // oxlint-disable-next-line typescript/no-explicit-any -- Commander passes positional args, then options
  action(fn: (...args: any[]) => unknown): CommandLike;
};

const TOKEN_FILE = [
  "--token-file <path>",
  "Read the Hindsight token from this file (for a SecretRef the CLI does not resolve)",
] as const;

function bankOptions(cmd: CommandLike): CommandLike {
  return cmd
    .option("--agent <id>", "Agent whose owner bank to use (default main)")
    .option("--bank <id>", "Use this bank instead of the agent's owner bank")
    .option(...TOKEN_FILE);
}

function writeOptions(cmd: CommandLike): CommandLike {
  return bankOptions(cmd)
    .option("--dry-run", "Show what would change and change nothing")
    .option("--yes", "Go ahead without asking (needed outside a terminal)");
}

export function registerAdminCommands(root: CommandLike, deps: AdminDeps): void {
  const commands = createAdminCommands(deps);
  const directives = root
    .command("directives")
    .description(
      "List, add or remove the bank's directives (hard rules Hindsight applies to reflect)",
    );
  bankOptions(
    directives
      .command("list")
      .description("List the bank's active directives (--all: inactive ones too)")
      .option("--all", "Include inactive directives")
      .option("--json", "Print JSON"),
  ).action(async (opts: Parameters<typeof commands.directivesList>[0]) =>
    commands.directivesList(opts),
  );
  writeOptions(
    directives
      .command("add")
      .description("Add a directive; shows it and asks first")
      .requiredOption("--name <name>", "Short name")
      .requiredOption("--content <text>", "The rule, as one instruction")
      .option("--priority <n>", "Higher runs first (default 0)")
      .option("--tags <list>", "Comma list of tags; empty means a global directive"),
  ).action(async (opts: Parameters<typeof commands.directivesAdd>[0]) =>
    commands.directivesAdd(opts),
  );
  writeOptions(
    directives.command("rm <id>").description("Delete a directive by id; shows it and asks first"),
  ).action(async (id: unknown, opts: WriteOpts) => commands.directivesRm(id, opts));

  const memory = root
    .command("memory")
    .description("Show, curate or invalidate one memory unit by id");
  bankOptions(
    memory
      .command("show <id>")
      .description("Show a memory with its type, state, dates, document, tags and entities")
      .option("--json", "Print JSON"),
  ).action(async (id: unknown, opts: BankOpts & { json?: boolean }) =>
    commands.memoryShow(id, opts),
  );
  writeOptions(
    memory
      .command("curate <id>")
      .description(
        "Replace a world or experience memory's text, restore an invalidated one, or clear its observations; shows it and asks first",
      )
      .option("--text <text>", "New text (re-embeds it and drops its observations)")
      .option("--restore", "Set an invalidated memory valid again")
      .option(
        "--clear-observations",
        "Delete the observations derived from it and consolidate again",
      ),
  ).action(async (id: unknown, opts: Parameters<typeof commands.memoryCurate>[1]) =>
    commands.memoryCurate(id, opts),
  );
  writeOptions(
    memory
      .command("invalidate <id>")
      .description(
        "Retire a wrong memory: out of recall, kept for audit, reversible with curate --restore",
      )
      .option("--reason <text>", "Why, recorded with the memory"),
  ).action(async (id: unknown, opts: Parameters<typeof commands.memoryInvalidate>[1]) =>
    commands.memoryInvalidate(id, opts),
  );

  bankOptions(
    root
      .command("consolidate")
      .description(
        "Queue consolidation of the bank's new memories into observations (--wait: follow it to the end)",
      )
      .option("--wait", "Poll the operation until it ends; exit 1 unless it completed")
      .option(
        "--timeout <s>",
        `With --wait: give up after this many seconds (default ${CONSOLIDATE_DEFAULT_TIMEOUT_S})`,
      ),
  ).action(async (opts: Parameters<typeof commands.consolidate>[0]) => commands.consolidate(opts));
}
