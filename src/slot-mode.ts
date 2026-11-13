/**
 * Memory slot role: replace memory-core (own `plugins.slots.memory`) or run beside it (sidecar).
 *
 * The host decides ownership. A plugin only learns it from the config it is loaded with, so the
 * role is derived from `plugins.slots.memory` and the configured `slotMode`:
 *
 * - `replace`: this plugin is the slot owner. It registers the memory capability (provider
 *   runtime, recall tools for Active Memory, flush plan, /learn).
 * - `sidecar`: another plugin (normally memory-core) owns the slot. This plugin registers only
 *   hooks, `hindsight_*` tools and the opt-in supplements; it never registers the memory
 *   capability and never shadows `memory_search` or `memory_get`.
 * - `auto`: `replace` when the slot names this plugin, else `sidecar`.
 */

export const SLOT_MODES = ["auto", "replace", "sidecar"] as const;
export type SlotMode = (typeof SLOT_MODES)[number];
export type SlotRole = "owner" | "sidecar";

/** The host default for `plugins.slots.memory` when the key is absent. */
export const DEFAULT_MEMORY_SLOT = "memory-core";

export function isSlotMode(value: unknown): value is SlotMode {
  return typeof value === "string" && (SLOT_MODES as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `plugins.slots.memory` of a host config, lowercased and trimmed: the default owner when unset,
 * null when memory is off (`"none"` or an explicit null).
 */
export function configuredMemorySlot(hostConfig: unknown): string | null {
  const slots = record(record(record(hostConfig)?.plugins)?.slots);
  if (!slots || !("memory" in slots) || slots.memory === undefined) {
    return DEFAULT_MEMORY_SLOT;
  }
  if (slots.memory === null) {
    return null;
  }
  if (typeof slots.memory !== "string") {
    return DEFAULT_MEMORY_SLOT;
  }
  const slot = slots.memory.trim().toLowerCase();
  if (!slot) {
    return DEFAULT_MEMORY_SLOT;
  }
  return slot === "none" ? null : slot;
}

export type SlotResolution = {
  mode: SlotMode;
  role: SlotRole;
  /** The configured slot owner; null when memory is off. */
  slot: string | null;
  /** Set when the config contradicts itself; the doctor reports it. */
  conflict?: string;
};

/** True when plugins.slots.memory is present in the host config (a string or an explicit null). */
export function memorySlotIsSet(hostConfig: unknown): boolean {
  const slots = record(record(record(hostConfig)?.plugins)?.slots);
  return Boolean(slots && "memory" in slots && slots.memory !== undefined);
}

/** plugins.entries.<id>.memory.sidecar === true: the operator approved this plugin as a sidecar. */
export function entryIsApprovedSidecar(hostConfig: unknown, pluginId: string): boolean {
  const entry = record(record(record(hostConfig)?.plugins)?.entries)?.[pluginId];
  return record(record(entry)?.memory)?.sidecar === true;
}

/**
 * The role for a mode. `auto` is the owner when the slot names this plugin, or when no slot is
 * set at all and the operator did not approve it as a sidecar: a `kind: "memory"` build only
 * loads on a stock host as the slot owner. A build the host refuses as owner (the kind-less
 * sidecar build) falls back to sidecar at registration (see index.ts).
 */
export function resolveSlotRole(params: {
  mode: SlotMode;
  hostConfig: unknown;
  pluginId: string;
}): SlotResolution {
  const slot = configuredMemorySlot(params.hostConfig);
  const owns = slot === params.pluginId.toLowerCase();
  if (params.mode === "replace") {
    return owns || !memorySlotIsSet(params.hostConfig)
      ? { mode: "replace", role: "owner", slot: owns ? slot : params.pluginId }
      : {
          mode: "replace",
          role: "owner",
          slot,
          conflict: `slotMode is replace but plugins.slots.memory is ${slot === null ? "none" : `"${slot}"`}; set it to "${params.pluginId}" or use slotMode sidecar`,
        };
  }
  if (params.mode === "sidecar") {
    return owns
      ? {
          mode: "sidecar",
          role: "sidecar",
          slot,
          conflict: `slotMode is sidecar but plugins.slots.memory names this plugin, so no memory runtime serves memory_search; set the slot to "${DEFAULT_MEMORY_SLOT}" or use slotMode replace`,
        }
      : { mode: "sidecar", role: "sidecar", slot };
  }
  if (owns) {
    return { mode: "auto", role: "owner", slot };
  }
  if (
    !memorySlotIsSet(params.hostConfig) &&
    !entryIsApprovedSidecar(params.hostConfig, params.pluginId)
  ) {
    return { mode: "auto", role: "owner", slot: params.pluginId };
  }
  return { mode: "auto", role: "sidecar", slot };
}

/** The resolution after the host refused the memory capability: this build is a sidecar. */
export function refusedOwner(resolution: SlotResolution, pluginId: string): SlotResolution {
  return {
    mode: resolution.mode,
    role: "sidecar",
    slot: resolution.slot === pluginId.toLowerCase() ? DEFAULT_MEMORY_SLOT : resolution.slot,
  };
}

/** What register() wires for a role. Tools and hooks are the same in both roles. */
export type RegistrationPlan = {
  /** registerMemoryCapability (provider runtime, recall tools, flush plan, prompt builder). */
  memoryCapability: boolean;
  /** registerLearnContribution: the host keeps memory lessons for the slot owner only. */
  learnContribution: boolean;
  /** registerMemoryPromptSupplement: the static section beside the owner's own prompt. */
  promptSupplement: boolean;
  /** registerMemoryCorpusSupplement: Hindsight hits in memory_search corpus=wiki|all. */
  corpusSupplement: boolean;
};

export function registrationPlan(
  role: SlotRole,
  options: { memoryPromptSection: boolean; corpusSupplement: boolean },
): RegistrationPlan {
  if (role === "owner") {
    // The owner's runtime already serves memory_search; a supplement would answer twice.
    return {
      memoryCapability: true,
      learnContribution: true,
      promptSupplement: false,
      corpusSupplement: false,
    };
  }
  return {
    memoryCapability: false,
    learnContribution: false,
    promptSupplement: options.memoryPromptSection,
    corpusSupplement: options.corpusSupplement,
  };
}

function lowerStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase())
    : [];
}

