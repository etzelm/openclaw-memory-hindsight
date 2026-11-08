import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { boundedSignal, HindsightClient, type HindsightRetainItem } from "./client.js";
import { type HindsightConfig, RETAIN_TIMEOUT_MS } from "./config.js";
import {
  BankSetupError,
  isDroppingRejection,
  isTransportFailure,
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
   * error, timeout, 5xx), the item is queued for this bank and replayed later; a 4xx still throws.
   */
  retainOrQueue(
    bankId: string,
    item: HindsightRetainItem & { document_id: string },
    signal: AbortSignal,
  ): Promise<"sent" | "queued">;
  /** Opens the queue file under the host state dir and replays what an earlier run left. */
  startRetainQueue(stateDir: string | undefined): void;
  retainQueue(): RetainQueueRunner | undefined;
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
}): HindsightService {
  const preparedBanks = new Map<string, Promise<void>>();
  let stopped = false;
  let runner: RetainQueueRunner | undefined;
  // Kept after stop, so a live retain that fails after a stop or restart still lands in the file.
  let queue: RetainQueue | undefined;
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
          void runner.flush();
          return "queued";
        }
        // Not queued (too large, already warned, or the write failed): send it live without
        // waiting for the bank's queue, and do not try to queue it again.
        refused = true;
      }
      try {
        await write(bankId, item, signal);
      } catch (error) {
        // Read again after the await: the service may have stopped or restarted meanwhile.
        const target = queue;
        if (!target || refused || !isTransportFailure(error)) {
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
          throw error;
        }
        params.logger.warn?.(
          `memory-hindsight: Hindsight unreachable, retain queued (${target.size()} pending): ${formatErrorMessage(error)}`,
        );
        runner?.schedule();
        return "queued";
      }
      if (runner && queue && queue.size() > 0) {
        void runner.flush();
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
        queue = sharedRetainQueue(retainQueuePath(stateDir), { limits, logger: params.logger });
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
    stopped: () => stopped,
    stop() {
      stopped = true;
      stopQueue();
      preparedBanks.clear();
    },
    start() {
      stopped = false;
    },
  };
}
