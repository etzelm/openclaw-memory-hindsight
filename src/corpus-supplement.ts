import { isIncognitoSessionKey } from "openclaw/plugin-sdk/routing";
import { boundedSignal, isBankNotFound } from "./client.js";
import {
  DEFAULT_SUPPLEMENT_SESSION_PATTERNS,
  type HindsightConfig,
  RECALL_MAX_TOKENS,
  RECALL_TIMEOUT_MS,
  recallFilterFor,
} from "./config.js";
import { matchesSessionPattern, ownerBankId, sessionUsesMemory } from "./routing.js";
import type { HindsightService } from "./service.js";
import { neutralizeMemoryTags } from "./transcript.js";

/**
 * Hindsight as a memory corpus supplement (`api.registerMemoryCorpusSupplement`), for sidecar
 * mode: memory-core's `memory_search` with `corpus=wiki` or `corpus=all` also returns Hindsight
 * hits, and `memory_get` reads one back by its `hindsight/<memory id>` path.
 *
 * The host passes a supplement no memory audience (only agent id, session key and sandboxed),
 * so the supplement cannot tell the owner's private conversation from a group or another
 * sender. It therefore answers only from the agent's owner bank, and only for session keys
 * matching `corpusSupplementSessionPatterns` (default `agent:*:main`); every other call gets
 * nothing. Conversation banks are never read here.
 */

/** Params the host passes to `search` (structural copy; not every floor SDK exports it). */
export type CorpusSearchParams = {
  query: string;
  maxResults?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
};

export type CorpusGetParams = {
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
};

export type CorpusSearchResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  citation?: string;
  source?: string;
  provenanceLabel?: string;
  sourceType?: string;
  updatedAt?: string;
};

export type CorpusGetResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
};

export type HindsightCorpusSupplement = {
  search(params: CorpusSearchParams): Promise<CorpusSearchResult[]>;
  get(params: CorpusGetParams): Promise<CorpusGetResult | null>;
};

/**
 * The host groups every supplement under the corpus named "wiki" (memory_search's corpus enum is
 * memory|wiki|all|sessions), so results carry corpus "wiki" and say where they came from in
 * `source`, `sourceType` and `provenanceLabel`.
 */
export const SUPPLEMENT_CORPUS = "wiki";
export const SUPPLEMENT_PATH_PREFIX = "hindsight/";
export const SUPPLEMENT_SOURCE = "hindsight";
export { DEFAULT_SUPPLEMENT_SESSION_PATTERNS };
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 50;
const SNIPPET_MAX_CHARS = 700;
const DEFAULT_GET_LINES = 200;

export type SupplementOptions = {
  /** Session-key globs whose memory_search may read the owner bank. */
  sessionPatterns: readonly string[];
};

/** The owner bank a supplement call may read, or null; see the module comment. */
export function supplementBank(
  config: HindsightConfig,
  options: SupplementOptions,
  params: { agentId?: string; agentSessionKey?: string; sandboxed?: boolean },
): string | null {
  const agentId = params.agentId?.trim();
  const sessionKey = params.agentSessionKey?.trim();
  if (!agentId || !sessionKey || params.sandboxed === true) {
    return null;
  }
  if (config.memoryMode === "context" || isIncognitoSessionKey(sessionKey)) {
    return null;
  }
  if (!matchesSessionPattern(sessionKey, options.sessionPatterns)) {
    return null;
  }
  if (!sessionUsesMemory(config, { sessionKey, purpose: "recall" })) {
    return null;
  }
  return ownerBankId(agentId, config.agentBankMap);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function memoryIdFromLookup(lookup: string): string | null {
  const trimmed = lookup.trim();
  if (!trimmed.startsWith(SUPPLEMENT_PATH_PREFIX)) {
    return null;
  }
  const id = trimmed.slice(SUPPLEMENT_PATH_PREFIX.length);
  // Hindsight memory ids are UUIDs; anything else is not ours (and never reaches the URL).
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id) ? id : null;
}

export function createHindsightCorpusSupplement(params: {
  service: Pick<HindsightService, "config" | "client">;
  options: () => SupplementOptions;
}): HindsightCorpusSupplement {
  const { service } = params;
  return {
    async search(request) {
      const config = service.config();
      const bankId = supplementBank(config, params.options(), request);
      const query = request.query?.trim();
      if (!bankId || !query) {
        return [];
      }
      const limit = Math.min(
        MAX_RESULTS_CAP,
        Math.max(1, Math.floor(request.maxResults ?? DEFAULT_MAX_RESULTS)),
      );
      let results;
      try {
        results = await service.client.recall(bankId, query, {
          budget: config.recallBudget,
          maxTokens: RECALL_MAX_TOKENS,
          ...(config.recallTypes ? { types: config.recallTypes } : {}),
          ...(config.preferObservations === undefined
            ? {}
            : { preferObservations: config.preferObservations }),
          ...recallFilterFor(config, query),
          skipEntities: true,
          signal: boundedSignal(RECALL_TIMEOUT_MS),
        });
      } catch (error) {
        if (isBankNotFound(error)) {
          return [];
        }
        throw error;
      }
      return results.slice(0, limit).map((r, index) => {
        const date = r.occurred_start ?? r.mentioned_at ?? undefined;
        const score =
          typeof r.scores?.final === "number" && Number.isFinite(r.scores.final)
            ? r.scores.final
            : // Server order is the ranking; keep it when no score came back.
              1 / (index + 2);
        return {
          corpus: SUPPLEMENT_CORPUS,
          path: `${SUPPLEMENT_PATH_PREFIX}${r.id}`,
          title: `Hindsight ${r.type ?? "memory"}${date ? ` (${date.slice(0, 10)})` : ""}`,
          kind: r.type ?? "memory",
          score,
          snippet: neutralizeMemoryTags(oneLine(r.text, SNIPPET_MAX_CHARS)),
          id: r.id,
          ...(r.document_id ? { citation: `[doc:${r.document_id}]` } : {}),
          source: SUPPLEMENT_SOURCE,
          sourceType: SUPPLEMENT_SOURCE,
          provenanceLabel: `Hindsight bank ${bankId}`,
          ...(date ? { updatedAt: date } : {}),
        };
      });
    },

    async get(request) {
      const memoryId = memoryIdFromLookup(request.lookup ?? "");
      if (!memoryId) {
        return null;
      }
      const config = service.config();
      const bankId = supplementBank(config, params.options(), request);
      if (!bankId) {
        return null;
      }
      const memory = await service.client.getMemory(
        bankId,
        memoryId,
        boundedSignal(RECALL_TIMEOUT_MS),
      );
      if (!memory) {
        return null;
      }
      const lines = neutralizeMemoryTags(memory.text).split("\n");
      const from = Math.max(1, Math.floor(request.fromLine ?? 1));
      const count = Math.max(1, Math.floor(request.lineCount ?? DEFAULT_GET_LINES));
      const slice = lines.slice(from - 1, from - 1 + count);
      return {
        corpus: SUPPLEMENT_CORPUS,
        path: `${SUPPLEMENT_PATH_PREFIX}${memoryId}`,
        title: "Hindsight memory",
        kind: "memory",
        content: slice.join("\n"),
        fromLine: from,
        lineCount: slice.length,
        id: memoryId,
        provenanceLabel: `Hindsight bank ${bankId}`,
        sourceType: SUPPLEMENT_SOURCE,
      };
    },
  };
}
