import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { type HindsightRetainItem, HindsightHttpError } from "./client.js";
import type { DropReason, ReplayOutcome } from "./metrics.js";

/** One auto-retain that could not reach Hindsight. Holds no URL and no credentials. */
export type QueuedRetain = {
  /** Resolved when the run ended; replay always writes here and never routes again. */
  bankId: string;
  documentId: string;
  item: HindsightRetainItem;
  /** Epoch ms of the latest enqueue for this bank and document. */
  queuedAt: number;
};

export type RetainQueueLimits = { maxItems: number; maxAgeMs: number };

type QueueLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

/** Called once per item that leaves the queue without being delivered. */
export type OnQueueDrop = (bankId: string, reason: DropReason) => void;

export const RETAIN_QUEUE_DIR = "hindsight-native";
export const RETAIN_QUEUE_FILE = "retain-queue.jsonl";
/** Total size bound for the queue file, on top of the item and age limits. */
export const RETAIN_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

/** `<state dir>/hindsight-native/retain-queue.jsonl`; the host passes the state dir to services. */
export function retainQueuePath(stateDir: string): string {
  return join(stateDir, RETAIN_QUEUE_DIR, RETAIN_QUEUE_FILE);
}

/**
 * True when Hindsight was not reached or failed on its side: network errors (fetch rejects with
 * `TypeError: fetch failed`), timeouts and aborts, and HTTP 5xx. A 4xx is an answer about the
 * request, so it is never queued. A refused redirect (`redirect: "error"`) is a configuration
 * problem, not an outage, and any other TypeError is a bug, so neither is queued.
 */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof HindsightHttpError) {
    return error.status >= 500;
  }
  if (error instanceof TypeError) {
    const cause = (error as { cause?: { message?: unknown } }).cause;
    const causeMessage = typeof cause?.message === "string" ? cause.message : "";
    return error.message === "fetch failed" && !/redirect/i.test(causeMessage);
  }
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * A 4xx from bank setup (applying `retainMission` before the write). It is about the bank's
 * config, not the queued item, so replay keeps the item; a config fix lets it through.
 */
export class BankSetupError extends Error {
  constructor(readonly cause: unknown) {
    super(`bank setup failed (${formatErrorMessage(cause)})`);
    this.name = "BankSetupError";
  }
}

/**
 * The only replay failure that drops an item: a Hindsight HTTP 4xx about the item itself (not
 * auth, rate limit or an ambiguous 404). Everything else keeps the item.
 */
export function isDroppingRejection(error: unknown): boolean {
  return (
    error instanceof HindsightHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    !isRetryableRejection(error)
  );
}

/**
 * Rejections on replay that say nothing about the item itself: keep it and retry later. That is
 * auth (401, 403), a request timeout (408), rate limits (429) and a 404 for a route that does not exist (a wrong
 * `hindsightApiUrl` path) or with an empty body. Hindsight creates a bank on its first retain, so
 * only an explicit `Bank '<id>' not found` 404 is an answer about this item and drops it like
 * other 4xx; an ambiguous 404 keeps it, and the age bound clears it in the end.
 */
export function isRetryableRejection(error: unknown): boolean {
  if (!(error instanceof HindsightHttpError)) {
    return false;
  }
  if (error.status === 404) {
    return !error.bankMissingExplicit;
  }
  return (
    error.status === 401 || error.status === 403 || error.status === 408 || error.status === 429
  );
}

/**
 * A live auto-retain failure worth queueing: Hindsight unreachable, or a rejection that says
 * nothing about the item (auth, request timeout, rate limit). An ambiguous 404 stays out: on the
 * live path it is almost always a wrong `hindsightApiUrl`, which queueing would only hide.
 */
export function isQueueableLiveFailure(error: unknown): boolean {
  if (isTransportFailure(error)) {
    return true;
  }
  return error instanceof HindsightHttpError && error.status !== 404 && isRetryableRejection(error);
}

function isQueuedRetain(value: unknown): value is QueuedRetain {
  const v = value as Partial<QueuedRetain> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.bankId === "string" &&
    v.bankId.length > 0 &&
    typeof v.documentId === "string" &&
    v.documentId.length > 0 &&
    typeof v.queuedAt === "number" &&
    Number.isFinite(v.queuedAt) &&
    typeof v.item === "object" &&
    v.item !== null &&
    typeof v.item.content === "string"
  );
}

