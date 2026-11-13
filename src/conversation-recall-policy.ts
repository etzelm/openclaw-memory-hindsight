import { sessionDocumentPrefix } from "./document-ids.js";

/**
 * Eligibility rules for private transcript recall, ported from OpenClaw memory-core
 * (`extensions/memory-core/src/session-search-visibility.ts`). Pure functions over a session
 * store snapshot so every rule has a unit test. Where memory-core admits extra content through
 * host readers that third-party plugins cannot use (the reset cutoff and archive reasons), these
 * rules refuse it: they may return less than memory-core, never more.
 */

/** The host's `ctx.conversationRecall`, read from the trusted tool context only. */
export type ConversationRecallGrant = {
  anchorSessionKey: string;
  scope: "same-agent-private";
  corpus: "sessions" | "configured";
};

/** One session store row, reduced to the fields the privacy rules read. */
export type StoredSession = {
  sessionKey: string;
  sessionId: string;
  /** `entry.chatType` and the delivery origin's chat type, when present. */
  chatTypes: string[];
};

export type SessionSnapshot = ReadonlyMap<string, StoredSession>;

const RECALL_REQUESTER_SUFFIX = /^:active-memory:[a-f0-9]{12}$/i;
const ACTIVE_MEMORY_RECALL_KEY = /:active-memory:[a-f0-9]{12}$/i;
const NON_CONVERSATION_SEGMENT = /:(?:active-memory|cron|heartbeat|hook|node|subagent)(?::|$)/;

function norm(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Reads the grant from the tool context; anything malformed is no grant. */
export function readConversationRecallGrant(value: unknown): ConversationRecallGrant | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const grant = value as Record<string, unknown>;
  const anchor = typeof grant.anchorSessionKey === "string" ? grant.anchorSessionKey.trim() : "";
  if (
    !anchor ||
    grant.scope !== "same-agent-private" ||
    (grant.corpus !== "sessions" && grant.corpus !== "configured")
  ) {
    return undefined;
  }
  return { anchorSessionKey: anchor, scope: "same-agent-private", corpus: grant.corpus };
}

/** The requester is the anchor itself or Active Memory's recall run for it. */
export function isTrustedRecallRequester(anchorSessionKey: string, requester?: string): boolean {
  const key = requester?.trim();
  if (!key || !key.startsWith(anchorSessionKey)) {
    return false;
  }
  const suffix = key.slice(anchorSessionKey.length);
  return suffix.length === 0 || RECALL_REQUESTER_SUFFIX.test(suffix);
}

/** memory-core `isPrivateConversation`, rule for rule. A missing store entry is not private. */
export function isPrivateConversation(
  agentId: string,
  key: string,
  entry: StoredSession | undefined,
): boolean {
  if (!entry) {
    return false;
  }
  const k = norm(key);
  const chatTypes = entry.chatTypes;
  if (chatTypes.some((t) => t === "group" || t === "channel") || ACTIVE_MEMORY_RECALL_KEY.test(k)) {
    return false;
  }
  const prefix = `agent:${norm(agentId)}:`;
  if (k === "global" || k === `${prefix}global`) {
    return false;
  }
  if (k.startsWith(`${prefix}explicit:`)) {
    return chatTypes.length > 0 && chatTypes.every((t) => t === "direct");
  }
  if (k.includes(":group:") || k.includes(":channel:") || NON_CONVERSATION_SEGMENT.test(k)) {
    return false;
  }
  if (chatTypes.length > 0) {
    return chatTypes.every((t) => t === "direct");
  }
  return k.includes(":direct:") || k.includes(":dm:");
}

/** Every store key whose current transcript is `sessionId`. */
export function aliasesOf(snapshot: SessionSnapshot, sessionId: string): StoredSession[] {
  const id = sessionId.trim();
  return id ? [...snapshot.values()].filter((entry) => entry.sessionId.trim() === id) : [];
}

export type AnchorCheck =
  | { ok: true; agentId: string; anchor: StoredSession }
  | { ok: false; reason: string };

/**
 * memory-core `recallAuthorized`: trusted grant, unsandboxed requester, same agent, and an
 * anchor that is private under every alias of its transcript.
 */