/** The turn as the hook context describes it. */
export type ActiveMemoryTurn = {
  agentId?: string;
  sessionKey?: string;
  messageProvider?: string;
  channelId?: string;
};

export type ActiveMemoryCoverage = { covers: boolean; reason: string };

const ACTIVE_MEMORY_ID = "active-memory";
const SESSION_KINDS = ["direct", "dm", "group", "channel"] as const;

/**
 * Chat type of a turn, by the same rules as Active Memory's resolveChatType. Returns undefined
 * whenever the rules would need something this plugin does not have (thread suffixes, an unknown
 * main session provider), so an unknown type never counts as allowed.
 */
export function activeMemoryChatType(
  turn: ActiveMemoryTurn,
  mainKey = "main",
): "direct" | "group" | "channel" | "explicit" | undefined {
  const key = turn.sessionKey?.trim().toLowerCase();
  const provider = (turn.messageProvider ?? "").trim().toLowerCase();
  if (key) {
    if (key.includes(":thread:") || key.includes(":topic:")) {
      return undefined;
    }
    const parts = key.split(":");
    if (key.startsWith("agent:") && parts[2] === "explicit") {
      return "explicit";
    }
    if (key.includes(":group:")) {
      return "group";
    }
    if (key.includes(":channel:")) {
      return "channel";
    }
    if (key.includes(":direct:") || key.includes(":dm:")) {
      return "direct";
    }
    const main = mainKey.trim().toLowerCase() || "main";
    if (parts.length === 3 && parts[0] === "agent" && (parts[2] === main || parts[2] === "main")) {
      if (provider && provider !== "webchat" && turn.channelId?.trim()) {
        return "direct";
      }
    }
  }
  return provider === "webchat" ? "direct" : undefined;
}

/** The peer id Active Memory's allowedChatIds/deniedChatIds match, or undefined. */
function conversationId(turn: ActiveMemoryTurn): string | undefined {
  const parts = (turn.sessionKey ?? "").trim().toLowerCase().split(":").filter(Boolean);
  if (parts[0] === "agent") {
    const rest = parts.slice(2);
    for (let i = 0; i < rest.length - 1; i += 1) {
      if ((SESSION_KINDS as readonly string[]).includes(rest[i]!)) {
        return rest.slice(i + 1).join(":") || undefined;
      }
    }
  }
  return turn.channelId?.trim().toLowerCase() || undefined;
}

