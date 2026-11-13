import type { HindsightDirective } from "./client.js";

/** How long fetched directives count as fresh; after that the next prompt build refetches. */
export const DIRECTIVES_TTL_MS = 10 * 60_000;
/** Most directives listed in the prompt section, highest priority first. */
export const MAX_PROMPT_DIRECTIVES = 20;
/** Longest directive text listed; longer text is cut with "...". */
export const MAX_DIRECTIVE_CHARS = 500;

const flatten = (text: string) => text.replace(/\s+/g, " ").trim();
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);

/**
 * The directives the prompt lists: active and global (no tags; a tag-scoped directive only
 * applies to a reflect with a matching scope, which a system prompt does not have), highest
 * priority first, then by name, so the same set always renders the same lines.
 */
export function promptDirectives(directives: readonly HindsightDirective[]): HindsightDirective[] {
  return directives
    .filter((d) => d.isActive && d.tags.length === 0 && flatten(d.content))
    .toSorted(
      (a, b) => b.priority - a.priority || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    )
    .slice(0, MAX_PROMPT_DIRECTIVES);
}

/** Prompt lines for the directives; none when there are none. */
export function directiveLines(directives: readonly HindsightDirective[]): string[] {
  const listed = promptDirectives(directives);
  if (listed.length === 0) {
    return [];
  }
  return [
    "## Hindsight directives",
    "Hard rules from this agent's memory bank. Follow them in every reply and tool call:",
    ...listed.map((d) => {
      const name = cut(flatten(d.name), 80);
      const text = cut(flatten(d.content), MAX_DIRECTIVE_CHARS);
      return name ? `- ${name}: ${text}` : `- ${text}`;
    }),
  ];
}

type Entry = { lines: string[]; fetchedAt: number; inflight?: Promise<void> };

/**
 * Directive lines per bank for the synchronous prompt builder. A build never waits for the
 * network: it returns what is cached and, when that is missing or older than the TTL, starts one
 * background fetch. Lines change only when the directives do, so the cached prompt prefix stays
 * stable between refreshes. A failed fetch keeps the previous lines.
 */
export function createDirectiveCache(params: {
  fetch: (bankId: string) => Promise<HindsightDirective[]>;
  onError?: (bankId: string, error: unknown) => void;
  now?: () => number;
  ttlMs?: number;
}) {
  const entries = new Map<string, Entry>();
  const now = params.now ?? Date.now;
  const ttlMs = params.ttlMs ?? DIRECTIVES_TTL_MS;

  const refresh = (bankId: string): Promise<void> => {
    const entry = entries.get(bankId);
    if (entry?.inflight) {
      return entry.inflight;
    }
    const inflight = params
      .fetch(bankId)
      .then((directives) => {
        entries.set(bankId, { lines: directiveLines(directives), fetchedAt: now() });
      })
      .catch((error: unknown) => {
        // Keep the old lines, and wait a full TTL before the next try.
        entries.set(bankId, { lines: entries.get(bankId)?.lines ?? [], fetchedAt: now() });
        params.onError?.(bankId, error);
      });
    entries.set(bankId, {
      lines: entry?.lines ?? [],
      fetchedAt: entry?.fetchedAt ?? -Infinity,
      inflight,
    });
    return inflight;
  };

  return {
    /** Cached lines for the bank; starts a background refresh when missing or stale. */
    lines(bankId: string): string[] {
      const entry = entries.get(bankId);
      if (!entry || (!entry.inflight && now() - entry.fetchedAt >= ttlMs)) {
        void refresh(bankId);
      }
      return entries.get(bankId)?.lines ?? [];
    },
    /** Fetches the banks now (at service start), so the first prompt already has them. */
    prefetch(bankIds: readonly string[]): Promise<void> {
      return Promise.all([...new Set(bankIds)].map(refresh)).then(() => undefined);
    },
  };
}
