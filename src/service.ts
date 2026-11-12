import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { boundedSignal, HindsightClient, type HindsightRetainItem } from "./client.js";
import { type HindsightConfig, RETAIN_TIMEOUT_MS } from "./config.js";
import type { HindsightMetrics } from "./metrics.js";
import {
  BankSetupError,
  isDroppingRejection,
  isQueueableLiveFailure,
  isTransportFailure,
  type QueuedRetain,
  type RetainQueue,
  RetainQueueRunner,
  retainQueuePath,
  sharedRetainQueue,
} from "./retain-queue.js";

export type HindsightLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

/** Shared state for the plugin's hooks, tools and provider runtime. */
export type HindsightService = {
  config(): HindsightConfig;
  client: HindsightClient;
  /** Applies configured missions once per bank per process before the first write. */
  ensureBank(bankId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Writes an auto-retain. When the offline queue runs and Hindsight is unreachable (network
   * error, timeout, 5xx) or refuses for a reason that is not about the item (401, 403, 408, 429),
   * the item is queued for this bank and replayed later; any other 4xx still throws. A write still
   * in flight when the service stops is queued at the stop.
   */
  retainOrQueue(
    bankId: string,
    item: HindsightRetainItem & { document_id: string },
    signal: AbortSignal,
  ): Promise<"sent" | "queued">;
  /** Opens the queue file under the host state dir and replays what an earlier run left. */
  startRetainQueue(stateDir: string | undefined): void;
  retainQueue(): RetainQueueRunner | undefined;
  /** Queued items per bank id, or undefined when the queue is off. */
  retainQueueDepth(): Map<string, number> | undefined;
  logger: HindsightLogger;
  stopped(): boolean;
  stop(): void;
  start(): void;
};

export function createHindsightService(params: {
  config: () => HindsightConfig;
  logger: HindsightLogger;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  retainQueueRetry?: { baseDelayMs?: number; maxDelayMs?: number };
  metrics?: HindsightMetrics;
}): HindsightService {
  const { metrics } = params;
  // Queue and replay observers feed the gateway metrics; none when the caller passes no metrics.
  const queueObserver = metrics ? { onDrop: metrics.recordDrop.bind(metrics) } : {};
  const runnerObserver = metrics
    ? { onDrop: metrics.recordDrop.bind(metrics), onReplay: metrics.recordReplay.bind(metrics) }
    : {};
  const preparedBanks = new Map<string, Promise<void>>();
  let stopped = false;
  let runner: RetainQueueRunner | undefined;
  // Kept after stop, so a live retain that fails after a stop or restart still lands in the file.
  let queue: RetainQueue | undefined;
  // Live auto-retains not answered yet; stop() queues them so a Gateway exit cannot lose them.
  const inFlight = new Set<Omit<QueuedRetain, "queuedAt">>();
  // Those stop() queued; a write that then succeeds removes its own queued copy again.
  const parkedAtStop = new WeakSet<Omit<QueuedRetain, "queuedAt">>();
  const client = new HindsightClient({
    resolveEndpoint: () => {
      const { apiUrl, apiToken } = params.config();
      return { apiUrl, ...(apiToken ? { apiToken } : {}) };
    },
    ...(params.fetch ? { fetch: params.fetch } : {}),
  });
  const ensureBank = async (bankId: string, signal?: AbortSignal) => {
    let pending = preparedBanks.get(bankId);
    if (!pending) {
      const { retainMission } = params.config();
      pending = client.applyBankDefaults(bankId, { retainMission }, signal);
      preparedBanks.set(bankId, pending);
      // A failed setup retries on the next write instead of caching the failure.
      pending.catch(() => {
        if (preparedBanks.get(bankId) === pending) {
          preparedBanks.delete(bankId);
        }
      });
    }
    await pending;
  };
  const write = async (bankId: string, item: HindsightRetainItem, signal: AbortSignal) => {
    await ensureBank(bankId, signal);
    await client.retain(bankId, item, { signal });
  };
  const stopQueue = () => {
    runner?.stop();
    runner = undefined;
  };
  return {
    config: params.config,
    client,
    logger: params.logger,
    ensureBank,
    async retainOrQueue(bankId, item, signal) {
      const entry = { bankId, documentId: item.document_id, item };
      // Items already waiting for this bank go first, so the bank sees its writes in order.
      let refused = false;
      if (runner && queue?.hasBank(bankId)) {
        let queued = false;
        try {
          queued = queue.enqueue(entry);
        } catch (queueError) {
          // Disk full or not writable: warn and try a live write, as the failure path does.
          params.logger.warn?.(
            `memory-hindsight: could not queue retain (${formatErrorMessage(queueError)}); sending it now`,
          );
        }
        if (queued) {
          void runner.nudge();
          return "queued";
        }
        // Not queued (too large, already warned, or the write failed): send it live without
        // waiting for the bank's queue, and do not try to queue it again.
        refused = true;
      }
      if (!refused) {
        inFlight.add(entry);
      }
      try {
        await write(bankId, item, signal);
        // Answered: stop() no longer needs to queue it, and a copy stop() queued is out of date.
        inFlight.delete(entry);
        if (parkedAtStop.has(entry)) {
          queue?.discard(entry, entry.item);
        }
      } catch (error) {
        inFlight.delete(entry);
        // Read again after the await: the service may have stopped or restarted meanwhile.
        const target = queue;
        if (!target || refused || !isQueueableLiveFailure(error)) {
          // Queue-first path: the queue refused the item and the live write failed, so it is lost.
          if (target && refused && isTransportFailure(error) && target.isTooLarge(entry)) {
            metrics?.recordDrop(bankId, "too_large");
          }
          throw error;
        }
        let queued: boolean;
        try {
          queued = target.enqueue(entry);
        } catch (queueError) {
          params.logger.warn?.(
            `memory-hindsight: could not queue retain (${formatErrorMessage(queueError)})`,
          );
          throw error;
        }
        if (!queued) {
          // Lost: the live write failed and the queue refused it. A bound that dropped the new item
          // is already counted as `limit` by the queue.
          if (target.isTooLarge(entry)) {
            metrics?.recordDrop(bankId, "too_large");
          }
          throw error;
        }
        params.logger.warn?.(
          isTransportFailure(error)
            ? `memory-hindsight: Hindsight unreachable, retain queued (${target.size()} pending): ${formatErrorMessage(error)}`
            : `memory-hindsight: Hindsight refused the retain for now, queued (${target.size()} pending): ${formatErrorMessage(error)}`,
        );
        runner?.schedule();
        return "queued";
      }
      // A delivered copy replay has not saved yet must not come back over this one.
      queue?.supersede(entry);
      if (runner && queue && queue.size() > 0) {
        void runner.nudge();
      }
      return "sent";
    },
    startRetainQueue(stateDir) {
      stopQueue();
      queue = undefined;
      if (!params.config().retainQueueEnabled) {
        return;
      }
      // The service contract always passes stateDir; only a bare test harness omits it.
      if (!stateDir) {
        params.logger.debug?.(
          "memory-hindsight: host gave no state dir; failed retains are not queued",
        );
        return;
      }
      const limits = () => {
        const config = params.config();
        return { maxItems: config.retainQueueMaxItems, maxAgeMs: config.retainQueueMaxAgeMs };
      };
      try {
        queue = sharedRetainQueue(retainQueuePath(stateDir), {
          limits,
          logger: params.logger,
          ...queueObserver,
        });
      } catch (error) {
        queue = undefined;
        params.logger.warn?.(
          `memory-hindsight: retain queue unavailable, failed retains are not queued (${formatErrorMessage(error)})`,
        );
        return;
      }
      runner = new RetainQueueRunner(queue, {
        send: async (entry, stopSignal) => {
          const signal = boundedSignal(RETAIN_TIMEOUT_MS, stopSignal);
          try {
            await ensureBank(entry.bankId, signal);
          } catch (error) {
            // A setup 4xx is about the bank config, not this item: keep it (see BankSetupError).
            throw isDroppingRejection(error) ? new BankSetupError(error) : error;
          }
          // Replay may repeat a delivered item (a crash before the batched save); a replace of
          // the same document id makes the repeat a no-op on the server.
          await client.retain(
            entry.bankId,
            { ...entry.item, document_id: entry.documentId, update_mode: "replace" },
            { signal },
          );
        },
        logger: params.logger,
        ...runnerObserver,
        ...params.retainQueueRetry,
      });
      if (queue.size() > 0) {
        params.logger.info?.(
          `memory-hindsight: ${queue.size()} queued retain(s) from an earlier run, replaying`,
        );
        void runner.flush();
      }
    },
    retainQueue: () => runner,
    retainQueueDepth: () => queue?.depthByBank(),
    stopped: () => stopped,
    stop() {
      stopped = true;
      // stop() is synchronous and the host may exit right after it: put unanswered live writes
      // in the file now. A write that still succeeds removes its copy; a replay is a replace.
      // Without eviction: a full queue keeps its items, and the write that cannot be parked is
      // lost only if the host really exits before it is answered.
      let notParked = 0;
      for (const entry of inFlight) {
        try {
          if (queue?.enqueue(entry, { evict: false })) {
            parkedAtStop.add(entry);
          } else if (queue) {
            notParked += 1;
          }
        } catch (error) {
          params.logger.warn?.(
            `memory-hindsight: could not queue an in-flight retain at stop (${formatErrorMessage(error)})`,
          );
        }
      }
      if (notParked > 0) {
        params.logger.warn?.(
          `memory-hindsight: retain queue full at stop; ${notParked} in-flight retain(s) not queued`,
        );
      }
      inFlight.clear();
      stopQueue();
      preparedBanks.clear();
    },
    start() {
      stopped = false;
    },
  };
}
