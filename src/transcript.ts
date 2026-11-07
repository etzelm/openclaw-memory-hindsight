import { createHash } from "node:crypto";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { HindsightRecallResult } from "./client.js";
import { MEMORY_ROLES, RECALL_MAX_QUERY_CHARS } from "./config.js";

/** Tag that wraps injected memories so retain never stores them again. */
export const MEMORIES_TAG = "hindsight_memories";

function asMessage(
  value: unknown,
): { role?: unknown; content?: unknown; timestamp?: unknown } | undefined {
  return asOptionalRecord(value);
}

export function messageText(message: unknown): string {
  const content = asMessage(message)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      const record = asOptionalRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
}

export function stripMemoryTags(content: string): string {
  return content
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "")
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "");
}

const RETAIN_TAGS_RE = /<(?:hindsight_)?retain_tags>([\s\S]*?)<\/(?:hindsight_)?retain_tags>/gi;

export function normalizeTags(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    for (const part of value.split(",")) {
      const tag = part.trim();
      if (tag && !out.includes(tag)) {
        out.push(tag);
      }
    }
  }
  return out;
}

export function extractInlineRetainTags(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(RETAIN_TAGS_RE)) {
    found.push(match[1] ?? "");
  }
  return normalizeTags(found);
}

export function stripInlineRetainTags(content: string): string {
  return content.replace(RETAIN_TAGS_RE, "");
}

const INLINE_TIMESTAMP_PREFIX_RE =
  /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:[A-Z]{2,5}|GMT[+-]\d{1,2}(?::\d{2})?)\]\s*/;

export function stripInlineTimestampPrefix(content: string): string {
  return content.replace(INLINE_TIMESTAMP_PREFIX_RE, "");
}

const INBOUND_CONTEXT_MARKER = "⟦openclaw:ctx⟧";
const INBOUND_META_HEADER_RE = new RegExp(
  `^[^\\n]*(?:${INBOUND_CONTEXT_MARKER}|\\(untrusted metadata\\))[^\\n]*$`,
);

function isInboundMetaHeaderLine(line: string): boolean {
  return INBOUND_META_HEADER_RE.test(line.trim());
}

/** Removes host-injected inbound metadata blocks (header plus fenced JSON or paragraph). */
export function stripMetadataEnvelopes(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isInboundMetaHeaderLine(lines[i] ?? "")) {
      kept.push(lines[i] ?? "");
      continue;
    }
    if (lines[i + 1]?.trim() === "```json") {
      let close = i + 2;
      while (close < lines.length && lines[close]?.trim() !== "```") {
        close++;
      }
      i = close;
    } else {
      let blank = i + 1;
      while (blank < lines.length && lines[blank]?.trim() !== "") {
        blank++;
      }
      i = blank;
    }
  }
  return kept
    .join("\n")
    .replace(/^---\n/, "")
    .replace(/\n---$/, "")
    .trim();
}

const RUNTIME_ID_LINE_RE = /^(?:\[message_id:\s*)?(?:om|ou|oc)_[A-Za-z0-9_-]+\]?$/i;

export function stripRuntimeEnvelope(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !RUNTIME_ID_LINE_RE.test(line.trim()))
    .join("\n");
}

/** Every cleanup step applied to text before it is retained or used as a recall query. */
export function cleanMessageText(content: string): string {
  return stripRuntimeEnvelope(
    stripInlineTimestampPrefix(
      stripMetadataEnvelopes(stripInlineRetainTags(stripMemoryTags(content))),
    ),
  ).trim();
}

const OPERATIONAL_TEXT_PATTERNS = [
  /^A new session was started via \/(?:new|reset)\./i,
  /^Based on this conversation, generate a short 1-2/i,
  /^This (?:script|task|job|workflow) updates .* index/i,
];

/** Host-generated bootstrap text that must not drive recall or retain. */
export function isEphemeralOperationalText(text: string): boolean {
  const normalized = text
    .replace(/\[role:\s*[^\]]+\]\s*/gi, "")
    .replace(/\[[a-z]+:end\]\s*/gi, "")
    .trim();
  return OPERATIONAL_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

const MIN_QUERY_CHARS = 5;

