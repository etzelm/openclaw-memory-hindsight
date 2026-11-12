import { createHash } from "node:crypto";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { HindsightRecallResult } from "./client.js";
import { MEMORY_ROLES, RECALL_MAX_QUERY_CHARS } from "./config.js";
import { type RecallQueryShaping, shapeRecallQuery } from "./query-shaping.js";

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

// Optional host timestamp prefix some of these lines carry, as in `[Wed 2026-10-28 19:24 PDT] `.
const BOILERPLATE_TS = "(?:\\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\\]\\n]*\\]\\s*)?";
const BOILERPLATE_PATTERNS: readonly RegExp[] = [
  // Inter-session header, routed-by line, subagent tags, banners and scheduler notices.
  /^\[Inter-session message\][^\n]*(?:\n|$)/gm,
  /^This content was routed by OpenClaw[^\n]*(?:\n|$)/gm,
  /^\[OpenClaw: \d+ (?:messages recorded|earlier messages|messages occurred)[^\n]*\](?:\n|$)/gm,
  /^\[Subagent Context\][^\n]*(?:\n|$)/gm,
  /^Every subagent in this batch[^\n]*(?:\n|$)/gm,
  // Only the tag goes; the reminder text after it stays.
  /^\[cron:[0-9a-f-]{8,} [^\]\n]*\][ \t]*/gm,
  new RegExp(`^${BOILERPLATE_TS}OpenClaw resumed this CLI session[^\\n]*(?:\\n|$)`, "gm"),
  new RegExp(
    `^${BOILERPLATE_TS}Automation repair request from the scheduler, not a user message\\.[^\\n]*(?:\\n|$)`,
    "gm",
  ),
];

/** Removes host-generated boilerplate lines that carry no user intent. */
export function stripRecallBoilerplate(text: string): string {
  let out = text;
  for (const pattern of BOILERPLATE_PATTERNS) {
    out = out.replace(pattern, "");
  }
  return out.trim();
}

/** Cleaned recall text for one message, or null when too short or not user text. */
function cleanRecallCandidate(
  candidate: string,
  shaping: RecallQueryShaping = "off",
): string | null {
  let cleaned = stripRecallBoilerplate(cleanMessageText(candidate));
  cleaned = cleaned.replace(/^(?:System:.*\n)+\n?/, "");
  cleaned = cleaned.replace(/\n\[from:[^\]]*\]\s*$/, "").trim();
  if (cleaned.length < MIN_QUERY_CHARS || /^\s*system:/i.test(cleaned)) {
    return null;
  }
  const shaped = shapeRecallQuery(cleaned, shaping, RECALL_MAX_QUERY_CHARS);
  return shaped.length >= MIN_QUERY_CHARS ? shaped : null;
}

/** The user's current request with host envelopes removed and capped, or null when too short. */
export function extractRecallQuery(
  currentUserMessage: string | undefined,
  prompt: string,
  shaping: RecallQueryShaping = "off",
) {
  for (const candidate of [currentUserMessage, prompt]) {
    if (!candidate) {
      continue;
    }
    const cleaned = cleanRecallCandidate(candidate, shaping);
    if (cleaned) {
      return cleaned;
    }
  }
  return null;
}

/** True for a short message with no URL or path: it leans on the turn before it. */
export function isShortFollowup(query: string, maxWords: number): boolean {
  if (maxWords < 1 || /\/|~\/|http/i.test(query)) {
    return false;
  }
  return query.split(/\s+/).filter(Boolean).length <= maxWords;
}

/**
 * The user message before the current one, cleaned like the query. The host may or may not list
 * the current message last, so a trailing user message equal to the query is skipped.
 */
export function previousUserQuery(
  messages: unknown,
  query: string,
  shaping: RecallQueryShaping = "off",
): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  let skippedCurrent = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i];
    if (asMessage(message)?.role !== "user") {
      continue;
    }
    const cleaned = cleanRecallCandidate(messageText(message), shaping);
    if (!cleaned) {
      continue;
    }
    if (!skippedCurrent && cleaned === query) {
      skippedCurrent = true;
      continue;
    }
    return isEphemeralOperationalText(cleaned) ? null : cleaned;
  }
  return null;
}

