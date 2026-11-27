import { createHash } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isIncognitoSessionKey, normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { boundedSignal, isBankNotFound } from "./client.js";
import {
  GET_TIMEOUT_MS,
  RECALL_MAX_TOKENS,
  RECALL_TIMEOUT_MS,
  RETAIN_SOURCE,
  RETAIN_TIMEOUT_MS,
} from "./config.js";
import {
  type BackendAwareOpenParams,
  createFusedHandle,
  type MemoryProviderHandle,
  type MemorySearchHit,
  type MemoryStoreRequest,
  type MemoryStoreResult,
  openBackends,
} from "./memory-backends.js";
import type { BreakerState, RecallErrorClass } from "./recall-breaker.js";
import { type AgentBankMap, ownerBankId, routeAudience, sessionUsesMemory } from "./routing.js";
import type { MemoryPluginCapability } from "./sdk-types.js";
import type { HindsightService } from "./service.js";

type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type MemoryProviderOpenParams = Parameters<MemoryProviderRuntime["open"]>[0];
type MemoryCallerAuthority = MemoryProviderOpenParams["context"]["authority"];

/** Document ids of memories written through the provider's store (memory backends). */
export const STORE_DOCUMENT_PREFIX = "openclaw-store:";
/** Reference ids that name a stored document rather than a Hindsight memory. */
const DOC_REFERENCE_PREFIX = "doc:";
const MAX_STORE_TAGS = 32;

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 50;

type BankGrant = { bankId: string } | { denial: string };

/**
 * Operators read the opened agent's owner bank. A session reads only the bank its host-minted
 * audience selects (owner-private or its own conversation). Host authority reads nothing.
 */
export function resolveBankGrant(
  authority: MemoryCallerAuthority,
  agentId: string,
  bankMap?: AgentBankMap,
): BankGrant {
  if (authority.kind === "operator") {
    return { bankId: ownerBankId(agentId, bankMap) };
  }
  if (authority.kind === "host") {
    return { denial: "host operations cannot read stored memories" };
  }
  const route = routeAudience(agentId, authority.audience, bankMap);
  return route.ok ? { bankId: route.bankId } : { denial: route.reason };
}

/**
 * The bank a store() may write, or null for a read-only lease. Only a session with a host-minted
 * audience writes, under the same rules as hindsight_retain: never in context mode, incognito,
 * or a session excluded from retain. Operators and host operations never write.
 */
export function resolveStoreBank(
  authority: MemoryCallerAuthority,
  agentId: string,
  config: ReturnType<HindsightService["config"]>,
): string | null {
  if (authority.kind !== "session" || config.memoryMode === "context") {
    return null;
  }
  if (
    isIncognitoSessionKey(authority.sessionKey) ||
    !sessionUsesMemory(config, { sessionKey: authority.sessionKey, purpose: "retain" })
  ) {
    return null;
  }
  const route = routeAudience(agentId, authority.audience, config.agentBankMap);
  return route.ok ? route.bankId : null;
}

/** Same bank and text, same document: a retried store or a repeated flush replaces itself. */
export function storeDocumentId(bankId: string, text: string): string {
  const digest = createHash("sha256").update(`${bankId}\u0000${text}`).digest("hex");
  return `${STORE_DOCUMENT_PREFIX}${digest.slice(0, 32)}`;
}

function sliceLines(text: string, from: number | undefined, lines: number | undefined) {
  const all = text.split("\n");
  const start = Math.max(1, Math.floor(from ?? 1));
  const count = lines === undefined ? all.length : Math.max(1, Math.floor(lines));
  const selected = all.slice(start - 1, start - 1 + count);
  const end = start - 1 + selected.length;
  const truncated = end < all.length;
  return {
    text: selected.join("\n"),
    from: start,
    lines: selected.length,
    truncated,
    ...(truncated ? { nextFrom: end + 1 } : {}),
  };
}

/** Auto-recall state for health: the breaker and how the last auto-recall failed, if it did. */
export type RecallHealth = { breaker: BreakerState; lastError?: RecallErrorClass };

/** Why a reachable Hindsight is reported as degraded; empty when it is ready. */
function degradedReasons(queueDepth: number, recall: RecallHealth | undefined): string[] {
  const reasons: string[] = [];
  if (queueDepth > 0) {
    reasons.push(`${queueDepth} ${queueDepth === 1 ? "retain" : "retains"} queued for replay`);
  }
  if (recall?.breaker === "open") {
    reasons.push("auto-recall paused by the circuit breaker");
  }
  if (recall?.lastError) {
    reasons.push(`last auto-recall failed (${recall.lastError})`);
  }
  return reasons;
}