/**
 * Whether Active Memory will recall from Hindsight on this turn, so a sidecar may skip its own
 * auto-recall block. Conservative: every condition Active Memory checks must be visibly met in the
 * host config and the turn, and anything this plugin cannot see means "inject".
 *
 * Checked: the plugin is enabled and allowed (plugins.enabled, allow, deny, entry enabled), its
 * config is not paused, `mode` is `always` (`escalate`, the default, runs deep recall only for
 * recall-intent turns without a strong first-lane hit; `off` never runs it), the agent is in
 * `agents`, `toolsAllow` names the recall tool, the turn's chat type is in `allowedChatTypes`
 * (default direct only), and allowedChatIds/deniedChatIds admit the turn's peer.
 *
 * Not visible: Active Memory's per-session toggle (kept in its own plugin state) and whether its
 * model resolves. That is why the caller only yields when the operator opted in with
 * `activeMemoryYield`; a session toggled off then gets neither block.
 */
function no(reason: string): ActiveMemoryCoverage {
  return { covers: false, reason };
}

export function activeMemoryCoverage(
  hostConfig: unknown,
  turn: ActiveMemoryTurn,
  recallTool: string,
): ActiveMemoryCoverage {
  const agent = turn.agentId?.trim().toLowerCase();
  if (!agent) {
    return no("no agent id");
  }
  const plugins = record(record(hostConfig)?.plugins);
  if (plugins?.enabled === false) {
    return no("plugins disabled");
  }
  if (lowerStrings(plugins?.deny).includes(ACTIVE_MEMORY_ID)) {
    return no("active-memory denied");
  }
  const allow = lowerStrings(plugins?.allow);
  if (allow.length > 0 && !allow.includes(ACTIVE_MEMORY_ID)) {
    return no("active-memory not in plugins.allow");
  }
  const entry = record(record(plugins?.entries)?.[ACTIVE_MEMORY_ID]);
  if (!entry || entry.enabled !== true) {
    return no("active-memory not enabled");
  }
  const config = record(entry.config) ?? {};
  if (config.enabled === false) {
    return no("active-memory paused");
  }
  if (config.mode !== "always") {
    return no(`active-memory mode ${typeof config.mode === "string" ? config.mode : "escalate"}`);
  }
  if (!lowerStrings(config.agents).includes(agent)) {
    return no("agent not targeted by active-memory");
  }
  if (!lowerStrings(config.toolsAllow).includes(recallTool)) {
    return no(`${recallTool} not in active-memory toolsAllow`);
  }
  const mainKey = record(record(hostConfig)?.session)?.mainKey;
  const chatType = activeMemoryChatType(turn, typeof mainKey === "string" ? mainKey : undefined);
  const allowedTypes = lowerStrings(config.allowedChatTypes);
  if (!chatType || !(allowedTypes.length ? allowedTypes : ["direct"]).includes(chatType)) {
    return no(`chat type ${chatType ?? "unknown"} not allowed by active-memory`);
  }
  const allowedIds = lowerStrings(config.allowedChatIds);
  const deniedIds = lowerStrings(config.deniedChatIds);
  if (allowedIds.length || deniedIds.length) {
    const id = conversationId(turn);
    if (!id) {
      return no("chat id unknown with active-memory chat id lists set");
    }
    if (allowedIds.length && !allowedIds.includes(id)) {
      return no("chat id not in active-memory allowedChatIds");
    }
    if (deniedIds.includes(id)) {
      return no("chat id in active-memory deniedChatIds");
    }
  }
  return { covers: true, reason: "active-memory recalls with " + recallTool };
}

export type DoctorLine = { status: "PASS" | "WARN" | "FAIL"; text: string };

/** The doctor's slot line. A sidecar beside a loaded owner is a supported setup, not a warning. */
export function slotDoctorLine(resolution: SlotResolution, pluginId: string): DoctorLine {
  if (resolution.conflict) {
    return { status: "FAIL", text: `memory slot: ${resolution.conflict}` };
  }
  if (resolution.role === "owner") {
    return { status: "PASS", text: `memory slot: owner ("${pluginId}", mode ${resolution.mode})` };
  }
  if (resolution.slot === null) {
    return {
      status: "WARN",
      text: "memory slot: sidecar with memory off (plugins.slots.memory none); memory_search is unavailable, hindsight_* tools still work",
    };
  }
  return {
    status: "PASS",
    text: `memory slot: sidecar beside "${resolution.slot}" (mode ${resolution.mode})`,
  };
}