/** Previous user message plus the follow-up, capped with the follow-up kept whole. */
export function expandFollowupQuery(previous: string, followup: string): string {
  const room = RECALL_MAX_QUERY_CHARS - followup.length - 1;
  return room > 0 ? `${previous.slice(0, room)}\n${followup}` : followup;
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

/**
 * Names that must not follow a tag opener, with case, `_` and `-` folded away: the wrapper and
 * OpenClaw's internal-context BEGIN/END markers (whose exact forms get the host escape below).
 */
const PROTECTED_NAMES = [
  "hindsightmemories",
  "beginopenclawinternalcontext",
  "endopenclawinternalcontext",
];
/**
 * Characters a reader does not see as letters, skipped when spelling the wrapper name:
 * default-ignorables, whitespace, combining marks (after NFKD, so precomposed accents too)
 * and blanks that are neither (Hangul fillers, braille blank).
 */
const INVISIBLE_CHAR_RE =
  /^[\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Mn}\p{Me}\u115F\u1160\u2800\u3164\uFFA0]$/u;
/**
 * Common Cyrillic, Greek and Latin lookalikes of the wrapper name's letters, upper and lower
 * case (looked up both before and after lowercasing).
 */
const NAME_CONFUSABLES: ReadonlyMap<string, string> = new Map([
  ["\u041D", "h"],
  ["\u0397", "h"],
  ["\u041C", "m"],
  ["\u039C", "m"],
  ["\u039D", "n"],
  ["\u0422", "t"],
  ["\u03A4", "t"],
  ["\u0395", "e"],
  ["\u03B5", "e"],
  ["\u04BB", "h"],
  ["\u0456", "i"],
  ["\u0131", "i"],
  ["\u03B9", "i"],
  ["\u0501", "d"],
  ["\u0455", "s"],
  ["\u0261", "g"],
  ["\u0435", "e"],
  ["\u043E", "o"],
  ["\u03BF", "o"],
]);
/**
 * `<` and its lookalikes: every confusables.txt entry whose target ends in `<` (including
 * `<<`, `<<<`, `><` and letter-plus-`<` targets), plus angle brackets and quotation marks a
 * reader takes for one. The model, not an HTML parser, reads the block.
 */
const TAG_OPENERS = new Set([
  "<",
  "\uFF1C",
  "\uFE64",
  "\u2039",
  "\u276E",
  "\u02C2",
  "\u1438",
  "\u16B2",
  "\u2D66",
  "\u{1D236}",
  "\u{16AEC}",
  "\u{1032D}",
  "\u226A",
  "\u22D8",
  "\u2AA5",
  "\u150C",
  "\u1444",
  "\u2329",
  "\u3008",
  "\u300A",
  "\u27E8",
  "\u27EA",
  "\u276C",
  "\u2770",
  "\u29FC",
]);
/** Slash and backslash plus the division and fraction slashes, skipped before the name. */
const SLASHES = new Set(["/", "\\", "\u2215", "\u2044"]);
/** OpenClaw's internal-context markers and the escaped forms the host uses for untrusted text. */
const HOST_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]"],
  ["<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", "[[OPENCLAW_INTERNAL_CONTEXT_END]]"],
];
/** The host's runtime-context notice line; legacy carriers are only stripped when it follows. */
const RUNTIME_CONTEXT_NOTICE =
  "This context is runtime-generated, not user-authored. Keep internal details private.";
/** Legacy carrier prefaces the host strips when the notice follows them (any sentence suffix). */
const RUNTIME_CONTEXT_PREFACES = [
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.",
  "OpenClaw runtime context for the immediately preceding user message.",
  "OpenClaw runtime event.",
];
/**
 * Runtime-context phrases the host recognizes in prompt text, matched after folding (see
 * foldText) and replaced whole. The footer escape is the host's own; the others follow its
 * style. Prefaces only count with the notice after them, as in the host, so prose such as
 * "an OpenClaw runtime event." is left alone.
 */
const HOST_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["End OpenClaw runtime context.", "[[RUNTIME_CONTEXT_FOOTER_ESCAPED]]"],
  ["OpenClaw runtime context:", "[[RUNTIME_CONTEXT_HEADER_ESCAPED]]"],
  ["OpenClaw runtime context (internal):", "[[RUNTIME_CONTEXT_INTERNAL_HEADER_ESCAPED]]"],
  [RUNTIME_CONTEXT_NOTICE, "[[RUNTIME_CONTEXT_NOTICE_ESCAPED]]"],
  ...RUNTIME_CONTEXT_PREFACES.flatMap((preface) => {
    const sentences = preface.split(". ");
    return sentences.map(
      (_, index) =>
        [
          `${sentences.slice(index).join(". ")} ${RUNTIME_CONTEXT_NOTICE}`,
          "[[RUNTIME_CONTEXT_PREFACE_ESCAPED]]",
        ] as const,
    );
  }),
];