export function createHindsightProviderRuntime(params: {
  providerId: string;
  service: HindsightService;
  recallHealth?: () => RecallHealth;
  /**
   * Offer store() on writable leases. Only the backend role sets it: a host that loads this
   * plugin as a memory backend knows the field, and an older host never sees it.
   */
  store?: boolean;
}): MemoryProviderRuntime {
  const { providerId, service } = params;
  const reference = (id: string) => ({ providerId, id });
  const own = {
    async open({ agentId: rawAgentId, context, purpose }: MemoryProviderOpenParams) {
      if (!rawAgentId?.trim()) {
        return { provider: null, error: "An agent id is required for Hindsight memory." };
      }
      const agentId = normalizeAgentId(rawAgentId);
      const grant = resolveBankGrant(context.authority, agentId, service.config().agentBankMap);
      const assertCurrent = () => {
        context.assertCurrent();
        context.signal?.throwIfAborted();
        if (service.stopped()) {
          throw new Error("memory-hindsight: the plugin has stopped");
        }
      };
      const readableBank = (): string => {
        if ("denial" in grant) {
          throw new Error(`memory-hindsight: memory access denied: ${grant.denial}`);
        }
        assertCurrent();
        return grant.bankId;
      };
      const storeBank =
        params.store && purpose !== "status"
          ? resolveStoreBank(context.authority, agentId, service.config())
          : null;
      const provider: MemoryProviderHandle = {
        capabilities: {
          sources: ["memory"],
          pagination: false,
          candidates: [],
          projectFilter: false,
          ...(storeBank ? { store: true } : {}),
        },
        async search(request) {
          if ("denial" in grant) {
            // Like an owner filtering every hit: cross-session consumers get no rows, no failure.
            assertCurrent();
            return {
              hits: [],
              warning: `memory-hindsight: stored memories were not searched: ${grant.denial}`,
            };
          }
          const bankId = readableBank();
          const query = request.query.trim();
          if (!query) {
            return { hits: [], coverage: "complete" };
          }
          const config = service.config();
          const maxResults = Math.min(
            MAX_RESULTS,
            Math.max(1, Math.floor(request.maxResults ?? DEFAULT_MAX_RESULTS)),
          );
          const minScore = request.minScore;
          let results;
          try {
            results = await service.client.recall(bankId, query, {
              budget: config.recallBudget,
              maxTokens: RECALL_MAX_TOKENS,
              ...(config.recallTypes ? { types: config.recallTypes } : {}),
              ...(minScore === undefined ? {} : { minScores: { final: minScore } }),
              signal: AbortSignal.any(
                [context.signal, AbortSignal.timeout(RECALL_TIMEOUT_MS)].filter(
                  (signal): signal is AbortSignal => Boolean(signal),
                ),
              ),
            });
          } catch (error) {
            if (isBankNotFound(error)) {
              assertCurrent();
              return { hits: [], coverage: "complete" };
            }
            throw new Error(
              `memory-hindsight: memory search failed: ${formatErrorMessage(error)}`,
              {
                cause: error,
              },
            );
          }
          assertCurrent();
          const hits = results
            // An unscored hit cannot be shown to clear a floor, so a floor drops it.
            .filter((r) => {
              const score = r.scores?.final;
              return minScore === undefined || (typeof score === "number" && score >= minScore);
            })
            .slice(0, maxResults)
            .map((r): MemorySearchHit => {
              const ref = reference(r.id);
              const hit: MemorySearchHit = {
                reference: ref,
                excerpt: r.text,
                source: "memory",
                citations: [{ label: `hindsight:${r.id}`, reference: ref }],
              };
              const score = r.scores?.final;
              if (typeof score === "number") {
                hit.score = score;
              }
              return hit;
            });
          return { hits, coverage: "complete" };
        },
        async get(request) {
          const bankId = readableBank();
          const { id, revision } = request.reference;
          // Hindsight memories carry no revisions; a revisioned reference names nothing current.
          if (request.reference.providerId !== providerId || revision !== undefined || !id) {
            return { status: "not_found" };
          }
          if (id.startsWith(DOC_REFERENCE_PREFIX)) {
            const documentId = id.slice(DOC_REFERENCE_PREFIX.length);
            const document = documentId.startsWith(STORE_DOCUMENT_PREFIX)
              ? await service.client.getDocument(
                  bankId,
                  documentId,
                  boundedSignal(GET_TIMEOUT_MS, context.signal),
                )
              : null;
            assertCurrent();
            if (!document || typeof document.text !== "string") {
              return { status: "not_found" };
            }
            const ref = reference(id);
            return {
              status: "ok",
              reference: ref,
              citations: [{ label: `hindsight:${id}`, reference: ref }],
              ...sliceLines(document.text, request.from, request.lines),
            };
          }
          const memory = await service.client.getMemory(
            bankId,
            id,
            boundedSignal(GET_TIMEOUT_MS, context.signal),
          );
          assertCurrent();
          if (!memory) {
            return { status: "not_found" };
          }
          const ref = reference(id);
          return {
            status: "ok",
            reference: ref,
            citations: [{ label: `hindsight:${id}`, reference: ref }],
            ...sliceLines(memory.text, request.from, request.lines),
          };
        },
        async health() {
          assertCurrent();
          const { autoRecall, autoRetain, memoryMode } = service.config();
          const healthy = await service.client.healthy();
          assertCurrent();
          // Health reaches every authenticated caller: counts and fixed words only, no memory
          // text, bank ids, URLs, error messages or tokens.
          let queueDepth = 0;
          for (const depth of service.retainQueueDepth()?.values() ?? []) {
            queueDepth += depth;
          }
          const recall = params.recallHealth?.();
          const details = {
            backend: "hindsight",
            autoRecall,
            autoRetain,
            memoryMode,
            retainQueueDepth: queueDepth,
            recallBreaker: recall?.breaker ?? "closed",
            ...(recall?.lastError ? { lastRecallError: recall.lastError } : {}),
          };
          if (!healthy) {
            return {
              status: "unavailable",
              message: "The Hindsight API is not reachable. Check the Gateway log.",
              details,
            };
          }
          const reasons = degradedReasons(queueDepth, recall);
          return reasons.length > 0
            ? {
                status: "degraded",
                message: `Hindsight answers, but ${reasons.join("; ")}. Check the Gateway log.`,
                details,
              }
            : { status: "ready", details };
        },
        // The HTTP client is shared with hooks and tools; nothing is leased per caller.
        async close() {},
      };
      if (storeBank) {
        provider.store = async (request: MemoryStoreRequest): Promise<MemoryStoreResult> => {
          const text = typeof request.text === "string" ? request.text.trim() : "";
          if (!text) {
            return { status: "rejected", reason: "memory-hindsight: nothing to store" };
          }
          assertCurrent();
          const config = service.config();
          const tags = [
            ...new Set(
              [...config.retainTags, ...(request.tags ?? [])]
                .filter((tag): tag is string => typeof tag === "string")
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ].slice(0, MAX_STORE_TAGS);
          const title = typeof request.title === "string" ? request.title.trim() : "";
          const documentId = storeDocumentId(storeBank, text);
          const signal = boundedSignal(RETAIN_TIMEOUT_MS, context.signal);
          await service.ensureBank(storeBank, signal);
          assertCurrent();
          const authority = context.authority;
          await service.client.retain(
            storeBank,
            {
              content: text,
              ...(title ? { context: title } : {}),
              ...(tags.length > 0 ? { tags } : {}),
              document_id: documentId,
              update_mode: "replace",
              metadata: {
                source: RETAIN_SOURCE,
                agent_id: agentId,
                ...(authority.kind === "session" ? { session_key: authority.sessionKey } : {}),
                retention_scope: `provider_store_${request.origin ?? "tool"}`,
              },
            },
            { async: true, signal },
          );
          assertCurrent();
          return { status: "stored", reference: reference(`${DOC_REFERENCE_PREFIX}${documentId}`) };
        };
      }
      return { provider };
    },
  };
  return {
    async open(openParams: MemoryProviderOpenParams) {
      const opened = await own.open(openParams);
      // Fusion owner: the host passes backends only to the selected slot owner, and only on
      // hosts with memory backends. Without them the handle is exactly the 0.11 one.
      const { backends } = openParams as BackendAwareOpenParams;
      if (!opened.provider || !backends || backends.list().length === 0) {
        return opened;
      }
      let fused: Awaited<ReturnType<typeof openBackends>>;
      try {
        fused = await openBackends(backends);
      } catch (error) {
        await opened.provider.close();
        throw error;
      }
      return {
        provider: createFusedHandle({
          ownerId: providerId,
          own: opened.provider,
          backends: fused.backends,
          openFailures: fused.failures,
        }),
      };
    },
  } as MemoryProviderRuntime;
}
