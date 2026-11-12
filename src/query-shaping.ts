/**
 * Recall query shaping for host-wrapped prompts (config `recallQueryShaping`, default "off").
 *
 * OpenClaw wraps every subagent task in internal-context blocks (run notes, spawning rules,
 * session labels and keys) before the task text. The auto-recall query is the cleaned message
 * capped at 800 characters, so with "off" most of a subagent's query is that wrapper.
 *
 * - "off": the cleaned message, capped (the behavior before this key existed).
 * - "strip": removes the internal-context blocks first, then caps. Text without such a block is
 *   unchanged, so plain user messages and inter-session messages get the same query as "off".
 *
 * Pure functions with no host imports, so the recall eval can run this file directly.
 */

export type RecallQueryShaping = "off" | "strip";

export const RECALL_QUERY_SHAPING_MODES: readonly RecallQueryShaping[] = ["off", "strip"];

const INTERNAL_CONTEXT_OPEN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
// An unterminated block runs to the end of the text: the host's wrapper never carries user text.
const INTERNAL_CONTEXT_BLOCK_RE =
  /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?(?:<<<END_OPENCLAW_INTERNAL_CONTEXT>>>|$)/g;
// The host timestamp that preceded the first block, left at the start once the block is gone.
const LEADING_TIMESTAMP_RE =
  /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+[A-Z]{2,5}\]\s*/;

/** Removes OpenClaw internal-context blocks and a timestamp they leave at the start. */
export function stripInternalContext(text: string): string {
  if (!text.includes(INTERNAL_CONTEXT_OPEN)) {
    return text;
  }
  return text.replace(INTERNAL_CONTEXT_BLOCK_RE, "\n").trim().replace(LEADING_TIMESTAMP_RE, "");
}

/** Applies the configured shaping to cleaned, uncapped recall text, then caps it. */
export function shapeRecallQuery(text: string, mode: RecallQueryShaping, maxChars: number): string {
  const shaped = mode === "strip" ? stripInternalContext(text) : text;
  return shaped.slice(0, maxChars);
}
