import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
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
 * auth (401, 403), rate limits (429) and a 404 for a route that does not exist (a wrong
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
  return error.status === 401 || error.status === 403 || error.status === 429;
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
  /** Bytes in the file as this queue last read or wrote it; appends grow it, rewrites reset it. */
  private fileBytes = 0;
  private limits: () => RetainQueueLimits;
  private logger: QueueLogger;

  constructor(
    private readonly options: {
      filePath: string;
      limits: () => RetainQueueLimits;
      logger: QueueLogger;
      now?: () => number;
      maxBytes?: number;
    },
  ) {
    this.limits = options.limits;
    this.logger = options.logger;
  }

  get filePath(): string {
    return this.options.filePath;
  }

  /** A restarted service reuses this queue with its own config and logger. */
  configure(params: { limits: () => RetainQueueLimits; logger: QueueLogger }): void {
    this.limits = params.limits;
    this.logger = params.logger;
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

  peek(): QueuedRetain | undefined {
    return this.stored[0]?.entry;
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
      if (
        this.prune(false) === 0 &&
        index < 0 &&
        existsSync(this.filePath) &&
        this.canAppend(next.size)
      ) {
        this.append(next.line);
        return true;
      }
      this.persist();
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
    this.prune(false);
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
    } else {
      this.persist();
    }
  }

  /** Writes batched removals, if any. */
  save(): void {
    if (this.dirty) {
      this.persist();
    }
  }

  /**
   * Drops expired entries, then the oldest beyond maxItems or the byte bound. Warns once, then
   * stays quiet until the queue is empty again.
   */
  prune(persist = true): number {
    const { maxItems, maxAgeMs } = this.limits();
    const cutoff = this.now() - maxAgeMs;
    const before = this.stored.length;
    let kept = this.stored.filter((s) => s.entry.queuedAt >= cutoff);
    if (kept.length > maxItems) {
      kept = kept.slice(kept.length - maxItems);
    }
    let bytes = kept.reduce((sum, s) => sum + s.size, 0);
    while (kept.length > 0 && bytes > this.maxBytes()) {
      bytes -= kept.shift()!.size;
    }
    this.stored = kept;
    const dropped = before - kept.length;
    if (dropped > 0) {
      if (!this.dropWarned) {
        this.dropWarned = true;
        this.logger.warn?.(
          `memory-hindsight: retain queue dropped ${dropped} item(s) over retainQueueMaxItems (${maxItems}), retainQueueMaxAgeMs (${maxAgeMs}) or the ${this.maxBytes()}-byte size bound; further drops are not logged until the queue is empty`,
        );
      }
      if (persist) {
        this.persist();
      }
    }
    return dropped;
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
  private markStale(entry: QueuedRetain): void {
    try {
      this.append(tombstoneLine(entry));
    } catch (error) {
      this.logger.warn?.(
        `memory-hindsight: could not mark an out-of-date queued retain (${formatErrorMessage(error)}); a restart may replay it before the newer copy is written again`,
      );
    }
  }

  private persist(): void {
    this.rewrite();
    // Cleared only once written, so a failed replay save is retried by the next save().
    this.dirty = false;
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
    writeFileSync(tmp, text, { mode: 0o600 });
    // writeFileSync keeps the mode of an existing file; force it.
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
    this.fileBytes = Buffer.byteLength(text, "utf8");
  }
}

/**
 * One queue per file per process, shared across service restarts, so a stopped instance can
 * never write a stale copy over the file the current instance owns.
 */
const sharedQueues = new Map<string, RetainQueue>();

export function sharedRetainQueue(
  filePath: string,
  params: { limits: () => RetainQueueLimits; logger: QueueLogger },
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
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Schedules a pass after the current backoff unless one is already scheduled. */
  schedule(delayMs = this.delayMs): void {
    if (this.stopped() || this.timer || this.queue.size() === 0) {
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
    this.queue.prune();
    for (let entry = this.queue.peek(); entry; entry = this.queue.peek()) {
      try {
        await send(entry, this.controller.signal);
      } catch (error) {
        if (this.stopped()) {
          return delivered;
        }
        if (!isDroppingRejection(error)) {
          // Not an answer about this item (outage, auth, rate limit, ambiguous 404, refused
          // redirect, or an unexpected error): keep it and back off.
          if (!isTransportFailure(error) && !this.rejectionWarned) {
            this.rejectionWarned = true;
            logger.warn?.(
              `memory-hindsight: queued retain not delivered (${formatErrorMessage(error)}); ${this.queue.size()} pending, retrying with backoff; new retains for a bank with pending items queue behind it`,
            );
          }
          logger.debug?.(
            `memory-hindsight: retain queue replay deferred (${this.queue.size()} pending): ${formatErrorMessage(error)}`,
          );
          // The pass that just failed waited the current delay; the next one waits twice as long.
          this.schedule();
          this.delayMs = Math.min(
            this.delayMs * 2,
            this.options.maxDelayMs ?? RETAIN_QUEUE_RETRY_MAX_MS,
          );
          return delivered;
        }
        // Hindsight answered 4xx about this item: retrying cannot help, so it leaves the queue.
        this.queue.remove(entry, { persist: false });
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
      this.rejectionWarned = false;
      delivered += 1;
      if (delivered % SAVE_EVERY === 0) {
        this.queue.save();
      }
    }
    this.delayMs = this.baseDelay();
    return delivered;
  }
}
