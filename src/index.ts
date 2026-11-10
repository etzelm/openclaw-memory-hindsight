import { createHash } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/routing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isBankNotFound } from "./client.js";
import {
  type HindsightConfig,
  hasUnresolvedToken,
  hindsightConfigSchema,
  isPlainHttpRemote,
  RECALL_MAX_TOKENS,
  RECALL_TIMEOUT_MS,
  RETAIN_SOURCE,
  RETAIN_TIMEOUT_MS,
} from "./config.js";
import {
  createLearnContribution,
  createLegacyLearnFields,
  createProviderFlushPlanResolver,
  RECALL_TOOL_NAMES,
} from "./memory-capability.js";
import {
  createMetricsRouteHandler,
  HindsightMetrics,
  isTimeoutError,
  METRICS_ROUTE_PATH,
} from "./metrics.js";
import { createHindsightProviderRuntime } from "./provider-runtime.js";
import { isMaintenanceTurn, routeAudience, sessionUsesMemory } from "./routing.js";
import { type MemoryPluginCapability, resolveLearnRegistrar } from "./sdk-types.js";
import { createHindsightService } from "./service.js";
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
  extractRecallQuery,
  isEphemeralOperationalText,
  prepareRetentionTranscript,
  retainStartIndex,
  runStartMarker,
} from "./transcript.js";

export const PLUGIN_ID = "hindsight-native";
// Bounds per-session run markers; one entry per active session is enough.
const MAX_RUN_MARKERS = 1_000;

/**
 * Reads `plugins.entries[<id>].config` from a runtime config snapshot. Returns undefined when the
 * snapshot has no entry, so callers fall back to the register-time `api.pluginConfig`.
 */
export function readPluginConfigEntry(
  config: unknown,
  pluginId: string,
): Record<string, unknown> | undefined {
  const plugins = asOptionalRecord(asOptionalRecord(config)?.plugins);
  const entry = asOptionalRecord(asOptionalRecord(plugins?.entries)?.[pluginId]);
  return asOptionalRecord(entry?.config);
}