/** One queued copy per bank and document id; JSON keeps ids with any characters apart. */
function queueKey(key: { bankId: string; documentId: string }): string {
  return JSON.stringify([key.bankId, key.documentId]);
}

/** The key of a tombstone line, written when a rewrite failed to drop an out-of-date copy. */
function tombstoneKey(value: unknown): { bankId: string; documentId: string } | undefined {
  const t = (value as { tombstone?: { bankId?: unknown; documentId?: unknown } } | null)?.tombstone;
  return typeof t?.bankId === "string" && typeof t.documentId === "string"
    ? { bankId: t.bankId, documentId: t.documentId }
    : undefined;
}

function tombstoneLine(key: { bankId: string; documentId: string }): string {
  return JSON.stringify({ tombstone: { bankId: key.bankId, documentId: key.documentId } });
}

/** Makes a rename durable. Best effort: some file systems refuse fsync on a directory. */
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // The rename itself succeeded; only its durability across a power loss is weaker.
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** True when the file is empty or its last byte is a newline. */
function endsWithNewline(filePath: string): boolean {
  const fd = openSync(filePath, "r");
  try {
    const { size } = fstatSync(fd);
    if (size === 0) {
      return true;
    }
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** `size` is the line's UTF-8 length plus its newline: what it takes on disk. */
type Stored = { entry: QueuedRetain; line: string; size: number };

function stored(entry: QueuedRetain, line = JSON.stringify(entry)): Stored {
  return { entry, line, size: Buffer.byteLength(line, "utf8") + 1 };
}

/**
 * Bounded, file-backed FIFO of failed auto-retains, one JSON line per item. One entry per bank and
 * document id: a newer retain of the same document replaces the queued one in place. A new item is
 * appended to the file; replacing, pruning and replay rewrite it (mode 600, atomic rename). When a
 * rewrite fails, the item is appended instead (`load()` keeps the newest copy of each document). An
 * append that would push the file past the size bound goes through a rewrite; when both fail, the
 * caller sends the item live.
 */
export class RetainQueue {
  private stored: Stored[] = [];
  private dropWarned = false;
  /** Removals not yet written (replay batches its writes). */
  private dirty = false;
  /**
   * Copies removed from memory but still in the file until the next successful save, by bank and
   * document id. A newer copy that cannot be queued gets a tombstone for it, so a restart before
   * that save cannot replay the old copy over the newer one the caller sent live.
   */
  private unsaved = new Map<string, QueuedRetain>();
  /** Bytes in the file as this queue last read or wrote it; appends grow it, rewrites reset it. */
  private fileBytes = 0;
  private limits: () => RetainQueueLimits;
  private logger: QueueLogger;
  private onDrop: OnQueueDrop | undefined;

  constructor(
    private readonly options: {
      filePath: string;
      limits: () => RetainQueueLimits;
      logger: QueueLogger;
      onDrop?: OnQueueDrop;
      now?: () => number;
      maxBytes?: number;
    },
  ) {
    this.limits = options.limits;
    this.logger = options.logger;
    this.onDrop = options.onDrop;
  }

  get filePath(): string {
    return this.options.filePath;
  }

  /** A restarted service reuses this queue with its own config and logger. */
  configure(params: {
    limits: () => RetainQueueLimits;
    logger: QueueLogger;
    onDrop?: OnQueueDrop;
  }): void {
    this.limits = params.limits;
    this.logger = params.logger;
    this.onDrop = params.onDrop;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private maxBytes(): number {
    return this.options.maxBytes ?? RETAIN_QUEUE_MAX_BYTES;
  }

  /**
   * Reads the file. A missing file is an empty queue. Unreadable lines (a torn append) are
   * skipped with one warning. Any other read error throws, so the file is never overwritten.
   */
  load(): void {
    // The file is the source of truth again; any copy it still holds is loaded below.
    this.unsaved.clear();
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        this.stored = [];
        this.fileBytes = 0;
        return;
      }
      throw error;
    }
    this.fileBytes = Buffer.byteLength(text, "utf8");
    // Keyed by bank and document id in file order. A later copy wins and takes the later place:
    // a crash between replay's batched saves leaves a delivered copy before a newer append.
    const loaded = new Map<string, Stored>();
    let skipped = 0;
    let tombstones = 0;
    let duplicates = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry: unknown = JSON.parse(line);
        if (isQueuedRetain(entry)) {
          const key = queueKey(entry);
          if (loaded.delete(key)) {
            duplicates += 1;
          }
          loaded.set(key, stored(entry, line));
          continue;
        }
        const dead = tombstoneKey(entry);
        if (dead) {
          // Drops the earlier copy the tombstone was written for.
          loaded.delete(queueKey(dead));
          tombstones += 1;
          continue;
        }
      } catch {
        // counted below
      }
      skipped += 1;
    }
    this.stored = [...loaded.values()];
    if (skipped > 0) {
      this.logger.warn?.(`memory-hindsight: retain queue skipped ${skipped} unreadable line(s)`);
    }
    if (this.prune(false) > 0 || skipped > 0 || tombstones > 0 || duplicates > 0) {
      try {
        this.persist();
      } catch (error) {
        // Compaction is optional: the file loads the same way next time, so keep the queue on.
        this.logger.warn?.(
          `memory-hindsight: retain queue file not compacted (${formatErrorMessage(error)})`,
        );
      }
    }
  }

  size(): number {
    return this.stored.length;
  }

  hasBank(bankId: string): boolean {
    return this.stored.some((s) => s.entry.bankId === bankId);
  }

  /** The oldest item, skipping banks in `skipBanks` (replay passes over a bank that refused). */
  peek(skipBanks?: ReadonlySet<string>): QueuedRetain | undefined {
    if (!skipBanks?.size) {
      return this.stored[0]?.entry;
    }
    return this.stored.find((s) => !skipBanks.has(s.entry.bankId))?.entry;
  }

  /**
   * True when the item alone is over the size bound, so `enqueue` refuses it. Not reported as a
   * drop here: the caller may still send it live, and reports it only when it is lost.
   */
  isTooLarge(entry: Omit<QueuedRetain, "queuedAt">): boolean {
    return stored({ ...entry, queuedAt: this.now() }).size > this.maxBytes();
  }

  /** Queued items per bank id. */
  depthByBank(): Map<string, number> {
    const depth = new Map<string, number>();
    for (const { entry } of this.stored) {
      depth.set(entry.bankId, (depth.get(entry.bankId) ?? 0) + 1);
    }
    return depth;
  }

  /** Bank and document id of every queued item, oldest first. */
  list(): Array<Pick<QueuedRetain, "bankId" | "documentId">> {
    return this.stored.map(({ entry }) => ({ bankId: entry.bankId, documentId: entry.documentId }));
  }

  /**
   * Adds or replaces (same bank and document id) and writes the file before returning. Returns
   * false, and queues nothing, when the item alone is larger than the size bound.
   */
  enqueue(entry: Omit<QueuedRetain, "queuedAt">): boolean {
    const next = stored({
      bankId: entry.bankId,
      documentId: entry.documentId,
      item: entry.item,
      queuedAt: this.now(),
    });
    const index = this.stored.findIndex(
      (s) => s.entry.bankId === entry.bankId && s.entry.documentId === entry.documentId,
    );
    const unsavedCopy = index < 0 ? this.unsaved.get(queueKey(entry)) : undefined;
    if (next.size > this.maxBytes()) {
      this.logger.warn?.(
        `memory-hindsight: retain too large to queue (${next.size} bytes, bound ${this.maxBytes()}); not queued`,
      );
      // An older copy of the same document is out of date now; do not replay it.
      if (index >= 0) {
        const [stale] = this.stored.splice(index, 1);
        try {
          this.persist();
        } catch {
          this.markStale(stale!.entry);
        }
      } else if (unsavedCopy && this.markStale(unsavedCopy)) {
        // Kept when the tombstone could not be written, so the next attempt tries again.
        this.unsaved.delete(queueKey(entry));
      }
      return false;
    }
    // A failed write never leaves memory holding an item the file lacks; see the catch below.
    const before = [...this.stored];
    if (index >= 0) {
      this.stored[index] = next;
    } else {
      this.stored.push(next);
    }
    let rewriteError: unknown;
    try {
      // Drops are reported only once the write that makes them stick succeeds; the fallback below
      // restores memory and prunes again, and reports then.
      const pruned = this.pruneStored();
      if (
        pruned.length === 0 &&
        index < 0 &&
        existsSync(this.filePath) &&
        this.canAppend(next.size)
      ) {
        this.append(next.line);
        return true;
      }
      this.persist();
      this.reportDrops(pruned);
      // False when the bound dropped the item just added or replaced.
      return this.stored.includes(next);
    } catch (error) {
      rewriteError = error;
    }
    // The rewrite failed. load() keeps the newest copy per bank and document id, so appending the
    // new copy also replaces an older one in the file; the byte check keeps the file bounded.
    const kept = index >= 0 ? before.filter((_, i) => i !== index) : before;
    // Memory becomes what load() gives for the file plus the appended text: the new copy after the
    // older one, and a tombstone for every item the bounds drop, so no dropped line can come back
    // on a restart (say, after a later tombstone brings the count under maxItems).
    this.stored = [...kept, next];
    // Reported only if the append below sticks; otherwise memory goes back to `kept`.
    const prunedAgain = this.pruneStored();
    const keepsNext = this.stored.includes(next);
    const dead = kept.filter((s) => !this.stored.includes(s)).map((s) => s.entry);
    if (!keepsNext && index >= 0) {
      dead.push(before[index]!.entry);
    }
    const lines = dead.map((e) => tombstoneLine(e));
    if (keepsNext) {
      lines.push(next.line);
    }
    const text = lines.join("\n");
    // One more byte for the trailing newline, as Stored.size counts it.
    if (existsSync(this.filePath) && this.canAppend(Buffer.byteLength(text, "utf8") + 1)) {
      try {
        if (text) {
          this.append(text);
        }
        this.reportDrops(prunedAgain);
        return keepsNext;
      } catch {
        // Neither write worked; handled below.
      }
    }
    // A queued copy of the same document is out of date now (the caller sends the newer one live),
    // so it must not be replayed over it: not from memory, and not after a restart.
    this.stored = kept;
    if (index >= 0) {
      this.markStale(before[index]!.entry);
    } else if (unsavedCopy && this.markStale(unsavedCopy)) {
      this.unsaved.delete(queueKey(entry));
    }
    throw rewriteError;
  }

  /**
   * Removes the entry when it is still the queued copy (a newer enqueue replaced it otherwise).
   * Replay passes `persist: false` and calls `save()` in batches: a crash before the save only
   * re-sends items that replace themselves on the server (same document id, update_mode replace).
   */
  remove(entry: QueuedRetain, options: { persist?: boolean } = {}): void {
    const index = this.stored.findIndex((s) => s.entry === entry);
    if (index < 0) {
      return;
    }
    this.stored.splice(index, 1);
    if (options.persist === false) {
      this.dirty = true;
      this.unsaved.set(queueKey(entry), entry);
    } else {
      this.persist();
    }
  }

  /**
   * Called after a newer copy of this document went out live. A copy that replay delivered but
   * has not saved yet is still in the file, so a crash or a failed save would replay it over the
   * newer one: tombstone it. A copy still queued in memory is left alone; it is newer than the
   * live write or replaces itself on replay.
   */
  supersede(key: { bankId: string; documentId: string }): void {
    const k = queueKey(key);
    const copy = this.unsaved.get(k);
    if (copy && !this.stored.some((s) => queueKey(s.entry) === k) && this.markStale(copy)) {
      this.unsaved.delete(k);
    }
  }

  /** True while replay's batched removals are not written yet. */
  hasUnsaved(): boolean {
    return this.dirty;
  }

  /** Writes batched removals, if any. */
  save(): void {
    if (this.dirty) {
      this.persist();
    }
  }

  /**
   * Removes the queued copy of this document if it still holds exactly `item` (the service queued
   * it at shutdown while its live write was in flight, and that write then succeeded). A newer
   * copy is left alone. Best effort: a failed rewrite keeps the copy, which replays as a replace.
   */
  discard(key: { bankId: string; documentId: string }, item: HindsightRetainItem): void {
    const index = this.stored.findIndex(
      (s) =>
        s.entry.bankId === key.bankId &&
        s.entry.documentId === key.documentId &&
        s.entry.item === item,
    );
    if (index < 0) {
      return;
    }
    const before = [...this.stored];
    this.stored.splice(index, 1);
    try {
      this.persist();
    } catch {
      this.stored = before;
    }
  }

  /**
   * Drops expired entries, then the oldest beyond maxItems or the byte bound. Warns once, then
   * stays quiet until the queue is empty again.
   */
  prune(persist = true): number {
    const dropped = this.pruneStored();
    this.reportDrops(dropped);
    if (dropped.length > 0 && persist) {
      this.persist();
    }
    return dropped.length;
  }

  /** The bounds step of `prune()`: updates memory and warns, but neither reports nor writes. */
  private pruneStored(): Stored[] {
    const { maxItems, maxAgeMs } = this.limits();
    const cutoff = this.now() - maxAgeMs;
    let kept = this.stored.filter((s) => s.entry.queuedAt >= cutoff);
    if (kept.length > maxItems) {
      kept = kept.slice(kept.length - maxItems);
    }
    let bytes = kept.reduce((sum, s) => sum + s.size, 0);
    while (kept.length > 0 && bytes > this.maxBytes()) {
      bytes -= kept.shift()!.size;
    }
    const keptSet = new Set(kept);
    const dropped = this.stored.filter((s) => !keptSet.has(s));
    this.stored = kept;
    if (dropped.length > 0 && !this.dropWarned) {
      this.dropWarned = true;
      this.logger.warn?.(
        `memory-hindsight: retain queue dropped ${dropped.length} item(s) over retainQueueMaxItems (${maxItems}), retainQueueMaxAgeMs (${maxAgeMs}) or the ${this.maxBytes()}-byte size bound; further drops are not logged until the queue is empty`,
      );
    }
    return dropped;
  }

  private reportDrops(dropped: Stored[]): void {
    for (const s of dropped) {
      this.onDrop?.(s.entry.bankId, "limit");
    }
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  /** No append that would take the file past the size bound (one byte for a torn line's newline). */
  private canAppend(size: number): boolean {
    return this.fileBytes + size + 1 <= this.maxBytes();
  }

  private append(line: string): void {
    // A torn last line (crash mid-append) must not swallow this item: start on a fresh line.
    const text = `${endsWithNewline(this.filePath) ? "" : "\n"}${line}\n`;
    appendFileSync(this.filePath, text, { mode: 0o600 });
    this.fileBytes += Buffer.byteLength(text, "utf8");
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // The line is written; a chmod failure must not make the caller think it was not.
    }
  }

  /**
   * Best effort when the rewrite failed: append a tombstone for an out-of-date copy that is still
   * in the file, so `load()` drops it after a restart instead of replaying it.
   */
  private markStale(entry: QueuedRetain): boolean {
    try {
      this.append(tombstoneLine(entry));
      return true;
    } catch (error) {
      this.logger.warn?.(
        `memory-hindsight: could not mark an out-of-date queued retain (${formatErrorMessage(error)}); a restart may replay it before the newer copy is written again`,
      );
      return false;
    }
  }

  private persist(): void {
    this.rewrite();
    // Cleared only once written, so a failed replay save is retried by the next save().
    this.dirty = false;
    this.unsaved.clear();
  }

  private rewrite(): void {
    if (this.stored.length === 0) {
      rmSync(this.filePath, { force: true });
      this.fileBytes = 0;
      this.dropWarned = false;
      return;
    }
    this.ensureDir();
    const tmp = `${this.filePath}.tmp`;
    const text = `${this.stored.map((s) => s.line).join("\n")}\n`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      // writeFileSync loops until every byte is out; a bare writeSync can store part of the text
      // on a nearly full disk and report no error.
      writeFileSync(fd, text);
      // On disk before the rename, so a power loss cannot leave an empty or missing queue file.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // openSync keeps the mode of an existing file; force it.
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
    this.fileBytes = Buffer.byteLength(text, "utf8");
    syncDir(dirname(this.filePath));
  }
}

