import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { HindsightClient, HindsightRetainItem } from "./client.js";
import type { HindsightService } from "./service.js";

/**
 * Opt-in sync of workspace memory files into the agent's owner bank: MEMORY.md, USER.md and
 * memory/**\/*.md, one Hindsight document per file, replaced when the file changes and deleted
 * when it goes away.
 *
 * Document ids, tags, metadata and update mode match ~/.openclaw/scripts/hindsight-memory-sync.sh
 * (document_id = workspace-relative path, tag source:memory-file, update_mode replace), so moving
 * from the script to the plugin replaces each document in place and never stores a file twice.
 * The plugin keeps its own state; the first plugin run re-sends every file once unless the
 * script's state file is imported (importLegacyState).
 */

export const MEMORY_FILE_SOURCE = "memory-file";
export const MEMORY_FILE_TAG = "source:memory-file";
/** Files above this are skipped and reported, not truncated. */
export const MEMORY_FILE_MAX_BYTES = 1024 * 1024;

const ROOT_FILES = ["MEMORY.md", "USER.md"] as const;
const SESSION_STUB_LINE = /^\s*$|^# Session: |^- \*\*(Session Key|Session ID|Source|Reason)\*\*: /;
const DURABLE =
  " Extract only facts that stay true after the current task ends: rules, decisions, lessons, locations, outcomes, with their date. Do not extract progress, waiting states, plans, pending approvals, running jobs or head SHAs of moving branches. Time-bound facts must state their as-of date in the text.";

export type MemoryFileState = Record<string, string>;

export type MemoryFileCandidate = {
  /** Workspace-relative path with "/" separators; also the Hindsight document id. */
  rel: string;
  content: string;
  mtimeMs: number;
  hash: string;
};

export type MemoryFileSkip = { rel: string; reason: string };

export type MemoryFileScan = { send: MemoryFileCandidate[]; skipped: MemoryFileSkip[] };

export type MemoryFilePlan = {
  retain: MemoryFileCandidate[];
  unchanged: string[];
  delete: string[];
  skipped: MemoryFileSkip[];
};

/**
 * True for paths the plugin scans: MEMORY.md, USER.md and memory/**.md of one workspace. Only these
 * are imported from the script's state and only these are ever deleted, so documents of other
 * sources (the script's sub-agent folders such as worker/memory/..., anything else in the bank)
 * are never touched.
 */
export function inScanSet(rel: string): boolean {
  if (
    !rel ||
    rel.includes("\\") ||
    rel.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return false;
  }
  return (
    (ROOT_FILES as readonly string[]).includes(rel) ||
    (rel.startsWith("memory/") && rel.endsWith(".md"))
  );
}

/** Why a path is never sent, by location alone; null when it is a candidate. */
export function pathSkipReason(rel: string): string | null {
  if (rel.startsWith("memory/dreaming/")) {
    return "dreaming pipeline output";
  }
  if (rel.split("/").some((part) => part.startsWith("."))) {
    return "hidden pipeline state";
  }
  return null;
}

