import type { RecallBudget, RecallTagGroup, RecallType } from "./config.js";

export type RecallMinScores = { final?: number };

/** One recall hit as the Hindsight API returns it (fields this plugin reads). */
export type HindsightRecallResult = {
  id: string;
  text: string;
  type?: string | null;
  mentioned_at?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
  document_id?: string | null;
  scores?: { final?: number | null } | null;
};

/** The string-valued entries of a JSON object; anything else is empty. */
function stringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
  }
  return out;
}

/** One recall hit reduced to the fields private transcript recall reads. */
export type HindsightRecallHit = { documentId: string; chunkId: string; type?: string };

export type HindsightRetainItem = {
  content: string;
  context?: string;
  metadata?: Record<string, string>;
  document_id?: string;
  tags?: string[];
  timestamp?: string;
  update_mode?: "replace" | "append";
};

export type HindsightRecallOptions = {
  budget: RecallBudget;
  maxTokens?: number;
  types?: RecallType[];
  preferObservations?: boolean;
  minScores?: RecallMinScores;
  tagGroups?: RecallTagGroup[];
  /** Hindsight's `temporal_window`: ranks memories dated inside it higher; does not filter. */
  temporalWindow?: { start: string; end: string };
  /** Sends `include: {entities: null}`: no entity observations, which the plugin never reads. */
  skipEntities?: boolean;
  signal?: AbortSignal;
};

export type HindsightBankDefaults = {
  retainMission?: string;
};

/** HTTP status from the Hindsight API; 404 on a bank nothing was retained to yet. */
export class HindsightHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True only for Hindsight's "Bank '<id>' not found" 404, not for a route that does not exist. */
    readonly bankMissing = false,
    /** True only when the body said so; an empty 404 body sets `bankMissing` but not this. */
    readonly bankMissingExplicit = false,
    /** True only for Hindsight's "Page '<id>' not found" (or "Knowledge page ...") 404. */
    readonly pageMissing = false,
    /** True only for the framework's bare `{"detail":"Not Found"}` 404: no such route. */
    readonly routeMissing = false,
  ) {
    super(message);
    this.name = "HindsightHttpError";
  }

  /** From a 429 or 5xx `Retry-After` header: how long the server asked us to wait. */
  retryAfterMs?: number;
}

/** `Retry-After` as delay seconds or an HTTP date; undefined when absent, invalid or past. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  const at = Date.parse(text);
  return Number.isFinite(at) && at > now ? at - now : undefined;
}

export function isBankNotFound(error: unknown): boolean {
  return error instanceof HindsightHttpError && error.bankMissing;
}

/**
 * Hindsight answers a missing bank with 404 `{"detail":"Bank '<id>' not found"}` and an unknown
 * route (wrong hindsightApiUrl path, proxy prefix) with 404 `{"detail":"Not Found"}`. Only the
 * first means "no memories yet"; the second stays a loud error. An empty 404 body counts as a
 * missing bank, as before. The body is only inspected, never copied into the error.
 */
export function isBankMissingBody(text: string): boolean {
  return !text.trim() || isExplicitBankMissingBody(text);
}

/** Only Hindsight's `Bank '<id>' not found` detail, without the empty-body fallback. */
export function isExplicitBankMissingBody(text: string): boolean {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown } | null)?.detail;
    return typeof detail === "string" && /\bbank\b.*\bnot found\b/i.test(detail);
  } catch {
    return false;
  }
}

/**
 * The bare `{"detail":"Not Found"}` an unknown route gets. An empty 404 body keeps its old meaning
 * (a missing bank), so it is not a route 404.
 */
export function isRouteMissingBody(text: string): boolean {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown } | null)?.detail;
    return typeof detail === "string" && /^not found$/i.test(detail.trim());
  } catch {
    return false;
  }
}

/**
 * Only Hindsight's missing-page detail: `Page '<id>' not found` (1.2.1, both routes) or the older
 * `Knowledge page '<id>' not found`. A route "Not Found" names no page, so it does not count.
 */
export function isExplicitPageMissingBody(text: string): boolean {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown } | null)?.detail;
    return typeof detail === "string" && /\bpage\b.*\bnot found\b/i.test(detail);
  } catch {
    return false;
  }
}

