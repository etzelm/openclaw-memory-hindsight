import { HindsightHttpError } from "./client.js";
import { isTransportFailure } from "./retain-queue.js";

/** Consecutive outages that open the breaker, and how long auto-recall then skips. */
export const RECALL_BREAKER_THRESHOLD = 3;
export const RECALL_BREAKER_COOLDOWN_MS = 60_000;

export type BreakerState = "closed" | "open";
/** allow: send as usual. probe: the one request after a cool-down. skip: send nothing. */
export type BreakerDecision = "allow" | "probe" | "skip";
export type BreakerTransition = "none" | "opened" | "reopened" | "closed";

/**
 * True when a recall failed because Hindsight was slow or unreachable: a timeout, a network
 * failure or an HTTP 5xx. An answer about the request (4xx, a missing bank, no results) means the
 * server is up, and a host abort says nothing about the server, so neither counts.
 */
export function countsAsRecallOutage(error: unknown): boolean {
  if ((error as { name?: unknown } | null)?.name === "AbortError") {
    return false;
  }
  if (error instanceof HindsightHttpError) {
    return error.status >= 500;
  }
  return isTransportFailure(error);
}

/**
 * One breaker for auto-recall against the one configured server. After `threshold` outages in a
 * row it opens: auto-recall skips without a request for `cooldownMs`, then one probe goes out
 * while every other turn keeps skipping. Any answer to the probe closes it; an outage reopens it.
 */
export class RecallBreaker {
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private failures = 0;
  private openedAt: number | undefined;
  private probing = false;

  constructor(options: { now?: () => number; threshold?: number; cooldownMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.threshold = options.threshold ?? RECALL_BREAKER_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? RECALL_BREAKER_COOLDOWN_MS;
  }

  get cooldownSeconds(): number {
    return Math.round(this.cooldownMs / 1000);
  }

  get failureThreshold(): number {
    return this.threshold;
  }

  state(): BreakerState {
    return this.openedAt === undefined ? "closed" : "open";
  }

  admit(): BreakerDecision {
    if (this.openedAt === undefined) {
      return "allow";
    }
    if (this.probing || this.now() - this.openedAt < this.cooldownMs) {
      return "skip";
    }
    this.probing = true;
    return "probe";
  }

  /** Records a finished request: `error` undefined for a result. `probe` marks the probe. */
  record(error: unknown, probe = false): BreakerTransition {
    const outage = error !== undefined && countsAsRecallOutage(error);
    if (!outage) {
      const wasOpen = this.openedAt !== undefined;
      this.reset();
      return wasOpen ? "closed" : "none";
    }
    if (this.openedAt !== undefined) {
      // Open already: only the probe's answer counts; a late failure of an older request does not.
      if (!probe) {
        return "none";
      }
      this.probing = false;
      this.openedAt = this.now();
      return "reopened";
    }
    this.failures += 1;
    if (this.failures < this.threshold) {
      return "none";
    }
    this.openedAt = this.now();
    this.probing = false;
    return "opened";
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.probing = false;
  }
}
