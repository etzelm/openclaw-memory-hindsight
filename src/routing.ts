import { createHash } from "node:crypto";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { HindsightConfig } from "./config.js";

/** Host-minted memory partition; the SDK exposes it through the tool and hook contexts. */
export type MemoryAudience = NonNullable<OpenClawPluginToolContext["memoryAudience"]>;

export type BankRoute =
  | { ok: true; bankId: string; audience: MemoryAudience }
  | { ok: false; reason: string };

export type AgentBankMap = Readonly<Record<string, string>>;

/**
 * The owner's private bank for one agent; matches the third-party plugin's per-agent bank.
 * `agentBankMap` (same key as the vendor plugin) lets several agents share one owner bank.
 * The id stays raw here; `HindsightClient` percent-encodes it once when it builds the URL.
 */
export function ownerBankId(agentId: string, bankMap?: AgentBankMap): string {
  const normalized = normalizeAgentId(agentId);
  return bankMap?.[normalized] ?? normalized;
}

/**
 * A conversation audience gets its own bank per durable root session, so memories formed with
 * other senders or in groups never surface in the owner's private recall and vice versa.
 */
export function conversationBankId(
  agentId: string,
  rootSessionKey: string,
  bankMap?: AgentBankMap,
): string {
  const digest = createHash("sha256").update(rootSessionKey).digest("hex").slice(0, 16);
  return `${ownerBankId(agentId, bankMap)}::conv::${digest}`;
}

/**
 * Picks the bank from the host-minted audience only. Session keys, ids and record ids never
 * select a partition, and an audience for another agent is refused.
 */
export function routeAudience(
  agentId: string | undefined,
  audience: MemoryAudience | undefined,
  bankMap?: AgentBankMap,
): BankRoute {
  if (!agentId?.trim()) {
    return { ok: false, reason: "no agent id" };
  }
  if (!audience) {
    return { ok: false, reason: "this session has no memory audience" };
  }
  const normalized = normalizeAgentId(agentId);
  if (normalizeAgentId(audience.agentId) !== normalized) {
    return { ok: false, reason: "the memory audience belongs to another agent" };
  }
  if (audience.kind === "owner-private") {
    return { ok: true, bankId: ownerBankId(normalized, bankMap), audience };
  }
  return {
    ok: true,
    bankId: conversationBankId(normalized, audience.sessionKey, bankMap),
    audience,
  };
}

const OPERATIONAL_SESSION_RE = /^agent:[^:]+:(cron|heartbeat|subagent):/;
const OPERATIONAL_PROVIDERS = new Set(["cron", "heartbeat", "subagent"]);

/** Session filter shared by auto-recall, auto-retain and tool registration. */
export function sessionUsesMemory(
  config: Pick<HindsightConfig, "excludeProviders" | "skipOperationalSessions">,
  params: { sessionKey?: string; messageProvider?: string },
): boolean {
  const { sessionKey, messageProvider } = params;
  if (messageProvider && config.excludeProviders.includes(messageProvider)) {
    return false;
  }
  if (sessionKey?.startsWith("temp:")) {
    return false;
  }
  if (!config.skipOperationalSessions) {
    return true;
  }
  if (messageProvider && OPERATIONAL_PROVIDERS.has(messageProvider)) {
    return false;
  }
  return !(sessionKey && OPERATIONAL_SESSION_RE.test(sessionKey));
}

// Active Memory's blocking recall child: `<parent>:active-memory:<12 hex>` (as memory-core reads it).
const ACTIVE_MEMORY_RECALL_SESSION_RE = /:active-memory:[a-f0-9]{12}$/i;

/**
 * Host maintenance turns that get no auto-recall and no auto-retain. The pre-compaction flush
 * (trigger "memory") sends a fixed host prompt and saves through hindsight_retain; Active
 * Memory's recall child sends a recall prompt and reads through hindsight_recall. Neither is a
 * user turn, so recalling on its prompt or retaining its transcript only adds noise. The
 * hindsight_* tools stay available to both.
 */
export function isMaintenanceTurn(params: { trigger?: string; sessionKey?: string }): boolean {
  return (
    params.trigger === "memory" ||
    Boolean(params.sessionKey && ACTIVE_MEMORY_RECALL_SESSION_RE.test(params.sessionKey.trim()))
  );
}