export function checkAnchor(params: {
  grant: ConversationRecallGrant | undefined;
  requesterSessionKey: string | undefined;
  sandboxed: boolean | undefined;
  /** Agent the tool runs for (`ctx.agentId`, else the requester key's agent). */
  scopedAgentId: string | undefined;
  resolveAgentId: (sessionKey: string) => string | undefined;
  snapshot: SessionSnapshot;
}): AnchorCheck {
  const { grant } = params;
  if (!grant) {
    return { ok: false, reason: "no conversation recall grant" };
  }
  if (params.sandboxed === true) {
    return { ok: false, reason: "sandboxed requester" };
  }
  if (!isTrustedRecallRequester(grant.anchorSessionKey, params.requesterSessionKey)) {
    return { ok: false, reason: "requester is not the anchor or its recall run" };
  }
  const agentId = params.resolveAgentId(grant.anchorSessionKey);
  if (!agentId || norm(agentId) !== norm(params.scopedAgentId)) {
    return { ok: false, reason: "anchor belongs to another agent" };
  }
  const anchor = params.snapshot.get(grant.anchorSessionKey);
  if (!anchor || !isPrivateConversation(agentId, grant.anchorSessionKey, anchor)) {
    return { ok: false, reason: "anchor is not a private conversation" };
  }
  const aliasesPrivate = aliasesOf(params.snapshot, anchor.sessionId).every(
    (alias) =>
      alias.sessionKey === grant.anchorSessionKey ||
      isPrivateConversation(agentId, alias.sessionKey, alias),
  );
  if (!aliasesPrivate) {
    return { ok: false, reason: "an alias of the anchor transcript is not private" };
  }
  return { ok: true, agentId, anchor };
}

const RUN_DOCUMENT = /^openclaw:.+-[a-f0-9]{12}:run:[^:]+$/;

/** A run document the plugin's auto-retain wrote, with the metadata the rules read. */
export type RunDocument = { id: string; metadata: Readonly<Record<string, string>> };

/**
 * Whether one run document may be recalled for this anchor. Live generation only: the
 * document's transcript id must be the key's current one, so deleted sessions, recreated keys
 * and reset generations are all refused (memory-core admits reset generations through a
 * private-local archive reader).
 */
export function checkRunDocument(params: {
  doc: RunDocument;
  agentId: string;
  anchor: StoredSession;
  snapshot: SessionSnapshot;
  resolveAgentId: (sessionKey: string) => string | undefined;
}): { ok: true; sessionKey: string } | { ok: false; reason: string } {
  const { doc, agentId, anchor, snapshot } = params;
  const meta = doc.metadata;
  if (!RUN_DOCUMENT.test(doc.id)) {
    return { ok: false, reason: "not a run document" };
  }
  const key = meta.session_key?.trim();
  if (!key || !doc.id.startsWith(sessionDocumentPrefix(key))) {
    return { ok: false, reason: "document id does not match its session key" };
  }
  if (meta.source !== "openclaw" || meta.retention_scope !== "turn") {
    return { ok: false, reason: "not an auto-retained run" };
  }
  if (meta.audience !== "owner-private") {
    return { ok: false, reason: "not owner-private" };
  }
  // memory-core has no source-side sandbox rule; a run the host marked sandboxed is refused.
  if (meta.sandboxed === "true") {
    return { ok: false, reason: "sandboxed run" };
  }
  if (norm(meta.agent_id) !== norm(agentId) || norm(params.resolveAgentId(key)) !== norm(agentId)) {
    return { ok: false, reason: "another agent" };
  }
  const sessionId = meta.session_id?.trim();
  if (!sessionId) {
    return { ok: false, reason: "no transcript id" };
  }
  if (key === anchor.sessionKey || sessionId === anchor.sessionId.trim()) {
    return { ok: false, reason: "the anchor conversation" };
  }
  const entry = snapshot.get(key);
  if (!entry) {
    return { ok: false, reason: "session no longer exists" };
  }
  if (entry.sessionId.trim() !== sessionId) {
    return { ok: false, reason: "earlier generation of the session" };
  }
  const keys = aliasesOf(snapshot, sessionId);
  const allPrivate = keys.every(
    (alias) =>
      alias.sessionKey !== anchor.sessionKey &&
      norm(params.resolveAgentId(alias.sessionKey)) === norm(agentId) &&
      isPrivateConversation(agentId, alias.sessionKey, alias),
  );
  if (!allPrivate) {
    return { ok: false, reason: "a key of this transcript is not private" };
  }
  return { ok: true, sessionKey: key };
}

/** A chunk belongs to the document only when its id is `<bank>_<document id>_<n>`. */
export function chunkBelongsTo(chunkId: string, bankId: string, documentId: string): boolean {
  const prefix = `${bankId}_${documentId}_`;
  return chunkId.startsWith(prefix) && /^\d+$/.test(chunkId.slice(prefix.length));
}