/** The user's current request with host envelopes removed and capped, or null when too short. */
export function extractRecallQuery(currentUserMessage: string | undefined, prompt: string) {
  const candidates = [currentUserMessage, prompt];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    let cleaned = cleanMessageText(candidate);
    cleaned = cleaned.replace(/^(?:System:.*\n)+\n?/, "");
    cleaned = cleaned.replace(/\n\[from:[^\]]*\]\s*$/, "").trim();
    if (cleaned.length >= MIN_QUERY_CHARS && !/^\s*system:/i.test(cleaned)) {
      return cleaned.slice(0, RECALL_MAX_QUERY_CHARS);
    }
  }
  return null;
}

function formatOccurred(start?: string | null, end?: string | null): string {
  if (start && end) {
    return start === end ? ` [occurred: ${start}]` : ` [occurred: ${start} -> ${end}]`;
  }
  if (start) {
    return ` [occurred from: ${start}]`;
  }
  if (end) {
    return ` [occurred until: ${end}]`;
  }
  return "";
}

export function formatMemories(results: readonly HindsightRecallResult[]): string {
  return results
    .map((r) => {
      const type = r.type ? ` [${r.type}]` : "";
      const date = r.mentioned_at ? ` (${r.mentioned_at})` : "";
      const doc = r.document_id ? ` [doc:${r.document_id}]` : "";
      return `- ${r.text}${type}${date}${formatOccurred(r.occurred_start, r.occurred_end)}${doc}`;
    })
    .join("\n\n");
}

/** Stops recalled text from closing (or reopening) the wrapper it is rendered inside. */
export function neutralizeMemoryTags(text: string): string {
  return text.replace(/<(\/?hindsight_memories>)/gi, "&lt;$1");
}

export function buildRecallContext(
  results: readonly HindsightRecallResult[],
  preamble: string,
  now: Date = new Date(),
): string {
  return `<${MEMORIES_TAG}>\n${preamble}\nCurrent time - ${now.toISOString()}\n\n${neutralizeMemoryTags(formatMemories(results))}\n</${MEMORIES_TAG}>`;
}

function fingerprint(message: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(message) ?? "")
    .digest("hex");
}

/**
 * Marks where a run starts: the fingerprint of the last message the session already had
 * (excluding the current request), or null for an empty session.
 */
export function runStartMarker(messages: readonly unknown[], currentUserMessage?: string) {
  let end = messages.length;
  const last = messages[end - 1];
  if (
    asMessage(last)?.role === "user" &&
    typeof currentUserMessage === "string" &&
    messageText(last).trim() === currentUserMessage.trim()
  ) {
    end -= 1;
  }
  return end > 0 ? fingerprint(messages[end - 1]) : null;
}

export function retainStartIndex(messages: readonly unknown[], marker: string | null | undefined) {
  if (marker === undefined) {
    return undefined;
  }
  if (marker === null) {
    return 0;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (fingerprint(messages[i]) === marker) {
      return i + 1;
    }
  }
  return undefined;
}

function normalizeTimestamp(message: unknown): string | undefined {
  const raw = asMessage(message)?.timestamp;
  if (typeof raw !== "number" && typeof raw !== "string") {
    return undefined;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export type RetentionTranscript = { transcript: string; messageCount: number; tags: string[] };

/**
 * The run's text messages (from its start when known, else from the last user message) with
 * injected memories and host envelopes removed. Tool calls and tool results are not retained.
 */
export function prepareRetentionTranscript(
  messages: readonly unknown[],
  runStartIdx?: number,
): RetentionTranscript | null {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (asMessage(messages[i])?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    return null;
  }
  const start = runStartIdx === undefined ? lastUserIdx : Math.min(runStartIdx, lastUserIdx);
  const allowed = new Set<string>(MEMORY_ROLES);
  const normalized: Array<{ role: string; content: string; timestamp?: string }> = [];
  const tagSources: string[] = [];
  for (const message of messages.slice(start)) {
    const role = asMessage(message)?.role;
    if (typeof role !== "string" || !allowed.has(role)) {
      continue;
    }
    const raw = messageText(message);
    if (role === "user") {
      tagSources.push(...extractInlineRetainTags(raw));
    }
    const content = cleanMessageText(raw);
    if (!content) {
      continue;
    }
    const timestamp = normalizeTimestamp(message);
    normalized.push(timestamp ? { role, content, timestamp } : { role, content });
  }
  if (normalized.length === 0) {
    return null;
  }
  const transcript = JSON.stringify(normalized);
  if (transcript.trim().length < 10) {
    return null;
  }
  return { transcript, messageCount: normalized.length, tags: normalizeTags(tagSources) };
}
