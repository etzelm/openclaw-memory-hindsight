import { HindsightClient } from "./client.js";
import type { HindsightConfig } from "./config.js";

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
  logger: HindsightLogger;
  stopped(): boolean;
  stop(): void;
  start(): void;
};

export function createHindsightService(params: {
  config: () => HindsightConfig;
  logger: HindsightLogger;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): HindsightService {
  const preparedBanks = new Map<string, Promise<void>>();
  let stopped = false;
  const client = new HindsightClient({
    resolveEndpoint: () => {
      const { apiUrl, apiToken } = params.config();
      return { apiUrl, ...(apiToken ? { apiToken } : {}) };
    },
    ...(params.fetch ? { fetch: params.fetch } : {}),
  });
  return {
    config: params.config,
    client,
    logger: params.logger,
    async ensureBank(bankId, signal) {
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
    },
    stopped: () => stopped,
    stop() {
      stopped = true;
      preparedBanks.clear();
    },
    start() {
      stopped = false;
    },
  };
}