function sanitizeDocumentIdPart(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

/** Short stable digest of the raw key, so keys that sanitize to the same text stay distinct. */
export function sessionKeyDigest(sessionKey: string | undefined): string {
  return createHash("sha256")
    .update(sessionKey ?? "")
    .digest("hex")
    .slice(0, 12);
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Memory (Hindsight)",
  description: "Hindsight-backed long-term memory with auto-recall, auto-retain and agent tools",
  kind: "memory" as const,
  configSchema: hindsightConfigSchema,

  register(api: OpenClawPluginApi) {
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

    const capability: MemoryPluginCapability = {
      providerRuntime: createHindsightProviderRuntime({
        providerId: PLUGIN_ID,
        service,
      }),
      providerFlushPlanResolver: createProviderFlushPlanResolver(currentConfig),
      recallToolNames: RECALL_TOOL_NAMES,
    };
    // /learn: the generic seam where the host has it (openclaw#191665), else the memory-only
    // capability fields that main builds before that change read. Tagged releases through
    // 2026.10.10 have neither, so /learn there does not route lessons to this plugin.
    const registerLearnContribution = resolveLearnRegistrar(api);
    if (!registerLearnContribution) {
      Object.assign(capability, createLegacyLearnFields());
    }
    api.registerMemoryCapability(capability);
    registerLearnContribution?.(createLearnContribution());

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
    registerTool(RETAIN_TOOL, (ctx) => createRetainTool(service, flushDeduper, ctx));
    registerTool(RECALL_TOOL, (ctx) => createRecallTool(service, ctx));
    registerTool(REFLECT_TOOL, (ctx) => createReflectTool(service, ctx));
    // Opt-in: registered only when knowledgeReadTools is on at startup, so the default tool set is
    // unchanged. Each factory also reads the live key and returns null once it is turned off.
    if (startupConfig.knowledgeReadTools) {
      registerTool(KB_TREE_TOOL, (ctx) => createKnowledgeTreeTool(service, ctx));
      registerTool(KB_SEARCH_TOOL, (ctx) => createKnowledgeSearchTool(service, ctx));
      registerTool(KB_PAGE_TOOL, (ctx) => createKnowledgePageTool(service, ctx));
    }

    api.on("before_prompt_build", async (event, ctx) => {
      const config = currentConfig();
      const sessionKey = ctx.sessionKey;
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
      if (
        service.stopped() ||
        !config.autoRecall ||
        config.memoryMode === "tools" ||
        maintenance ||
        isIncognitoSessionKey(sessionKey) ||
        !sessionUsesMemory(config, {
          sessionKey,
          messageProvider: ctx.messageProvider,
        })
      ) {
        return undefined;
      }
      const route = routeAudience(ctx.agentId, ctx.memoryAudience, config.agentBankMap);
      if (!route.ok) {
        api.logger.debug?.(`memory-hindsight: auto-recall skipped: ${route.reason}`);
        return undefined;
      }
      const query = extractRecallQuery(event.currentUserMessage, event.prompt);
      if (!query || isEphemeralOperationalText(query)) {
        return undefined;
      }
      try {
        ctx.assertMemoryAudienceCurrent?.();
        // Metrics count the Hindsight request only. A host assert that throws (audience changed,
        // hook invocation stale) is host lifecycle, not a recall outcome, so it records nothing.
        const recallStarted = performance.now();
        let results: Awaited<ReturnType<typeof service.client.recall>>;
        try {
          results = await service.client.recall(route.bankId, query, {
            budget: config.recallBudget,
            maxTokens: RECALL_MAX_TOKENS,
            ...(config.recallTypes ? { types: config.recallTypes } : {}),
            ...(config.preferObservations === undefined
              ? {}
              : { preferObservations: config.preferObservations }),
            signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
          });
        } catch (error) {
          metrics.recordRecall(
            ctx.agentId,
            route.bankId,
            isBankNotFound(error) ? "empty" : isTimeoutError(error) ? "timeout" : "error",
            performance.now() - recallStarted,
          );
          throw error;
        }
        const recallMs = performance.now() - recallStarted;
        ctx.assertMemoryAudienceCurrent?.();
        ctx.hookInvocation?.assertActive();
        metrics.recordRecall(
          ctx.agentId,
          route.bankId,
          results.length === 0 ? "empty" : "injected",
          recallMs,
        );
        if (results.length === 0) {
          return undefined;
        }
        api.logger.info?.(`memory-hindsight: injecting ${results.length} memories`);
        // Before the user message, outside the system prompt, so the cached prefix stays stable.
        return {
          prependContext: buildRecallContext(results, config.recallPromptPreamble),
        };
      } catch (error) {
        if (isBankNotFound(error)) {
          // Nothing was retained to this bank yet: no memories, not a failure.
          api.logger.debug?.("memory-hindsight: auto-recall found no bank yet");
          return undefined;
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
      const start = sessionKey && !maintenance ? runStartBySession.get(sessionKey) : undefined;
      const runStart = start?.marker;
      // Taken before any skip. The marker stays while the run can still continue; without a
      // runId it is dropped so the next run marks its own start.
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
      const runPart = sanitizeDocumentIdPart(runId, `${Date.now()}`);
      const documentId = `openclaw:${sanitizeDocumentIdPart(sessionKey, "session")}-${sessionKeyDigest(sessionKey)}:run:${runPart}`;
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
      }
    });

    api.registerService({
      id: PLUGIN_ID,
      start: (ctx?: { stateDir?: string }) => {
        service.start();
        service.startRetainQueue(ctx?.stateDir);
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
      },
      stop: () => {
        service.stop();
        runStartBySession.clear();
        api.logger.info("memory-hindsight: stopped");
      },
    });
  },
});
