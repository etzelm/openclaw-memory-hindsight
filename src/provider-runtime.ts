import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { boundedSignal, isBankNotFound } from "./client.js";
import { GET_TIMEOUT_MS, RECALL_MAX_TOKENS, RECALL_TIMEOUT_MS } from "./config.js";
import { type AgentBankMap, ownerBankId, routeAudience } from "./routing.js";
import type { MemoryPluginCapability } from "./sdk-types.js";
import type { HindsightService } from "./service.js";

type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type MemoryProviderOpenParams = Parameters<MemoryProviderRuntime["open"]>[0];
type MemoryProviderHandle = NonNullable<
  Awaited<ReturnType<MemoryProviderRuntime["open"]>>["provider"]
>;
type MemoryCallerAuthority = MemoryProviderOpenParams["context"]["authority"];
type MemorySearchHit = Awaited<ReturnType<MemoryProviderHandle["search"]>>["hits"][number];

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

export function createHindsightProviderRuntime(params: {
  providerId: string;
  service: HindsightService;
}): MemoryProviderRuntime {
  const { providerId, service } = params;
  return {
    async open({ agentId: rawAgentId, context }: MemoryProviderOpenParams) {
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
      const reference = (id: string) => ({ providerId, id });

      const provider: MemoryProviderHandle = {
        capabilities: {
          sources: ["memory"],
          pagination: false,
          candidates: [],
          projectFilter: false,
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
          // Health reaches every authenticated caller: no memory text, URLs or tokens.
          const details = { backend: "hindsight", autoRecall, autoRetain, memoryMode };
          const healthy = await service.client.healthy();
          assertCurrent();
          return healthy
            ? { status: "ready", details }
            : {
                status: "unavailable",
                message: "The Hindsight API is not reachable. Check the Gateway log.",
                details,
              };
        },
        // The HTTP client is shared with hooks and tools; nothing is leased per caller.
        async close() {},
      };
      return { provider };
    },
  };
}