/** Why rendered content is never sent; null when it is sent. */
export function contentSkipReason(content: string): string | null {
  if (!/\S/.test(content)) {
    return "empty";
  }
  if (content.split("\n").every((line) => SESSION_STUB_LINE.test(line))) {
    return "session header only";
  }
  return null;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function listMarkdown(dir: string, prefix: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const rel = `${prefix}/${entry.name}`;
    // Symlinks are not followed: a link must not pull files from outside the workspace.
    if (entry.isDirectory()) {
      await listMarkdown(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(rel);
    }
  }
}

/** The workspace's memory files in a stable order (root files, then memory/ sorted bytewise). */
export async function scanMemoryFiles(workspaceDir: string): Promise<MemoryFileScan> {
  const rels: string[] = [];
  for (const name of ROOT_FILES) {
    const stat = await fs.lstat(path.join(workspaceDir, name)).catch(() => null);
    if (stat?.isFile()) {
      rels.push(name);
    }
  }
  const nested: string[] = [];
  await listMarkdown(path.join(workspaceDir, "memory"), "memory", nested);
  rels.push(...nested.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

  const send: MemoryFileCandidate[] = [];
  const skipped: MemoryFileSkip[] = [];
  for (const rel of rels) {
    const byPath = pathSkipReason(rel);
    if (byPath) {
      skipped.push({ rel, reason: byPath });
      continue;
    }
    const abs = path.join(workspaceDir, ...rel.split("/"));
    const stat = await fs.stat(abs);
    if (stat.size > MEMORY_FILE_MAX_BYTES) {
      skipped.push({ rel, reason: `larger than ${MEMORY_FILE_MAX_BYTES} bytes` });
      continue;
    }
    const content = await fs.readFile(abs, "utf8");
    const byContent = contentSkipReason(content);
    if (byContent) {
      skipped.push({ rel, reason: byContent });
      continue;
    }
    send.push({ rel, content, mtimeMs: stat.mtimeMs, hash: contentHash(content) });
  }
  return { send, skipped };
}

/** What to retain, keep and delete, given the hashes of the last successful sync. */
export function planMemoryFileSync(scan: MemoryFileScan, state: MemoryFileState): MemoryFilePlan {
  const retain: MemoryFileCandidate[] = [];
  const unchanged: string[] = [];
  const seen = new Set<string>();
  for (const file of scan.send) {
    seen.add(file.rel);
    if (state[file.rel] === file.hash) {
      unchanged.push(file.rel);
    } else {
      retain.push(file);
    }
  }
  // Only paths this plugin scans can be deleted; a state entry for anything else is left alone.
  const deleted = Object.keys(state)
    .filter((rel) => !seen.has(rel) && inScanSet(rel))
    .toSorted();
  return { retain, unchanged, delete: deleted, skipped: scan.skipped };
}

/** UTC second precision, as the script sends it (`date -u '+%Y-%m-%dT%H:%M:%SZ'`). */
export function isoSecond(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

function asOfDate(rel: string, timestamp: string): string {
  const base = rel.split("/").at(-1) ?? rel;
  return (
    /\d{4}-\d{2}-\d{2}/.exec(base)?.[0] ??
    /\d{4}-\d{2}-\d{2}/.exec(rel)?.[0] ??
    timestamp.slice(0, 10)
  );
}

/** The retain item for one file; same fields as the script's. */
export function memoryFileItem(
  file: MemoryFileCandidate,
  extraTags: readonly string[] = [],
): HindsightRetainItem & { document_id: string } {
  const timestamp = isoSecond(file.mtimeMs);
  return {
    content: file.content,
    document_id: file.rel,
    timestamp,
    tags: [MEMORY_FILE_TAG, ...extraTags.filter((tag) => tag !== MEMORY_FILE_TAG)],
    update_mode: "replace",
    context: `OpenClaw workspace memory file ${file.rel} (curated notes, not a chat transcript).${DURABLE} Run results and open items in this file are as of ${asOfDate(file.rel, timestamp)}; keep the lessons and rules.`,
    metadata: { source: MEMORY_FILE_SOURCE, path: file.rel },
  };
}

/**
 * Reads the script's state (`path<TAB>hash<TAB>status` per line) and keeps the files it finished.
 * Only paths this plugin scans are kept: the script's sub-agent folders (worker/memory/... and the
 * like) are not synced by the plugin and must keep their documents. The script hashes the file as
 * it sent it; for MEMORY.md it cuts a few lines first, so that one file may still be re-sent once.
 */
export function parseLegacyState(tsv: string): MemoryFileState {
  const state: MemoryFileState = {};
  for (const line of tsv.split("\n")) {
    const [rel, hash, status] = line.split("\t");
    if (rel && hash && status === "done" && /^[0-9a-f]{64}$/.test(hash) && inScanSet(rel)) {
      state[rel] = hash;
    }
  }
  return state;
}

export async function readSyncState(file: string): Promise<MemoryFileState> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const state: MemoryFileState = {};
    for (const [rel, hash] of Object.entries(parsed)) {
      if (typeof hash === "string") {
        state[rel] = hash;
      }
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeSyncState(file: string, state: MemoryFileState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** The parts of the service a sync pass uses. */
export type MemoryFileSyncService = {
  retainOrQueue: HindsightService["retainOrQueue"];
  client: Pick<HindsightClient, "deleteDocument">;
};

export type MemoryFileSyncResult = {
  sent: number;
  queued: number;
  unchanged: number;
  deleted: number;
  skipped: MemoryFileSkip[];
  failed: Array<{ rel: string; error: string }>;
};

/**
 * One sync pass for one workspace into one bank. State is written after each file, so a pass that
 * stops half way resumes where it stopped. A failed file keeps its old hash and is retried.
 */
export async function syncMemoryFiles(params: {
  service: MemoryFileSyncService;
  workspaceDir: string;
  bankId: string;
  statePath: string;
  extraTags?: readonly string[];
  dryRun?: boolean;
  signal?: AbortSignal;
}): Promise<MemoryFileSyncResult & { plan: MemoryFilePlan }> {
  const state = await readSyncState(params.statePath);
  const plan = planMemoryFileSync(await scanMemoryFiles(params.workspaceDir), state);
  const result: MemoryFileSyncResult = {
    sent: 0,
    queued: 0,
    unchanged: plan.unchanged.length,
    deleted: 0,
    skipped: plan.skipped,
    failed: [],
  };
  if (params.dryRun) {
    return { ...result, plan };
  }
  const signal = params.signal ?? AbortSignal.timeout(120_000);
  for (const file of plan.retain) {
    signal.throwIfAborted();
    try {
      const outcome = await params.service.retainOrQueue(
        params.bankId,
        memoryFileItem(file, params.extraTags),
        signal,
      );
      result[outcome === "sent" ? "sent" : "queued"] += 1;
      state[file.rel] = file.hash;
      await writeSyncState(params.statePath, state);
    } catch (error) {
      result.failed.push({ rel: file.rel, error: (error as Error).message ?? String(error) });
    }
  }
  for (const rel of plan.delete) {
    signal.throwIfAborted();
    try {
      await params.service.client.deleteDocument(params.bankId, rel, signal);
      delete state[rel];
      result.deleted += 1;
      await writeSyncState(params.statePath, state);
    } catch (error) {
      result.failed.push({ rel, error: (error as Error).message ?? String(error) });
    }
  }
  return { ...result, plan };
}
