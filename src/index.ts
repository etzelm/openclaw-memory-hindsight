import { createHash } from "node:crypto";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isIncognitoSessionKey, normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { registerHindsightCli } from "./cli.js";
import { type HindsightRecallResult, isBankNotFound } from "./client.js";
import {
  autoRecallRequest,
  configForAgent,
  GET_TIMEOUT_MS,
  type HindsightConfig,
  hasUnresolvedToken,
  hindsightConfigSchema,
  isPlainHttpRemote,
  PLUGIN_ID,
  readPluginConfigEntry,
  RETAIN_SOURCE,
  RETAIN_TIMEOUT_MS,
} from "./config.js";
import {
  CONVERSATION_RECALL_TOOL,
  conversationRecallCapabilityFields,
  createConversationRecallTool,
  createSessionStoreAccess,
} from "./conversation-recall.js";
import { createHindsightCorpusSupplement } from "./corpus-supplement.js";
import { createDirectiveCache } from "./directives.js";
import { runDocumentId } from "./document-ids.js";
import {
  createLearnContribution,
  buildMemoryPromptSection,
  createLegacyLearnFields,
  createProviderFlushPlanResolver,
  RECALL_TOOL_NAMES,
} from "./memory-capability.js";
import { syncMemoryFiles } from "./memory-file-sync.js";
import {
  createMetricsRouteHandler,
  HindsightMetrics,
  isTimeoutError,
  METRICS_ROUTE_PATH,
} from "./metrics.js";
import { createHindsightProviderRuntime } from "./provider-runtime.js";
import {
  type BreakerTransition,
  RecallBreaker,
  type RecallErrorClass,
  recallErrorClass,
} from "./recall-breaker.js";
import { isMaintenanceTurn, ownerBankId, routeAudience, sessionUsesMemory } from "./routing.js";
import { type MemoryPluginCapability, resolveLearnRegistrar } from "./sdk-types.js";
import { createHindsightService } from "./service.js";
import {
  activeMemoryCoverage,
  memorySlotIsSet,
  refusedOwner,
  registrationPlan,
  resolveSlotRole,
} from "./slot-mode.js";
import {
  createFlushDeduper,
  createKnowledgePageTool,
  createKnowledgeSearchTool,
  createKnowledgeTreeTool,
  createRecallTool,
  createReflectTool,
  createRetainTool,
  KB_PAGE_TOOL,
  KB_SEARCH_TOOL,
  KB_TREE_TOOL,
  RECALL_TOOL,
  REFLECT_TOOL,
  RETAIN_TOOL,
} from "./tools.js";
import {
  buildRecallContext,
  expandFollowupQuery,
  extractRecallQuery,
  isEphemeralOperationalText,
  isShortFollowup,
  prepareRetentionTranscript,
  previousUserQuery,
  retainStartIndex,
  runStartMarker,
} from "./transcript.js";

export { PLUGIN_ID, readPluginConfigEntry } from "./config.js";
export { sessionKeyDigest } from "./document-ids.js";
// Bounds per-session run markers; one entry per active session is enough.
const MAX_RUN_MARKERS = 1_000;
// Bounds the auto-recall cache; one entry per active session, oldest dropped first.
const MAX_RECALL_CACHE_SESSIONS = 512;
// memory.status reports the last auto-recall failure for this long (five breaker cool-downs).
const LAST_RECALL_ERROR_TTL_MS = 5 * 60_000;
// recallEarlyStart: an early result is used only while younger than recallTimeoutMs plus this, so
// a message queued behind a long run never gets a recall from long before its turn.
const EARLY_RECALL_GRACE_MS = 5_000;

type RecallResults = HindsightRecallResult[];
type RecallCacheEntry = {
  bankId: string;
  queryHash: string;
  results: RecallResults;
  at: number;
};
type RecallSource = "fresh" | "cached" | "early" | "followup-skip" | "followup-expanded";