/** Largest knowledge-base response body read; a bigger one fails instead of filling memory. */
export const KB_MAX_RESPONSE_BYTES = 1024 * 1024;
/** Largest recall, reflect or memory-lookup body read; far above what max_tokens 1024 returns. */
export const MEMORY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// Error bodies are only classified, never copied, so a small prefix is enough.
const ERROR_BODY_MAX_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

/** Reads at most `maxBytes` of the body; throws BodyTooLargeError past it and stops reading. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One folder or page of the knowledge-base tree (fields this plugin reads). */
export type HindsightKnowledgeNode = {
  id: string;
  kind: "folder" | "page";
  name: string;
  is_stale?: boolean | null;
  children?: HindsightKnowledgeNode[] | null;
};

export type HindsightKnowledgeSearchHit = {
  id: string;
  name: string;
  snippet: string;
};

/** One bank directive (a hard rule Hindsight adds to reflect prompts). */
export type HindsightDirective = {
  id: string;
  name: string;
  content: string;
  priority: number;
  isActive: boolean;
  /** Empty: a global directive. Otherwise it only applies to a reflect with a matching scope. */
  tags: string[];
};

/** A directive from the API, or null when the item lacks an id, name or content. */
export function toDirective(raw: unknown): HindsightDirective | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.content !== "string") {
    return null;
  }
  return {
    id: r.id,
    name: r.name,
    content: r.content,
    priority: typeof r.priority === "number" ? r.priority : 0,
    isActive: r.is_active !== false,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
  };
}

/** One memory unit with the fields `openclaw hindsight memory` shows. */
export type HindsightMemoryDetail = {
  id: string;
  text: string;
  type?: string;
  context?: string;
  mentionedAt?: string;
  occurredStart?: string;
  occurredEnd?: string;
  documentId?: string;
  tags: string[];
  entities: string[];
  /** "valid" or "invalidated" (Hindsight 1.2.1 curation state). */
  state?: string;
  invalidationReason?: string;
  editedAt?: string;
  consolidatedAt?: string;
};

const optionalString = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** A memory unit from the API, or null without an id and text. */
export function toMemoryDetail(raw: unknown): HindsightMemoryDetail | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.text !== "string") {
    return null;
  }
  const detail: HindsightMemoryDetail = {
    id: r.id,
    text: r.text,
    tags: stringList(r.tags),
    entities: stringList(r.entities),
  };
  const fields: Array<[keyof HindsightMemoryDetail, unknown]> = [
    ["type", r.type],
    ["context", r.context],
    ["mentionedAt", r.mentioned_at],
    ["occurredStart", r.occurred_start],
    ["occurredEnd", r.occurred_end],
    ["documentId", r.document_id],
    ["state", r.state],
    ["invalidationReason", r.invalidation_reason],
    ["editedAt", r.edited_at],
    ["consolidatedAt", r.consolidated_at],
  ];
  for (const [key, value] of fields) {
    const text = optionalString(value);
    if (text !== undefined) {
      (detail as Record<string, unknown>)[key] = text;
    }
  }
  return detail;
}

/** Status of a Hindsight async operation (consolidation, refresh, batch retain). */
export type HindsightOperationStatus = {
  id: string;
  /** pending, processing, completed, failed, cancelled or not_found. */
  status: string;
  type?: string;
  error?: string;
  progress?: {
    stage?: string;
    processed?: number;
    total?: number;
    detail?: Record<string, number>;
  };
};

/** Statuses after which an operation does not change any more. */
export const TERMINAL_OPERATION_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "not_found",
] as const;

/** Directives read per list request, and the most pages read (Hindsight caps a page at 1000). */
const DIRECTIVE_PAGE = 100;
const MAX_DIRECTIVE_PAGES = 10;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HindsightClientOptions = {
  /** Read per request so a token rotated by `openclaw secrets reload` applies without restart. */
  resolveEndpoint(): { apiUrl: string; apiToken?: string };
  fetch?: FetchLike;
  userAgent?: string;
};

