import { createHash } from "node:crypto";

/**
 * Document ids of auto-retained runs. One document per run, so a continuation or re-delivery
 * replaces it; the session part lets `openclaw hindsight forget` find every run of a session.
 */

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

/** `openclaw:<sanitized session>-<digest>:run:`, the start of every run document of a session. */
export function sessionDocumentPrefix(sessionKey: string | undefined): string {
  return `openclaw:${sanitizeDocumentIdPart(sessionKey, "session")}-${sessionKeyDigest(sessionKey)}:run:`;
}

export function runDocumentId(
  sessionKey: string | undefined,
  runId: string | undefined,
  fallbackRun: () => string = () => `${Date.now()}`,
): string {
  return `${sessionDocumentPrefix(sessionKey)}${sanitizeDocumentIdPart(runId, fallbackRun())}`;
}