function queryDigest(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

/**
 * Cache key of one auto-recall request: the whole request (`autoRecallRequest(...).key`: server,
 * query, tag filter, score floor, types, budget, entities), so a live change of any of them never
 * serves a result recalled under the old settings. The cap is applied at injection, so a cached
 * result honors a live recallTopK change.
 */
function cacheDigest(requestKey: string): string {
  return queryDigest(requestKey);
}

/** True when auto-recall is on globally or for any agent in `agents`. */
function autoRecallAnywhere(config: HindsightConfig): boolean {
  return config.autoRecall || Object.values(config.agents).some((a) => a.autoRecall === true);
}

/** How an early recall ended, settled once; it never rejects. */
type EarlyOutcome =
  | { ok: true; results: RecallResults; ms: number; outages: number }
  | { ok: false; error: unknown; ms: number };

/** Sets a session entry as the newest; drops the oldest past MAX_RECALL_CACHE_SESSIONS. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_RECALL_CACHE_SESSIONS) {
    map.delete(map.keys().next().value!);
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Memory (Hindsight)",
  description: "Hindsight-backed long-term memory with auto-recall, auto-retain and agent tools",
  // No runtime `kind`: openclaw.plugin.json declares it (the entry field is deprecated), and the
  // host reads an entry kind over the manifest, which would keep the kind-less sidecar build
  // (scripts/sidecar-variant.mjs) out of a host whose memory slot another plugin owns.
  configSchema: hindsightConfigSchema,

  register(api: OpenClawPluginApi) {
    // Before the config check, so `openclaw hindsight doctor` can explain a config that keeps the
    // plugin disabled. Help and routing read the manifest's cliCommands; a metadata load needs
    // nothing else from this plugin.
    registerHindsightCli(api);
    if (api.registrationMode === "cli-metadata") {
      return;
    }
    let startupConfig: HindsightConfig;
    try {
      startupConfig = hindsightConfigSchema.parse(api.pluginConfig);
    } catch (error) {
      api.registerService({
        id: PLUGIN_ID,
        start: () => {
          api.logger.warn(
            `memory-hindsight: disabled until configured (${formatErrorMessage(error)})`,
          );
        },
      });
      return;
    }

    // Live config so `openclaw config set` and secret reloads apply without a restart. Reads the
    // host's current snapshot (api.runtime.config.current), falling back to api.pluginConfig.
    const currentConfig = (): HindsightConfig => {
      let live: Record<string, unknown> | undefined;
      try {
        live = readPluginConfigEntry(api.runtime?.config?.current?.(), PLUGIN_ID);
      } catch {
        live = undefined;
      }
      if (!live || live === api.pluginConfig) {
        return startupConfig;
      }
      try {
        return hindsightConfigSchema.parse(live);
      } catch (error) {
        api.logger.warn?.(
          `memory-hindsight: ignoring invalid live config (${formatErrorMessage(error)})`,
        );
        return startupConfig;
      }
    };

    const metrics = new HindsightMetrics();
    const service = createHindsightService({
      config: currentConfig,
      logger: api.logger,
      metrics,
    });
    // Gateway-side metrics on the gateway port, behind gateway auth (see metrics.ts for why this
    // is a plugin route and not diagnostics-prometheus). The floor host has the method; the check
    // only keeps a host or test double without it from failing registration.
    if (typeof api.registerHttpRoute !== "function") {
      api.logger.debug?.(
        "memory-hindsight: host has no registerHttpRoute; metrics route not served",
      );
    }
    api.registerHttpRoute?.({
      path: METRICS_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createMetricsRouteHandler(metrics, () => service.retainQueueDepth()),
    });
    const flushDeduper = createFlushDeduper();
    // Per session: where the current run started, kept for the whole run (by runId) so a second
    // agent_end for the run (host continuation after a retry, or a re-delivery) re-sends all of it.
    const runStartBySession = new Map<string, { runId?: string; marker: string | null }>();

    // Last auto-recall per session (never shared across sessions; the bank is checked on read).
    const recallCache = new Map<string, RecallCacheEntry>();

    // Auto-recall is awaited on the reply path. When Hindsight is slow or down, the breaker turns
    // a timeout on every turn into a skip without a request, then probes once per cool-down.
    // Reset when the API URL changes, since its state describes one server.
    const recallBreaker = new RecallBreaker();
    let breakerApiUrl: string | undefined;
    // For memory.status: how the last auto-recall failed, cleared by the next one that answers
    // and reported for LAST_RECALL_ERROR_TTL_MS only, so one failure on an idle Gateway does not
    // leave the status degraded.
    let lastRecallError: { kind: RecallErrorClass; at: number } | undefined;
    const noteRecallError = (kind: RecallErrorClass | undefined) => {
      if (kind) {
        lastRecallError = { kind, at: Date.now() };
      }
    };
    const reportedRecallError = (): RecallErrorClass | undefined =>
      lastRecallError &&
      Date.now() - lastRecallError.at < LAST_RECALL_ERROR_TTL_MS &&
      autoRecallAnywhere(currentConfig())
        ? lastRecallError.kind
        : undefined;
    const noteBreaker = (transition: BreakerTransition) => {
      if (transition === "opened") {
        api.logger.warn?.(
          `memory-hindsight: auto-recall paused for ${recallBreaker.cooldownSeconds} s after ${recallBreaker.failureThreshold} failed recalls (Hindsight slow or unreachable)`,
        );
      } else if (transition === "reopened") {
        api.logger.debug?.("memory-hindsight: auto-recall probe failed; paused again");
      } else if (transition === "closed") {
        api.logger.info?.("memory-hindsight: auto-recall resumed");
      }
    };

    // promptDirectives: the owner bank's active global directives, listed in the static prompt
    // section. Fetched at service start and refreshed in the background after a TTL, never on
    // the reply path, so the cached prompt prefix changes only when the directives do.
    const directiveCache = startupConfig.promptDirectives
      ? createDirectiveCache({
          fetch: (bankId) =>
            service.client.listDirectives(bankId, {
              activeOnly: true,
              signal: AbortSignal.timeout(GET_TIMEOUT_MS),
            }),
          onError: (bankId, error) => {
            api.logger.warn?.(
              `memory-hindsight: could not read the directives of bank ${bankId} (${formatErrorMessage(error)}); the prompt keeps the last list`,
            );
          },
        })
      : undefined;
    const directiveBank = (agentId: string | undefined) =>
      ownerBankId(agentId || "main", startupConfig.agentBankMap);

    // Private transcript recall: opt-in, read at startup, and only where the host has the readers.
    const sessionStore = startupConfig.privateTranscriptRecall
      ? createSessionStoreAccess(() => api.runtime?.config?.current?.() ?? api.config)
      : undefined;
    // The host config right now (live snapshot, else the one this plugin was loaded with).
    const hostConfig = (): unknown => {
      try {
        return api.runtime?.config?.current?.() ?? api.config;
      } catch {
        return api.config;
      }
    };
    // Memory slot role, read at startup (slot-mode.ts). The owner registers the memory capability;
    // a sidecar beside memory-core registers only hooks, tools and the opt-in supplements, so it
    // never shadows memory_search or memory_get.
    let slot = resolveSlotRole({
      mode: startupConfig.slotMode,
      hostConfig: hostConfig(),
      pluginId: PLUGIN_ID,
    });
    let plan = registrationPlan(slot.role, {
      memoryPromptSection: startupConfig.memoryPromptSection || Boolean(directiveCache),
      corpusSupplement: startupConfig.corpusSupplement,
    });

    const promptBuilder = (
      params: Parameters<typeof buildMemoryPromptSection>[0] & { agentId?: string },
    ) => [
      ...(startupConfig.memoryPromptSection
        ? buildMemoryPromptSection({
            ...params,
            autoRecall: configForAgent(startupConfig, params.agentId).autoRecall,
          })
        : []),
      ...(directiveCache?.lines(directiveBank(params.agentId)) ?? []),
    ];
    const capability: MemoryPluginCapability = {
      providerRuntime: createHindsightProviderRuntime({
        providerId: PLUGIN_ID,
        service,
        recallHealth: () => {
          const lastError = reportedRecallError();
          return { breaker: recallBreaker.state(), ...(lastError ? { lastError } : {}) };
        },
      }),
      providerFlushPlanResolver: createProviderFlushPlanResolver(currentConfig),
      recallToolNames: sessionStore
        ? [...RECALL_TOOL_NAMES, CONVERSATION_RECALL_TOOL]
        : RECALL_TOOL_NAMES,
      ...conversationRecallCapabilityFields({
        enabled: startupConfig.privateTranscriptRecall,
        storeAvailable: sessionStore !== undefined,
      }),
      // Opt-in and read at startup: a static section per agent, so the cached prompt prefix stays
      // stable. The block is named only when that agent's auto-recall is on.
      ...(startupConfig.memoryPromptSection || directiveCache ? { promptBuilder } : {}),
    };
    // /learn: the generic seam where the host has it (openclaw#191665), else the memory-only
    // capability fields that main builds before that change read. Tagged releases through
    // 2026.10.10 have neither, so /learn there does not route lessons to this plugin.
    if (plan.memoryCapability) {
      const registerLearnContribution = resolveLearnRegistrar(api);
      if (!registerLearnContribution) {
        Object.assign(capability, createLegacyLearnFields());
      }
      let registered = true;
      try {
        api.registerMemoryCapability(capability);
      } catch (error) {
        registered = false;
        // Fallback to sidecar only when nothing asked for the slot (auto with no slot set), as for
        // the kind-less test build. With slotMode replace, or a slot that names this plugin, a
        // refused capability means memory_search has no runtime: say so loudly, do not hide it.
        if (startupConfig.slotMode === "auto" && !memorySlotIsSet(hostConfig())) {
          api.logger.warn?.(
            `memory-hindsight: host refused the memory capability (${formatErrorMessage(error)}); running as a sidecar`,
          );
          slot = refusedOwner(slot, PLUGIN_ID);
          plan = registrationPlan(slot.role, {
            memoryPromptSection: startupConfig.memoryPromptSection || Boolean(directiveCache),
            corpusSupplement: startupConfig.corpusSupplement,
          });
        } else {
          api.logger.error(
            `memory-hindsight: host refused the memory capability (${formatErrorMessage(error)}); this plugin owns plugins.slots.memory but serves no memory runtime, so memory_search, the flush and /learn are unavailable. Install the regular package, or set slotMode sidecar and plugins.slots.memory memory-core`,
          );
        }
      }
      if (registered && plan.learnContribution) {
        registerLearnContribution?.(createLearnContribution());
      }
    }
    // Sidecar: the static section goes beside the owner's own prompt section.
    if (plan.promptSupplement) {
      if (typeof api.registerMemoryPromptSupplement === "function") {
        api.registerMemoryPromptSupplement(promptBuilder);
      } else {
        api.logger.warn?.(
          "memory-hindsight: host has no registerMemoryPromptSupplement; memoryPromptSection and promptDirectives are not shown in sidecar mode",
        );
      }
    }
    // Sidecar, opt-in: owner-bank hits in memory_search corpus=wiki|all for matching sessions.
    if (plan.corpusSupplement) {
      if (typeof api.registerMemoryCorpusSupplement === "function") {
        api.registerMemoryCorpusSupplement(
          createHindsightCorpusSupplement({
            service,
            options: () => {
              const live = currentConfig();
              return {
                sessionPatterns: live.corpusSupplement ? live.corpusSupplementSessionPatterns : [],
              };
            },
          }),
        );
      } else {
        api.logger.warn?.(
          "memory-hindsight: host has no registerMemoryCorpusSupplement; corpusSupplement is ignored",
        );
      }
    }

    const registerTool = (
      name: string,
      create: (ctx: OpenClawPluginToolContext) => Omit<AnyAgentTool, "name"> | null,
    ) => {
      api.registerTool(
        (ctx) => {
          const body = create(ctx);
          return body ? { name, ...body } : null;
        },
        { name },
      );
    };
    // A hindsight_retain makes the session's cached recall out of date. Auto-retain does not: its
    // turn is already in the transcript, and dropping the entry every turn would void the cache.
    registerTool(RETAIN_TOOL, (ctx) =>
      createRetainTool(service, flushDeduper, ctx, (key) => {
        if (key) {
          recallCache.delete(key);
          earlyBySession.delete(key);
        }
      }),
    );
    registerTool(RECALL_TOOL, (ctx) => createRecallTool(service, ctx));
    registerTool(REFLECT_TOOL, (ctx) => createReflectTool(service, ctx));
    if (sessionStore) {
      registerTool(CONVERSATION_RECALL_TOOL, (ctx) =>
        createConversationRecallTool(service, ctx, sessionStore),
      );
    }
    // Opt-in: registered only when knowledgeReadTools is on at startup, so the default tool set is
    // unchanged. Each factory also reads the live key and returns null once it is turned off.
    if (startupConfig.knowledgeReadTools) {
      registerTool(KB_TREE_TOOL, (ctx) => createKnowledgeTreeTool(service, ctx));
      registerTool(KB_SEARCH_TOOL, (ctx) => createKnowledgeSearchTool(service, ctx));
      registerTool(KB_PAGE_TOOL, (ctx) => createKnowledgePageTool(service, ctx));
    }

    // A failed auto-recall: the breaker, the health report and the failure metrics. One breaker
    // for the server, timeouts judged by the global recallTimeoutMs read when the request was sent:
    // a timeout under an agent's tighter recallTimeoutMs says that agent's budget is short, not
    // that Hindsight is slow, so it does not count. When that request was the probe, the probe
    // slot is freed without a new cool-down, so the next turn probes again.
    const accountFailure = (
      params: {
        agentId: string | undefined;
        bankId: string;
        probe: boolean;
        timeoutMs: number;
        globalTimeoutMs: number;
        ms: number;
      },
      error: unknown,
    ) => {
      const tightTimeout = isTimeoutError(error) && params.timeoutMs < params.globalTimeoutMs;
      if (!tightTimeout) {
        noteBreaker(recallBreaker.record(error, params.probe));
      } else if (params.probe) {
        recallBreaker.releaseProbe();
      }
      // A missing bank is an empty answer, not a failure.
      if (isBankNotFound(error)) {
        lastRecallError = undefined;
      } else {
        noteRecallError(recallErrorClass(error));
      }
      metrics.recordRecall(
        params.agentId,
        params.bankId,
        isBankNotFound(error) ? "empty" : isTimeoutError(error) ? "timeout" : "error",
        params.ms,
      );
    };

    // One Hindsight recall with the breaker and the failure metrics. Success metrics are left to
    // the caller, after its audience checks.
    const fetchRecall = async (params: {
      agentId: string | undefined;
      bankId: string;
      query: string;
      options: ReturnType<typeof autoRecallRequest>["options"];
      probe: boolean;
      timeoutMs: number;
      /**
       * False for an early recall: its outcome reaches the breaker, the health report and the
       * failure metrics only when a turn takes it, so a message that never gets a turn counts
       * for nothing.
       */
      account?: boolean;
    }): Promise<{ results: RecallResults; ms: number }> => {
      const started = performance.now();
      const globalTimeoutMs = currentConfig().recallTimeoutMs;
      try {
        const results = await service.client.recall(params.bankId, params.query, {
          ...params.options,
          signal: AbortSignal.timeout(params.timeoutMs),
        });
        if (params.account !== false) {
          noteBreaker(recallBreaker.record(undefined, params.probe));
          lastRecallError = undefined;
        }
        return { results, ms: performance.now() - started };
      } catch (error) {
        if (params.account === false) {
          throw error;
        }
        accountFailure({ ...params, globalTimeoutMs, ms: performance.now() - started }, error);
        throw error;
      }
    };

    // The breaker describes one server: reset it when the API URL changed.
    const syncBreakerUrl = (apiUrl: string) => {
      if (breakerApiUrl !== apiUrl) {
        recallBreaker.reset();
        lastRecallError = undefined;
        breakerApiUrl = apiUrl;
      }
    };
    // Breaker admission for one request.
    const admitRecall = (apiUrl: string) => {
      syncBreakerUrl(apiUrl);
      return recallBreaker.admit();
    };

    // recallEarlyStart: the route each session's last turn recalled from (only sessions that passed
    // every check), and the recall started at message_received for the session's next turn. Each
    // early recall is taken by the next before_prompt_build of the session and used only when the
    // bank and the request match, it is younger than recallTimeoutMs plus EARLY_RECALL_GRACE_MS,
    // and (when both hooks carry one) the run id matches. An answer is used; a timeout counts and
    // the turn sends nothing more (stale block or nothing), so a hung server costs a turn one
    // timeout; a fast failure is retried once. A mismatch recalls as usual. A turn that never
    // builds drops it, and a hindsight_retain in the session too.
    const routeBySession = new Map<string, { agentId: string; bankId: string }>();
    const earlyBySession = new Map<
      string,
      {
        runId?: string;
        bankId: string;
        key: string;
        at: number;
        timeoutMs: number;
        globalTimeoutMs: number;
        outcome: Promise<EarlyOutcome>;
      }
    >();
    // recallStaleOnTimeout: the last block each session recalled, with its time and the request
    // settings it was recalled under (everything but the query: tag filter, score floor, types).
    const lastBlockBySession = new Map<
      string,
      { bankId: string; settings: string; results: RecallResults; at: number }
    >();

    // Opt-in and read at startup, so the default hook set is unchanged.
    if (startupConfig.recallEarlyStart) {
      api.on("message_received", async (event, ctx) => {
        const sessionKey = ctx.sessionKey ?? event.sessionKey;
        if (!sessionKey) {
          return;
        }
        earlyBySession.delete(sessionKey);
        const route = routeBySession.get(sessionKey);
        const global = currentConfig();
        if (
          !route ||
          !global.recallEarlyStart ||
          service.stopped() ||
          global.memoryMode === "tools" ||
          isIncognitoSessionKey(sessionKey) ||
          isMaintenanceTurn({ sessionKey })
        ) {
          return;
        }
        const config = configForAgent(global, route.agentId);
        if (!config.autoRecall || typeof event.content !== "string") {
          return;
        }
        const query = extractRecallQuery(event.content, event.content, config.recallQueryShaping);
        // A short follow-up needs the transcript (before_prompt_build), so it is not started early.
        if (
          !query ||
          isEphemeralOperationalText(query) ||
          isShortFollowup(query, config.recallFollowupMaxWords)
        ) {
          return;
        }
        const request = autoRecallRequest(config, query);
        // A turn the cache would answer needs no request.
        const cached = recallCache.get(sessionKey);
        if (
          cached &&
          cached.bankId === route.bankId &&
          Date.now() - cached.at < config.recallCacheTtlMs &&
          cached.queryHash === cacheDigest(request.key)
        ) {
          return;
        }
        // Never while the breaker is open: the probe after a cool-down belongs to a real turn.
        syncBreakerUrl(config.apiUrl);
        if (recallBreaker.state() !== "closed") {
          return;
        }
        const at = Date.now();
        const started = performance.now();
        // Settled once and never rejected, so a dropped early recall is no unhandled rejection.
        // An answer notes the outage count when it arrived (see the take in before_prompt_build).
        const outcome: Promise<EarlyOutcome> = fetchRecall({
          agentId: route.agentId,
          bankId: route.bankId,
          query,
          options: request.options,
          probe: false,
          timeoutMs: config.recallTimeoutMs,
          account: false,
        }).then(
          (fetched) => ({ ok: true as const, ...fetched, outages: recallBreaker.outageCount() }),
          (error: unknown) => ({ ok: false as const, error, ms: performance.now() - started }),
        );
        const runId = ctx.runId ?? event.runId;
        remember(earlyBySession, sessionKey, {
          ...(runId ? { runId } : {}),
          bankId: route.bankId,
          key: request.key,
          at,
          timeoutMs: config.recallTimeoutMs,
          globalTimeoutMs: global.recallTimeoutMs,
          outcome,
        });
      });
    }

    api.on("before_prompt_build", async (event, ctx) => {
      // The agent's `agents` entry, if any, replaces the global auto-recall keys for this turn.
      const config = configForAgent(currentConfig(), ctx.agentId);
      const sessionKey = ctx.sessionKey;
      // Taken by this turn whatever happens next, so a skipped turn drops it.
      const early = sessionKey ? earlyBySession.get(sessionKey) : undefined;
      if (sessionKey) {
        earlyBySession.delete(sessionKey);
      }
      const maintenance = isMaintenanceTurn({
        trigger: ctx.trigger,
        sessionKey,
      });
      // Marks the run start for agent_end even when recall is skipped. A rebuild or continuation
      // of the same run keeps the first start; maintenance turns never touch the markers.
      const prior = sessionKey ? runStartBySession.get(sessionKey) : undefined;
      if (
        sessionKey &&
        !maintenance &&
        Array.isArray(event.messages) &&
        (!prior || prior.runId !== ctx.runId)
      ) {
        runStartBySession.delete(sessionKey);
        runStartBySession.set(sessionKey, {
          runId: ctx.runId,
          marker: runStartMarker(event.messages, event.currentUserMessage),
        });
        if (runStartBySession.size > MAX_RUN_MARKERS) {
          runStartBySession.delete(runStartBySession.keys().next().value!);
        }
      }
      // Recall turned off, and host maintenance turns, are not counted as skips.
      if (service.stopped() || !config.autoRecall || config.memoryMode === "tools" || maintenance) {
        return undefined;
      }
      // Sidecar beside memory-core, opt-in (activeMemoryYield): skip this block only when Active
      // Memory will visibly recall from Hindsight on this turn (slot-mode.ts activeMemoryCoverage),
      // so the turn carries one memory injection instead of two. Anything unclear: inject.
      if (slot.role === "sidecar" && config.activeMemoryYield) {
        const coverage = activeMemoryCoverage(
          hostConfig(),
          {
            agentId: ctx.agentId,
            sessionKey,
            messageProvider: ctx.messageProvider,
            channelId: ctx.channelId,
          },
          RECALL_TOOL,
        );
        if (coverage.covers) {
          api.logger.debug?.(
            `memory-hindsight: auto-recall left to Active Memory (${coverage.reason})`,
          );
          return undefined;
        }
        api.logger.debug?.(`memory-hindsight: auto-recall injects (${coverage.reason})`);
      }
      if (
        isIncognitoSessionKey(sessionKey) ||
        !sessionUsesMemory(config, {
          sessionKey,
          messageProvider: ctx.messageProvider,
          purpose: "recall",
        })
      ) {
        metrics.recordRecallSkip(ctx.agentId, "filter");
        return undefined;
      }
      const route = routeAudience(ctx.agentId, ctx.memoryAudience, config.agentBankMap);
      if (!route.ok) {
        metrics.recordRecallSkip(ctx.agentId, "no_audience");
        api.logger.debug?.(`memory-hindsight: auto-recall skipped: ${route.reason}`);
        return undefined;
      }
      if (config.recallEarlyStart && sessionKey) {
        remember(routeBySession, sessionKey, { agentId: ctx.agentId, bankId: route.bankId });
      }
      const query = extractRecallQuery(
        event.currentUserMessage,
        event.prompt,
        config.recallQueryShaping,
      );
      if (!query || isEphemeralOperationalText(query)) {
        metrics.recordRecallSkip(ctx.agentId, "empty_query");
        return undefined;
      }
      // The request settings of this turn, once known; a stale block must have the same.
      let settings: string | undefined;
      // recallStaleOnTimeout: the session's last block from the same bank and settings when it is
      // young enough, on a timeout or while the breaker is open. Otherwise undefined.
      const staleBlock = (why: "timeout" | "breaker") => {
        const stale = sessionKey ? lastBlockBySession.get(sessionKey) : undefined;
        if (
          !stale ||
          settings === undefined ||
          stale.bankId !== route.bankId ||
          stale.settings !== settings ||
          Date.now() - stale.at >= config.recallStaleOnTimeout
        ) {
          return undefined;
        }
        try {
          ctx.assertMemoryAudienceCurrent?.();
          ctx.hookInvocation?.assertActive();
        } catch {
          return undefined;
        }
        const age = Math.round((Date.now() - stale.at) / 1000);
        if (why === "timeout") {
          api.logger.warn?.(
            `memory-hindsight: auto-recall timed out; using this session's last block (${age} s old)`,
          );
        } else {
          api.logger.debug?.(
            `memory-hindsight: auto-recall paused; using this session's last block (${age} s old)`,
          );
        }
        api.logger.debug?.("memory-hindsight: auto-recall source=stale");
        return inject(stale.results);
      };
      const inject = (results: RecallResults) => {
        // Hindsight returns results best first, so the cap keeps the top of the ranking.
        const injected = config.recallTopK ? results.slice(0, config.recallTopK) : results;
        api.logger.info?.(`memory-hindsight: injecting ${injected.length} memories`);
        const prependContext = buildRecallContext(injected, config.recallPromptPreamble);
        metrics.recordInjection(ctx.agentId, route.bankId, injected.length, prependContext.length);
        // Before the user message, outside the system prompt, so the cached prefix stays stable.
        return { prependContext };
      };
      try {
        ctx.assertMemoryAudienceCurrent?.();
        const ttl = config.recallCacheTtlMs;
        const now = Date.now();
        const cached = ttl > 0 && sessionKey ? recallCache.get(sessionKey) : undefined;
        const live = cached && cached.bankId === route.bankId && now - cached.at < ttl;
        const followup = isShortFollowup(query, config.recallFollowupMaxWords);
        if (followup && live && cached.results.length > 0) {
          metrics.recordRecallSkip(ctx.agentId, "followup");
          api.logger.debug?.("memory-hindsight: auto-recall source=followup-skip");
          return undefined;
        }
        let recallQuery = query;
        let source: RecallSource = "fresh";
        if (followup) {
          const previous = previousUserQuery(event.messages, query, config.recallQueryShaping);
          if (previous) {
            recallQuery = expandFollowupQuery(previous, query);
            source = "followup-expanded";
          }
        }
        const request = autoRecallRequest(config, recallQuery);
        settings = JSON.stringify(request.options);
        const queryHash = cacheDigest(request.key);
        let results: RecallResults;
        // When the results were recalled: an early result keeps its start time in the cache.
        let recalledAt = Date.now();
        if (live && cached.queryHash === queryHash) {
          results = cached.results;
          source = "cached";
          metrics.recordRecallSkip(ctx.agentId, "cache_hit");
        } else {
          const reuse =
            early &&
            early.bankId === route.bankId &&
            early.key === request.key &&
            Date.now() - early.at <= config.recallTimeoutMs + EARLY_RECALL_GRACE_MS &&
            (!early.runId || !ctx.runId || early.runId === ctx.runId);
          let fetched: { results: RecallResults; ms: number } | undefined;
          if (reuse) {
            const outcome = await early.outcome;
            if (outcome.ok) {
              fetched = outcome;
              source = "early";
              recalledAt = early.at;
              // Taken by a turn: its answer counts like any other, unless an outage was recorded
              // after it arrived; then it says nothing about the server now.
              if (outcome.outages === recallBreaker.outageCount()) {
                noteBreaker(recallBreaker.record(undefined));
                lastRecallError = undefined;
              }
            } else if (isTimeoutError(outcome.error)) {
              // The turn already waited one timeout for a hung server: count it, send nothing
              // more, and fall to the stale block (or nothing) below.
              accountFailure(
                {
                  agentId: ctx.agentId,
                  bankId: route.bankId,
                  probe: false,
                  timeoutMs: early.timeoutMs,
                  globalTimeoutMs: early.globalTimeoutMs,
                  ms: outcome.ms,
                },
                outcome.error,
              );
              throw outcome.error;
            } else {
              // A fast failure (network error, 5xx) falls back to one fresh request, which the
              // breaker counts.
              api.logger.debug?.("memory-hindsight: early recall failed; recalling again");
            }
          }
          if (!fetched) {
            const admission = admitRecall(config.apiUrl);
            if (admission === "skip") {
              metrics.recordRecallSkip(ctx.agentId, "breaker_open");
              api.logger.debug?.("memory-hindsight: auto-recall skipped: breaker open");
              return staleBlock("breaker");
            }
            // Metrics count the Hindsight request only. A host assert that throws (audience
            // changed, hook invocation stale) is host lifecycle, not a recall outcome.
            fetched = await fetchRecall({
              agentId: ctx.agentId,
              bankId: route.bankId,
              query: recallQuery,
              options: request.options,
              probe: admission === "probe",
              timeoutMs: config.recallTimeoutMs,
            });
          }
          results = fetched.results;
          const recallMs = fetched.ms;
          ctx.assertMemoryAudienceCurrent?.();
          ctx.hookInvocation?.assertActive();
          metrics.recordRecall(
            ctx.agentId,
            route.bankId,
            results.length === 0 ? "empty" : "injected",
            recallMs,
          );
          if (config.recallStaleOnTimeout > 0 && sessionKey && results.length > 0) {
            remember(lastBlockBySession, sessionKey, {
              bankId: route.bankId,
              settings,
              results,
              at: recalledAt,
            });
          }
          if (ttl > 0 && sessionKey) {
            recallCache.delete(sessionKey);
            recallCache.set(sessionKey, {
              bankId: route.bankId,
              queryHash,
              results,
              at: recalledAt,
            });
            if (recallCache.size > MAX_RECALL_CACHE_SESSIONS) {
              recallCache.delete(recallCache.keys().next().value!);
            }
          }
        }
        api.logger.debug?.(`memory-hindsight: auto-recall source=${source}`);
        if (source === "cached") {
          ctx.assertMemoryAudienceCurrent?.();
          ctx.hookInvocation?.assertActive();
        }
        if (results.length === 0) {
          return undefined;
        }
        return inject(results);
      } catch (error) {
        if (isBankNotFound(error)) {
          // Nothing was retained to this bank yet: no memories, not a failure.
          api.logger.debug?.("memory-hindsight: auto-recall found no bank yet");
          return undefined;
        }
        // recallStaleOnTimeout: a timed-out turn gets the session's last block (see staleBlock).
        // Other failures, and an older or differently filtered block, inject nothing.
        if (isTimeoutError(error)) {
          const stale = staleBlock("timeout");
          if (stale) {
            return stale;
          }
        }
        api.logger.warn?.(`memory-hindsight: auto-recall skipped: ${formatErrorMessage(error)}`);
        return undefined;
      }
    });

    api.on("agent_end", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      const runId = event.runId ?? ctx.runId;
      const maintenance = isMaintenanceTurn({
        trigger: ctx.trigger,
        sessionKey,
      });
      const stored = sessionKey && !maintenance ? runStartBySession.get(sessionKey) : undefined;
      // The host does not await agent_end, so run N's handler can run after run N+1's
      // before_prompt_build replaced the marker. A marker of another run is neither used nor
      // deleted; this run then falls back to its last user message.
      const otherRun =
        stored !== undefined &&
        runId !== undefined &&
        stored.runId !== undefined &&
        stored.runId !== runId;
      const start = otherRun ? undefined : stored;
      const runStart = start?.marker;
      // Taken before any skip. The marker stays while the run can still continue; without a
      // runId on either side it is dropped so the next run marks its own start.
      if (sessionKey && start && (runId === undefined || start.runId !== runId)) {
        runStartBySession.delete(sessionKey);
      }
      const config = currentConfig();
      if (
        service.stopped() ||
        !config.autoRetain ||
        !event.success ||
        !Array.isArray(event.messages) ||
        event.messages.length === 0 ||
        maintenance ||
        isIncognitoSessionKey(sessionKey) ||
        !sessionUsesMemory(config, {
          sessionKey,
          messageProvider: ctx.messageProvider,
          purpose: "retain",
        })
      ) {
        return;
      }
      const route = routeAudience(ctx.agentId, ctx.memoryAudience, config.agentBankMap);
      if (!route.ok) {
        api.logger.debug?.(`memory-hindsight: auto-retain skipped: ${route.reason}`);
        return;
      }
      const retention = prepareRetentionTranscript(
        event.messages,
        retainStartIndex(event.messages, runStart),
      );
      if (!retention || isEphemeralOperationalText(retention.transcript)) {
        return;
      }
      const tags = [...new Set([...config.retainTags, ...retention.tags])];
      // One document per run. Every agent_end for the run carries the run from its first start,
      // so a continuation or a re-delivery replaces the document with the whole run.
      const documentId = runDocumentId(sessionKey, runId);
      const retainStarted = performance.now();
      try {
        // No ctx.assertMemoryAudienceCurrent() here. The host starts agent_end handlers without
        // awaiting them (runAgentEndSideEffectsAsync -> void runAgentEnd, after awaiting the
        // completed-turn snapshot and message loader), while the attempt releases the run's
        // audience in its finally. The check would race that release and drop most retains.
        // The audience was current when the run produced these messages, and the bank comes
        // from that host-minted audience, so the write stays in the right partition.
        const signal = AbortSignal.timeout(RETAIN_TIMEOUT_MS);
        const outcome = await service.retainOrQueue(
          route.bankId,
          {
            content: retention.transcript,
            context: config.retainContext,
            document_id: documentId,
            update_mode: "replace",
            ...(tags.length > 0 ? { tags } : {}),
            metadata: {
              retained_at: new Date().toISOString(),
              message_count: String(retention.messageCount),
              source: RETAIN_SOURCE,
              retention_scope: "turn",
              audience: route.audience.kind,
              ...(sessionKey ? { session_key: sessionKey } : {}),
              // Private transcript recall admits only the live generation of unsandboxed runs.
              ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
              ...(typeof ctx.sandboxed === "boolean" ? { sandboxed: String(ctx.sandboxed) } : {}),
              ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
              ...(ctx.messageProvider ? { provider: ctx.messageProvider } : {}),
              ...(ctx.channelId ? { channel_id: ctx.channelId } : {}),
            },
          },
          signal,
        );
        metrics.recordRetain(ctx.agentId, route.bankId, outcome, performance.now() - retainStarted);
        api.logger.debug?.(
          `memory-hindsight: ${outcome === "sent" ? "retained" : "queued"} ${retention.messageCount} messages (${route.audience.kind})`,
        );
      } catch (error) {
        metrics.recordRetain(
          ctx.agentId,
          route.bankId,
          isTimeoutError(error) ? "timeout" : "error",
          performance.now() - retainStarted,
        );
        api.logger.warn?.(`memory-hindsight: auto-retain failed: ${formatErrorMessage(error)}`);
      }
    });

    api.on("session_end", async (event, ctx) => {
      // Compaction rotates the transcript inside a live run; agent_end still needs its marker.
      if (event.reason === "compaction") {
        return;
      }
      const key = ctx.sessionKey ?? event.sessionKey;
      if (key) {
        runStartBySession.delete(key);
        recallCache.delete(key);
        lastBlockBySession.delete(key);
        earlyBySession.delete(key);
        routeBySession.delete(key);
      }
    });

    // memoryFileSync: scans the synced agents' workspaces on a timer and retains changed memory
    // files (memory-file-sync.ts). Runs only in the gateway service, one pass at a time.
    let fileSyncTimer: ReturnType<typeof setInterval> | undefined;
    let fileSyncFirst: ReturnType<typeof setTimeout> | undefined;
    // The pass in flight, if any: a timer that fires during a pass joins it instead of starting
    // a second one, and tests await it instead of polling.
    let fileSyncPass: Promise<void> | undefined;
    const runMemoryFileSync = (stateDir: string): Promise<void> => {
      if (!fileSyncPass && !service.stopped()) {
        fileSyncPass = syncMemoryFilePass(stateDir).finally(() => {
          fileSyncPass = undefined;
        });
      }
      return fileSyncPass ?? Promise.resolve();
    };
    const syncMemoryFilePass = async (stateDir: string) => {
      const live = currentConfig();
      if (!live.memoryFileSync) {
        return;
      }
      const host = hostConfig() as Parameters<typeof resolveAgentWorkspaceDir>[0];
      const agents = live.memoryFileSyncAgents.length
        ? live.memoryFileSyncAgents
        : [resolveDefaultAgentId(host)];
      for (const agentId of agents) {
        const id = normalizeAgentId(agentId);
        const bankId = ownerBankId(id, live.agentBankMap);
        try {
          const result = await syncMemoryFiles({
            service,
            workspaceDir: resolveAgentWorkspaceDir(host, id),
            bankId,
            statePath: path.join(stateDir, "plugins", PLUGIN_ID, "memory-file-sync", `${id}.json`),
            extraTags: live.retainTags,
          });
          if (result.sent || result.queued || result.deleted || result.failed.length) {
            api.logger.info?.(
              `memory-hindsight: memory files of ${id}: ${result.sent} sent, ${result.queued} queued, ${result.deleted} deleted, ${result.failed.length} failed`,
            );
          }
        } catch (error) {
          api.logger.warn?.(
            `memory-hindsight: memory file sync for ${id} failed (${formatErrorMessage(error)})`,
          );
        }
      }
    };

    const pluginService = {
      id: PLUGIN_ID,
      /** Resolves when no memory file sync pass is running (tests await it; no API contract). */
      memoryFileSyncIdle: (): Promise<void> => fileSyncPass ?? Promise.resolve(),
      start: (ctx?: { stateDir?: string }) => {
        service.start();
        service.startRetainQueue(ctx?.stateDir);
        if (startupConfig.memoryFileSync) {
          const stateDir = ctx?.stateDir;
          if (!stateDir) {
            api.logger.warn?.(
              "memory-hindsight: memoryFileSync needs the host state dir; memory files are not synced",
            );
          } else {
            // First pass shortly after start, off the startup path; then on the interval.
            fileSyncFirst = setTimeout(() => void runMemoryFileSync(stateDir), 30_000);
            fileSyncFirst.unref?.();
            fileSyncTimer = setInterval(
              () => void runMemoryFileSync(stateDir),
              startupConfig.memoryFileSyncIntervalMs,
            );
            fileSyncTimer.unref?.();
          }
        }
        if (directiveCache) {
          // Agents the config names; any other agent gets its directives from its first build on.
          const agentIds = [
            "main",
            ...Object.keys(startupConfig.agents),
            ...Object.keys(startupConfig.agentBankMap),
          ];
          void directiveCache.prefetch(agentIds.map(directiveBank));
        }
        const raw =
          readPluginConfigEntry(api.runtime?.config?.current?.(), PLUGIN_ID) ?? api.pluginConfig;
        const config = currentConfig();
        if (hasUnresolvedToken(raw)) {
          api.logger.warn(
            "memory-hindsight: hindsightApiToken not resolved; requests go unauthenticated",
          );
        }
        // Config parsing already refuses plain remote http without the opt-in; warn only when opted in.
        if (config.allowInsecureHttp && isPlainHttpRemote(config.apiUrl)) {
          api.logger.warn(
            "memory-hindsight: allowInsecureHttp is set and hindsightApiUrl is plain http to a non-loopback host; the bearer token (if any) and conversation text are sent unencrypted",
          );
        }
        api.logger.info(`memory-hindsight: initialized (mode: ${currentConfig().memoryMode})`);
        if (slot.conflict) {
          api.logger.warn(`memory-hindsight: ${slot.conflict}`);
        } else if (slot.role === "sidecar") {
          api.logger.info(
            `memory-hindsight: running as a sidecar beside ${slot.slot ?? "no memory plugin"}; memory_search and memory_get stay with it`,
          );
        }
      },
      stop: () => {
        clearTimeout(fileSyncFirst);
        clearInterval(fileSyncTimer);
        fileSyncFirst = undefined;
        fileSyncTimer = undefined;
        service.stop();
        runStartBySession.clear();
        recallCache.clear();
        lastBlockBySession.clear();
        earlyBySession.clear();
        routeBySession.clear();
        recallBreaker.reset();
        api.logger.info("memory-hindsight: stopped");
      },
    };
    api.registerService(pluginService);
  },
});