const HEALTH_TIMEOUT_MS = 5_000;
// Operator commands (openclaw hindsight): listing and deleting documents, checking auth.
const ADMIN_TIMEOUT_MS = 10_000;
const DELETE_TIMEOUT_MS = 30_000;

/** A fixed timeout, combined with the host signal when there is one (host abort still wins). */
export function boundedSignal(timeoutMs: number, hostSignal?: AbortSignal): AbortSignal {
  return AbortSignal.any(
    [hostSignal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => Boolean(s)),
  );
}

/**
 * A 404 for the route itself, not for a bank or page. Pages moved from `/knowledge-base/*` to
 * `/pages/*`; a server without the new routes answers like this. An oversized or unknown 404 body
 * is not a route 404 and stays an error.
 */
function isRouteMissing(error: unknown): boolean {
  return error instanceof HindsightHttpError && error.routeMissing;
}

/** Minimal fetch client for the Hindsight v1 HTTP API. No SDK dependency. */
export class HindsightClient {
  private readonly fetchImpl: FetchLike;
  /** Set once a server answered a `/pages/*` route with a route 404; later page reads skip it. */
  private legacyPagesRoutes = false;

  constructor(private readonly options: HindsightClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private bankUrl(bankId: string, suffix = ""): string {
    const { apiUrl } = this.options.resolveEndpoint();
    return `${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`;
  }

  private headers(withBody: boolean): Record<string, string> {
    const { apiToken } = this.options.resolveEndpoint();
    return {
      Accept: "application/json",
      "User-Agent": this.options.userAgent ?? "openclaw-memory-hindsight",
      ...(withBody ? { "Content-Type": "application/json" } : {}),
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
    };
  }

  private async request<T>(
    operation: string,
    url: string,
    init: { method: string; body?: unknown; signal?: AbortSignal; maxBodyBytes?: number },
  ): Promise<T> {
    const hasBody = init.body !== undefined;
    const response = await this.fetchImpl(url, {
      method: init.method,
      headers: this.headers(hasBody),
      redirect: "error",
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (!response.ok) {
      let body = "";
      if (response.status === 404) {
        try {
          body = await readBoundedText(response, ERROR_BODY_MAX_BYTES);
        } catch (error) {
          // An oversized body is not "empty", so it never reads as a missing bank. A read that
          // failed (aborted, connection lost) says nothing about the bank: throw that error.
          if (!(error instanceof BodyTooLargeError)) {
            throw error;
          }
          body = "<oversized>";
        }
      } else {
        // Never read, so release the connection instead of leaving the body to the GC.
        await response.body?.cancel().catch(() => undefined);
      }
      const bankMissing = response.status === 404 && isBankMissingBody(body);
      const bankMissingExplicit = response.status === 404 && isExplicitBankMissingBody(body);
      const pageMissing = response.status === 404 && isExplicitPageMissingBody(body);
      const routeMissing = response.status === 404 && isRouteMissingBody(body);
      // Server error bodies can echo request content; keep only the status in the message.
      const error = new HindsightHttpError(
        `Hindsight ${operation} failed: HTTP ${response.status}`,
        response.status,
        bankMissing,
        bankMissingExplicit,
        pageMissing,
        routeMissing,
      );
      if (response.status === 429 || response.status >= 500) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        if (retryAfterMs !== undefined) {
          error.retryAfterMs = retryAfterMs;
        }
      }
      throw error;
    }
    let text: string;
    if (init.maxBodyBytes === undefined) {
      text = await response.text();
    } else {
      try {
        text = await readBoundedText(response, init.maxBodyBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          throw new Error(
            `Hindsight ${operation} failed: response larger than ${init.maxBodyBytes} bytes`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    // SAFETY: T only names optional fields; every caller type-checks each field before use.
    return (text ? JSON.parse(text) : {}) as T;
  }

  async retain(
    bankId: string,
    item: HindsightRetainItem,
    options: { async?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request("retain", this.bankUrl(bankId, "/memories"), {
      method: "POST",
      body: { items: [item], async: options.async ?? true },
      signal: options.signal,
    });
  }

  async recall(
    bankId: string,
    query: string,
    options: HindsightRecallOptions,
  ): Promise<HindsightRecallResult[]> {
    const body: Record<string, unknown> = { query, budget: options.budget };
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options.types?.length) {
      body.types = options.types;
    }
    if (options.preferObservations !== undefined) {
      body.prefer_observations = options.preferObservations;
    }
    if (options.minScores) {
      body.min_scores = options.minScores;
    }
    if (options.tagGroups?.length) {
      body.tag_groups = options.tagGroups;
    }
    if (options.temporalWindow) {
      body.temporal_window = options.temporalWindow;
    }
    if (options.skipEntities) {
      body.include = { entities: null };
    }
    const response = await this.request<{ results?: HindsightRecallResult[] }>(
      "recall",
      this.bankUrl(bankId, "/memories/recall"),
      { method: "POST", body, signal: options.signal, maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES },
    );
    return Array.isArray(response.results) ? response.results : [];
  }

  async reflect(
    bankId: string,
    query: string,
    options: { budget: RecallBudget; types?: RecallType[]; signal?: AbortSignal },
  ): Promise<string> {
    // Hindsight 1.2.1 ReflectRequest has fact_types; it has no temporal window.
    const body: Record<string, unknown> = { query, budget: options.budget };
    if (options.types?.length) {
      body.fact_types = options.types;
    }
    const response = await this.request<{ text?: string }>(
      "reflect",
      this.bankUrl(bankId, "/reflect"),
      {
        method: "POST",
        body,
        signal: options.signal,
        maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES,
      },
    );
    return typeof response.text === "string" ? response.text : "";
  }

  /** Returns null when the bank or memory does not exist. */
  async getMemory(
    bankId: string,
    memoryId: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; text: string } | null> {
    try {
      const body = await this.request<{ id?: string; text?: unknown }>(
        "memory lookup",
        this.bankUrl(bankId, `/memories/${encodeURIComponent(memoryId)}`),
        { method: "GET", signal, maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES },
      );
      return typeof body.text === "string" ? { id: memoryId, text: body.text } : null;
    } catch (error) {
      // Any 404 here: "Bank '<id>' not found" and "Memory unit '<id>' not found" both mean absent.
      if (error instanceof HindsightHttpError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * GET a page route on `/pages/*`, falling back to the deprecated `/knowledge-base/*` route only
   * when the new route is missing (older servers). Remembered per client, so an older server
   * costs one extra request, not one per call.
   */
  private async pagesGet<T>(
    operation: string,
    bankId: string,
    paths: { current: string; legacy: string },
    signal?: AbortSignal,
  ): Promise<T> {
    const init = { method: "GET", signal, maxBodyBytes: KB_MAX_RESPONSE_BYTES };
    if (!this.legacyPagesRoutes) {
      try {
        return await this.request<T>(operation, this.bankUrl(bankId, paths.current), init);
      } catch (error) {
        if (!isRouteMissing(error)) {
          throw error;
        }
        this.legacyPagesRoutes = true;
      }
    }
    return this.request<T>(operation, this.bankUrl(bankId, paths.legacy), init);
  }

  async getKnowledgeBaseTree(
    bankId: string,
    signal?: AbortSignal,
  ): Promise<HindsightKnowledgeNode[]> {
    const response = await this.pagesGet<{ roots?: HindsightKnowledgeNode[] }>(
      "knowledge tree",
      bankId,
      { current: "/pages/tree", legacy: "/knowledge-base/tree" },
      signal,
    );
    return Array.isArray(response.roots) ? response.roots : [];
  }

  async searchKnowledgeBase(
    bankId: string,
    query: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<HindsightKnowledgeSearchHit[]> {
    const params = new URLSearchParams({ q: query });
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    const response = await this.pagesGet<{ results?: HindsightKnowledgeSearchHit[] }>(
      "knowledge search",
      bankId,
      {
        current: `/pages/search?${params.toString()}`,
        legacy: `/knowledge-base/search?${params.toString()}`,
      },
      options.signal,
    );
    return Array.isArray(response.results) ? response.results : [];
  }

  /**
   * Returns null when the bank or page does not exist. Hindsight scopes page ids to the bank in
   * the URL, so a page id from another bank is also null. A route 404 stays an error.
   */
  async getKnowledgePage(
    bankId: string,
    pageId: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; name: string; markdown: string } | null> {
    try {
      const id = encodeURIComponent(pageId);
      const body = await this.pagesGet<{ name?: unknown; markdown?: unknown }>(
        "knowledge page",
        bankId,
        { current: `/pages/${id}`, legacy: `/knowledge-base/pages/${id}` },
        signal,
      );
      if (typeof body.markdown !== "string") {
        throw new Error("Hindsight knowledge page failed: unexpected response");
      }
      return {
        id: pageId,
        name: typeof body.name === "string" ? body.name : "",
        markdown: body.markdown,
      };
    } catch (error) {
      if (error instanceof HindsightHttpError && (error.bankMissing || error.pageMissing)) {
        return null;
      }
      throw error;
    }
  }

  /** A memory unit with its curation state; null when the bank or the memory does not exist. */
  async getMemoryDetail(
    bankId: string,
    memoryId: string,
    signal?: AbortSignal,
  ): Promise<HindsightMemoryDetail | null> {
    try {
      const raw = await this.request<unknown>(
        "memory lookup",
        this.bankUrl(bankId, `/memories/${encodeURIComponent(memoryId)}`),
        {
          method: "GET",
          signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
          maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES,
        },
      );
      return toMemoryDetail(raw);
    } catch (error) {
      if (error instanceof HindsightHttpError && error.status === 404 && !error.routeMissing) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Curates a world or experience memory (PATCH): new text (re-embeds it and drops its derived
   * observations), or `state` "invalidated" (kept for audit, out of recall) or "valid" (revert).
   */
  async updateMemory(
    bankId: string,
    memoryId: string,
    patch: { text?: string; state?: "valid" | "invalidated"; reason?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.text !== undefined) {
      body.text = patch.text;
    }
    if (patch.state !== undefined) {
      body.state = patch.state;
    }
    if (patch.reason !== undefined) {
      body.reason = patch.reason;
    }
    await this.request(
      "curate memory",
      this.bankUrl(bankId, `/memories/${encodeURIComponent(memoryId)}`),
      {
        method: "PATCH",
        body,
        signal: signal ?? AbortSignal.timeout(DELETE_TIMEOUT_MS),
        maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES,
      },
    );
  }

  /** Deletes the observations derived from a memory and queues it for re-consolidation. */
  async clearMemoryObservations(
    bankId: string,
    memoryId: string,
    signal?: AbortSignal,
  ): Promise<{ deleted: number }> {
    const body = await this.request<{ deleted_count?: unknown }>(
      "clear observations",
      this.bankUrl(bankId, `/memories/${encodeURIComponent(memoryId)}/observations`),
      {
        method: "DELETE",
        signal: signal ?? AbortSignal.timeout(DELETE_TIMEOUT_MS),
        maxBodyBytes: KB_MAX_RESPONSE_BYTES,
      },
    );
    return { deleted: typeof body.deleted_count === "number" ? body.deleted_count : 0 };
  }

  /** Queues consolidation of the bank's unconsolidated memories; returns the operation id. */
  async consolidate(
    bankId: string,
    signal?: AbortSignal,
  ): Promise<{ operationId: string; deduplicated: boolean }> {
    const body = await this.request<{ operation_id?: unknown; deduplicated?: unknown }>(
      "consolidate",
      this.bankUrl(bankId, "/consolidate"),
      {
        method: "POST",
        body: {},
        signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
        maxBodyBytes: KB_MAX_RESPONSE_BYTES,
      },
    );
    if (typeof body.operation_id !== "string" || !body.operation_id) {
      throw new Error("Hindsight consolidate failed: no operation id in the response");
    }
    return { operationId: body.operation_id, deduplicated: body.deduplicated === true };
  }

  /** Status of one async operation of the bank. */
  async operationStatus(
    bankId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<HindsightOperationStatus> {
    const body = await this.request<Record<string, unknown>>(
      "operation status",
      this.bankUrl(bankId, `/operations/${encodeURIComponent(operationId)}`),
      {
        method: "GET",
        signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
        maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES,
      },
    );
    const out: HindsightOperationStatus = {
      id: operationId,
      status: typeof body.status === "string" ? body.status : "unknown",
    };
    if (typeof body.operation_type === "string") {
      out.type = body.operation_type;
    }
    if (typeof body.error_message === "string" && body.error_message) {
      out.error = body.error_message;
    }
    const progress = body.progress as Record<string, unknown> | null | undefined;
    if (progress && typeof progress === "object") {
      out.progress = {
        ...(typeof progress.stage === "string" ? { stage: progress.stage } : {}),
        ...(typeof progress.processed === "number" ? { processed: progress.processed } : {}),
        ...(typeof progress.total === "number" ? { total: progress.total } : {}),
        ...(progress.detail && typeof progress.detail === "object"
          ? {
              detail: Object.fromEntries(
                Object.entries(progress.detail).filter(
                  (e): e is [string, number] => typeof e[1] === "number",
                ),
              ),
            }
          : {}),
      };
    }
    return out;
  }

  /** The bank's directives, by server order; an empty list when the bank does not exist yet. */
  async listDirectives(
    bankId: string,
    options: { activeOnly?: boolean; signal?: AbortSignal } = {},
  ): Promise<HindsightDirective[]> {
    const out: HindsightDirective[] = [];
    for (let page = 0; page < MAX_DIRECTIVE_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(DIRECTIVE_PAGE),
        offset: String(page * DIRECTIVE_PAGE),
      });
      if (options.activeOnly) {
        params.set("active_only", "true");
      }
      let body: { items?: unknown };
      try {
        body = await this.request<{ items?: unknown }>(
          "directive list",
          this.bankUrl(bankId, `/directives?${params.toString()}`),
          {
            method: "GET",
            signal: options.signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
            maxBodyBytes: KB_MAX_RESPONSE_BYTES,
          },
        );
      } catch (error) {
        if (isBankNotFound(error)) {
          return out;
        }
        throw error;
      }
      const items = Array.isArray(body.items) ? body.items : [];
      for (const item of items) {
        const directive = toDirective(item);
        if (directive) {
          out.push(directive);
        }
      }
      if (items.length < DIRECTIVE_PAGE) {
        break;
      }
    }
    return out;
  }

  /** Creates a directive (Hindsight creates the bank when it does not exist). */
  async createDirective(
    bankId: string,
    input: { name: string; content: string; priority?: number; tags?: string[] },
    signal?: AbortSignal,
  ): Promise<HindsightDirective> {
    const body: Record<string, unknown> = { name: input.name, content: input.content };
    if (input.priority !== undefined) {
      body.priority = input.priority;
    }
    if (input.tags?.length) {
      body.tags = input.tags;
    }
    const raw = await this.request<unknown>(
      "create directive",
      this.bankUrl(bankId, "/directives"),
      {
        method: "POST",
        body,
        signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
        maxBodyBytes: KB_MAX_RESPONSE_BYTES,
      },
    );
    const directive = toDirective(raw);
    if (!directive) {
      throw new Error("Hindsight create directive failed: unexpected response");
    }
    return directive;
  }

  /** One directive; null when the bank or the directive does not exist. */
  async getDirective(
    bankId: string,
    directiveId: string,
    signal?: AbortSignal,
  ): Promise<HindsightDirective | null> {
    try {
      const raw = await this.request<unknown>(
        "directive lookup",
        this.bankUrl(bankId, `/directives/${encodeURIComponent(directiveId)}`),
        {
          method: "GET",
          signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
          maxBodyBytes: KB_MAX_RESPONSE_BYTES,
        },
      );
      return toDirective(raw);
    } catch (error) {
      if (error instanceof HindsightHttpError && error.status === 404 && !error.routeMissing) {
        return null;
      }
      throw error;
    }
  }

  /** Deletes a directive; false when it (or the bank) was already gone. */
  async deleteDirective(
    bankId: string,
    directiveId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.request(
        "delete directive",
        this.bankUrl(bankId, `/directives/${encodeURIComponent(directiveId)}`),
        {
          method: "DELETE",
          signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
          maxBodyBytes: KB_MAX_RESPONSE_BYTES,
        },
      );
      return true;
    } catch (error) {
      if (error instanceof HindsightHttpError && error.status === 404 && !error.routeMissing) {
        return false;
      }
      throw error;
    }
  }

  /** Creates the bank or updates its missions; idempotent on the server. */
  async applyBankDefaults(
    bankId: string,
    defaults: HindsightBankDefaults,
    signal?: AbortSignal,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (defaults.retainMission) {
      body.retain_mission = defaults.retainMission;
    }
    if (Object.keys(body).length === 0) {
      return;
    }
    await this.request("bank setup", this.bankUrl(bankId), { method: "PUT", body, signal });
  }

  /** Hindsight's `api_version` from GET /version, or undefined when it does not say. */
  async version(signal?: AbortSignal): Promise<string | undefined> {
    const { apiUrl } = this.options.resolveEndpoint();
    const body = await this.request<{ api_version?: unknown }>("version", `${apiUrl}/version`, {
      method: "GET",
      signal: signal ?? AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      maxBodyBytes: KB_MAX_RESPONSE_BYTES,
    });
    return typeof body.api_version === "string" ? body.api_version : undefined;
  }

  /** One page of the bank list; used to check that the token is accepted. */
  async listBanks(signal?: AbortSignal): Promise<void> {
    const { apiUrl } = this.options.resolveEndpoint();
    await this.request("bank list", `${apiUrl}/v1/default/banks?limit=1`, {
      method: "GET",
      signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      maxBodyBytes: KB_MAX_RESPONSE_BYTES,
    });
  }

  /** One page of a bank's documents; `q` is Hindsight's substring filter on id or text. */
  async listDocuments(
    bankId: string,
    options: { q?: string; limit: number; offset: number },
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; memoryUnits: number }>> {
    const params = new URLSearchParams({
      limit: String(options.limit),
      offset: String(options.offset),
    });
    if (options.q) {
      params.set("q", options.q);
    }
    const body = await this.request<{
      items?: Array<{ id?: unknown; memory_unit_count?: unknown }>;
    }>("document list", this.bankUrl(bankId, `/documents?${params.toString()}`), {
      method: "GET",
      signal: signal ?? AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES,
    });
    return (Array.isArray(body.items) ? body.items : [])
      .filter(
        (item): item is { id: string; memory_unit_count?: unknown } => typeof item?.id === "string",
      )
      .map((item) => ({
        id: item.id,
        memoryUnits: typeof item.memory_unit_count === "number" ? item.memory_unit_count : 0,
      }));
  }

  /** Deletes a document and the memory units extracted from it; null when it was already gone. */
  async deleteDocument(
    bankId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<{ memoryUnitsDeleted: number } | null> {
    try {
      const body = await this.request<{ memory_units_deleted?: unknown }>(
        "delete document",
        this.bankUrl(bankId, `/documents/${encodeURIComponent(documentId)}`),
        {
          method: "DELETE",
          signal: signal ?? AbortSignal.timeout(DELETE_TIMEOUT_MS),
          maxBodyBytes: KB_MAX_RESPONSE_BYTES,
        },
      );
      return {
        memoryUnitsDeleted:
          typeof body.memory_units_deleted === "number" ? body.memory_units_deleted : 0,
      };
    } catch (error) {
      if (error instanceof HindsightHttpError && error.status === 404 && !error.bankMissing) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Recall that also returns the raw source chunks of the matched facts, keyed by chunk id.
   * Used by the private transcript recall tool, which returns chunk text only.
   */
  async recallWithChunks(
    bankId: string,
    query: string,
    options: {
      budget: RecallBudget;
      maxTokens: number;
      chunkMaxTokens: number;
      types: RecallType[];
      signal?: AbortSignal;
    },
  ): Promise<{ results: HindsightRecallHit[]; chunks: Record<string, string> }> {
    const response = await this.request<{ results?: unknown; chunks?: unknown }>(
      "recall",
      this.bankUrl(bankId, "/memories/recall"),
      {
        method: "POST",
        body: {
          query,
          budget: options.budget,
          max_tokens: options.maxTokens,
          types: options.types,
          include: { entities: null, chunks: { max_tokens: options.chunkMaxTokens } },
        },
        signal: options.signal,
        maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES,
      },
    );
    const results = (Array.isArray(response.results) ? response.results : []).flatMap(
      (raw: unknown): HindsightRecallHit[] => {
        const r = raw as { document_id?: unknown; chunk_id?: unknown; type?: unknown } | null;
        return typeof r?.document_id === "string" && typeof r.chunk_id === "string"
          ? [
              {
                documentId: r.document_id,
                chunkId: r.chunk_id,
                ...(typeof r.type === "string" ? { type: r.type } : {}),
              },
            ]
          : [];
      },
    );
    const chunks: Record<string, string> = {};
    const rawChunks = response.chunks;
    if (rawChunks && typeof rawChunks === "object" && !Array.isArray(rawChunks)) {
      for (const [key, value] of Object.entries(rawChunks)) {
        const chunk = value as { id?: unknown; text?: unknown } | null;
        if (chunk?.id === key && typeof chunk.text === "string") {
          chunks[key] = chunk.text;
        }
      }
    }
    return { results, chunks };
  }

  /**
   * A document's id, metadata and stored text (`original_text`) as the server keeps them; null
   * when it does not exist.
   */
  async getDocument(
    bankId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; metadata: Record<string, string>; text?: string } | null> {
    let body: { id?: unknown; document_metadata?: unknown; original_text?: unknown };
    try {
      body = await this.request<typeof body>(
        "document get",
        this.bankUrl(bankId, `/documents/${encodeURIComponent(documentId)}`),
        { method: "GET", signal, maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES },
      );
    } catch (error) {
      if (error instanceof HindsightHttpError && error.status === 404 && !error.bankMissing) {
        return null;
      }
      throw error;
    }
    if (typeof body.id !== "string") {
      return null;
    }
    return {
      id: body.id,
      metadata: stringRecord(body.document_metadata),
      ...(typeof body.original_text === "string" ? { text: body.original_text } : {}),
    };
  }

  /** Documents whose id or text contains `q` (Hindsight's substring filter), with metadata. */
  async searchDocuments(
    bankId: string,
    q: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; metadata: Record<string, string> }>> {
    const params = new URLSearchParams({ q, limit: String(limit), offset: "0" });
    const body = await this.request<{ items?: unknown }>(
      "document search",
      this.bankUrl(bankId, `/documents?${params.toString()}`),
      { method: "GET", signal, maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES },
    );
    return (Array.isArray(body.items) ? body.items : []).flatMap((raw: unknown) => {
      const item = raw as { id?: unknown; document_metadata?: unknown } | null;
      return typeof item?.id === "string"
        ? [{ id: item.id, metadata: stringRecord(item.document_metadata) }]
        : [];
    });
  }

  /** The stored chunks of one document, in order. */
  async listDocumentChunks(
    bankId: string,
    documentId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<{ chunkId: string; documentId: string; text: string }>> {
    const body = await this.request<{ items?: unknown }>(
      "document chunks",
      this.bankUrl(bankId, `/documents/${encodeURIComponent(documentId)}/chunks?limit=${limit}`),
      { method: "GET", signal, maxBodyBytes: MEMORY_MAX_RESPONSE_BYTES },
    );
    return (Array.isArray(body.items) ? body.items : []).flatMap((raw: unknown) => {
      const c = raw as { chunk_id?: unknown; document_id?: unknown; chunk_text?: unknown } | null;
      return typeof c?.chunk_id === "string" &&
        typeof c.document_id === "string" &&
        typeof c.chunk_text === "string"
        ? [{ chunkId: c.chunk_id, documentId: c.document_id, text: c.chunk_text }]
        : [];
    });
  }

  async healthy(): Promise<boolean> {
    const { apiUrl } = this.options.resolveEndpoint();
    try {
      const response = await this.fetchImpl(`${apiUrl}/health`, {
        method: "GET",
        headers: this.headers(false),
        redirect: "error",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