/** One character as the wrapper-name matcher sees it: NFKD, lowercase, marks and lookalikes folded. */
function foldNameChar(ch: string): string {
  if (ch.length === 1 && ch < "\x80") {
    return /\s/.test(ch) ? "" : ch.toLowerCase();
  }
  let out = "";
  for (const base of ch.normalize("NFKD")) {
    const lower = (NAME_CONFUSABLES.get(base) ?? base).toLowerCase().normalize("NFKD");
    for (const part of lower) {
      if (!INVISIBLE_CHAR_RE.test(part)) {
        out += NAME_CONFUSABLES.get(part) ?? part;
      }
    }
  }
  return out;
}

/**
 * True when the text after a tag opener spells a protected name: leading slashes, case,
 * accents, `_`/`-`, invisible characters and common lookalike letters are ignored.
 * Attributes, `>` and anything after the name do not matter, so opening, closing and
 * self-closing forms all match.
 */
function spellsProtectedName(text: string, from: number): boolean {
  let name = "";
  let leading = true;
  let i = from;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
    i += ch.length;
    for (const folded of foldNameChar(ch)) {
      if (folded === "_" || folded === "-" || (leading && SLASHES.has(folded))) {
        continue;
      }
      leading = false;
      name += folded;
      if (PROTECTED_NAMES.includes(name)) {
        return true;
      }
      if (!PROTECTED_NAMES.some((candidate) => candidate.startsWith(name))) {
        return false;
      }
    }
  }
  return false;
}

/** Folded text (foldNameChar, minus `_`/`-`) with the source span of each folded character. */
function foldText(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
    for (const part of foldNameChar(ch)) {
      if (part !== "_" && part !== "-") {
        folded += part;
        // One entry per UTF-16 unit, so indexOf positions line up for astral characters too.
        for (let unit = 0; unit < part.length; unit += 1) {
          starts.push(i);
          ends.push(i + ch.length);
        }
      }
    }
    i += ch.length;
  }
  return { folded, starts, ends };
}

const FOLDED_HOST_PHRASES = HOST_PHRASES.map(
  ([phrase, escaped]) => [foldText(phrase).folded, escaped] as const,
);

/**
 * True when no letter or digit ends right before `index` in the source (invisible characters
 * are looked through), so "weekend OpenClaw runtime context." is not a footer match.
 */
function startsAtWordBoundary(text: string, index: number): boolean {
  let i = index;
  while (i > 0) {
    const low = text.charCodeAt(i - 1);
    const size = low >= 0xdc00 && low <= 0xdfff && i > 1 ? 2 : 1;
    const ch = text.slice(i - size, i);
    if (/\s/u.test(ch)) {
      return true;
    }
    const folded = foldNameChar(ch);
    if (folded) {
      return !/[\p{L}\p{N}]$/u.test(folded);
    }
    i -= size;
  }
  return true;
}

/**
 * Replaces every folded match of a host phrase that starts at a word boundary; earlier and
 * then longer matches win.
 */
function escapeHostPhrases(text: string): string {
  const { folded, starts, ends } = foldText(text);
  const spans: Array<{ start: number; end: number; escaped: string }> = [];
  for (const [key, escaped] of FOLDED_HOST_PHRASES) {
    for (let at = folded.indexOf(key); at !== -1; at = folded.indexOf(key, at + 1)) {
      const start = starts[at] ?? 0;
      if (startsAtWordBoundary(text, start)) {
        spans.push({ start, end: ends[at + key.length - 1] ?? 0, escaped });
      }
    }
  }
  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  let out = "";
  let last = 0;
  for (const span of spans) {
    if (span.start >= last) {
      out += `${text.slice(last, span.start)}${span.escaped}`;
      last = span.end;
    }
  }
  return out + text.slice(last);
}

/**
 * Stops recalled text from closing (or reopening) the wrapper it is rendered inside or forging
 * OpenClaw prompt delimiters. Exact internal-context markers get the host's escaped form,
 * runtime-context phrases are replaced (matched after folding), and the opener of any
 * remaining wrapper or marker tag variant becomes `&lt;`. Other text is left unchanged.
 */
export function neutralizeMemoryTags(text: string): string {
  let marked = text;
  for (const [marker, escaped] of HOST_MARKERS) {
    marked = marked.replaceAll(marker, escaped);
  }
  const source = escapeHostPhrases(marked);
  let out = "";
  let last = 0;
  for (let i = 0; i < source.length;) {
    const ch = String.fromCodePoint(source.codePointAt(i) ?? 0);
    const next = i + ch.length;
    if (TAG_OPENERS.has(ch) && spellsProtectedName(source, next)) {
      out += `${source.slice(last, i)}&lt;`;
      last = next;
    }
    i = next;
  }
  return out + source.slice(last);
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