/**
 * One queue per file per process, shared across service restarts, so a stopped instance can
 * never write a stale copy over the file the current instance owns.
 */
const sharedQueues = new Map<string, RetainQueue>();

export function sharedRetainQueue(
  filePath: string,
  params: { limits: () => RetainQueueLimits; logger: QueueLogger; onDrop?: OnQueueDrop },
): RetainQueue {
  const existing = sharedQueues.get(filePath);
  if (existing) {
    existing.configure(params);
    return existing;
  }
  const queue = new RetainQueue({ filePath, ...params });
  queue.load();
  sharedQueues.set(filePath, queue);
  return queue;
}

/** Test seam: forget every shared queue, as a new process would (the files stay). */
export function resetSharedRetainQueues(): void {
  sharedQueues.clear();
}

export const RETAIN_QUEUE_RETRY_BASE_MS = 30_000;
export const RETAIN_QUEUE_RETRY_MAX_MS = 15 * 60_000;
// Replay writes the file after this many deliveries and at the end of each pass.
const SAVE_EVERY = 25;

/** Replays the queue in order on a backoff timer. Stops at the first transport failure. */
export class RetainQueueRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delayMs: number;
  private running: Promise<void> | undefined;
  private rejectionWarned = false;
  private readonly controller = new AbortController();

  constructor(
    readonly queue: RetainQueue,
    private readonly options: {
      send: (entry: QueuedRetain, signal: AbortSignal) => Promise<void>;
      logger: QueueLogger;
      onReplay?: (bankId: string, outcome: ReplayOutcome) => void;
      onDrop?: OnQueueDrop;
      baseDelayMs?: number;
      maxDelayMs?: number;
    },
  ) {
    this.delayMs = this.baseDelay();
  }

  private baseDelay(): number {
    return this.options.baseDelayMs ?? RETAIN_QUEUE_RETRY_BASE_MS;
  }

  stopped(): boolean {
    return this.controller.signal.aborted;
  }

  /** Runs one replay pass now (or joins the one in progress). */
  flush(): Promise<void> {
    if (this.stopped()) {
      return Promise.resolve();
    }
    this.running ??= this.replay()
      .catch((error: unknown) => {
        this.options.logger.warn?.(
          `memory-hindsight: retain queue replay stopped (${formatErrorMessage(error)})`,
        );
        // A write error ended the pass; try again after the backoff instead of waiting for the
        // next retain or a restart, and wait longer each time the disk stays unwritable.
        this.backOff();
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Schedules a pass after the current backoff unless one is already scheduled. */
  schedule(delayMs = this.delayMs): void {
    // An empty queue with unsaved removals still needs a pass, to write them.
    if (this.stopped() || this.timer || (this.queue.size() === 0 && !this.queue.hasUnsaved())) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.controller.abort();
  }

  /** The pass that just failed waited the current delay; the next one waits twice as long. */
  private backOff(): void {
    this.schedule();
    this.delayMs = Math.min(this.delayMs * 2, this.options.maxDelayMs ?? RETAIN_QUEUE_RETRY_MAX_MS);
  }

  private async replay(): Promise<void> {
    let delivered = 0;
    try {
      delivered = await this.replayItems();
    } finally {
      // Removals during the pass are batched; write the final state once.
      this.queue.save();
    }
    if (delivered > 0) {
      this.options.logger.info?.(
        `memory-hindsight: retain queue delivered ${delivered}, ${this.queue.size() > 0 ? `${this.queue.size()} pending` : "queue empty"}`,
      );
    }
  }

  private async replayItems(): Promise<number> {
    const { logger, send } = this.options;
    let delivered = 0;
    // Banks that refused this pass (auth, rate limit, bank setup, ambiguous 404): their items
    // wait, in order, and other banks' items still go out.
    const refused = new Set<string>();
    this.queue.prune();
    for (let entry = this.queue.peek(refused); entry; entry = this.queue.peek(refused)) {
      try {
        await send(entry, this.controller.signal);
      } catch (error) {
        if (this.stopped()) {
          return delivered;
        }
        if (!isDroppingRejection(error)) {
          this.options.onReplay?.(entry.bankId, "deferred");
          logger.debug?.(
            `memory-hindsight: retain queue replay deferred (${this.queue.size()} pending): ${formatErrorMessage(error)}`,
          );
          if (isTransportFailure(error)) {
            // Hindsight is unreachable for everyone: end the pass and back off.
            this.backOff();
            return delivered;
          }
          // Not an answer about this item (auth, rate limit, ambiguous 404, bank setup, refused
          // redirect, or an unexpected error): keep it, skip its bank for this pass, back off.
          if (!this.rejectionWarned) {
            this.rejectionWarned = true;
            logger.warn?.(
              `memory-hindsight: queued retain not delivered (${formatErrorMessage(error)}); ${this.queue.size()} pending, retrying with backoff; new retains for a bank with pending items queue behind it`,
            );
          }
          refused.add(entry.bankId);
          continue;
        }
        // Hindsight answered 4xx about this item: retrying cannot help, so it leaves the queue.
        this.queue.remove(entry, { persist: false });
        this.options.onDrop?.(entry.bankId, "rejected");
        logger.warn?.(
          `memory-hindsight: queued retain rejected and dropped: ${formatErrorMessage(error)}`,
        );
        continue;
      }
      // A runner stopped mid-send leaves the item for the next one; a resend replaces itself.
      if (this.stopped()) {
        return delivered;
      }
      this.queue.remove(entry, { persist: false });
      this.options.onReplay?.(entry.bankId, "delivered");
      delivered += 1;
      if (delivered % SAVE_EVERY === 0) {
        this.queue.save();
      }
    }
    if (refused.size > 0) {
      this.backOff();
      return delivered;
    }
    this.rejectionWarned = false;
    this.delayMs = this.baseDelay();
    return delivered;
  }
}
