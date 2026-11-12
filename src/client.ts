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
    /** True only for Hindsight's "Knowledge page '<id>' not found" 404. */
    readonly pageMissing = false,
  ) {
    super(message);
    this.name = "HindsightHttpError";
  }

  /** From a 429 or 503 `Retry-After` header: how long the server asked us to wait. */
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

/** Only Hindsight's `Knowledge page '<id>' not found` detail; a route "Not Found" does not count. */
export function isExplicitPageMissingBody(text: string): boolean {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown } | null)?.detail;
    return typeof detail === "string" && /\bknowledge page\b.*\bnot found\b/i.test(detail);
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

/** Minimal fetch client for the Hindsight v1 HTTP API. No SDK dependency. */
export class HindsightClient {
  private readonly fetchImpl: FetchLike;

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
      // Server error bodies can echo request content; keep only the status in the message.
      const error = new HindsightHttpError(
        `Hindsight ${operation} failed: HTTP ${response.status}`,
        response.status,
        bankMissing,
        bankMissingExplicit,
        pageMissing,
      );
      if (response.status === 429 || response.status === 503) {
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
    options: { budget: RecallBudget; signal?: AbortSignal },
  ): Promise<string> {
    const response = await this.request<{ text?: string }>(
      "reflect",
      this.bankUrl(bankId, "/reflect"),
      {
        method: "POST",
        body: { query, budget: options.budget },
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

  async getKnowledgeBaseTree(
    bankId: string,
    signal?: AbortSignal,
  ): Promise<HindsightKnowledgeNode[]> {
    const response = await this.request<{ roots?: HindsightKnowledgeNode[] }>(
      "knowledge tree",
      this.bankUrl(bankId, "/knowledge-base/tree"),
      { method: "GET", signal, maxBodyBytes: KB_MAX_RESPONSE_BYTES },
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
    const response = await this.request<{ results?: HindsightKnowledgeSearchHit[] }>(
      "knowledge search",
      this.bankUrl(bankId, `/knowledge-base/search?${params.toString()}`),
      { method: "GET", signal: options.signal, maxBodyBytes: KB_MAX_RESPONSE_BYTES },
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
      const body = await this.request<{ name?: unknown; markdown?: unknown }>(
        "knowledge page",
        this.bankUrl(bankId, `/knowledge-base/pages/${encodeURIComponent(pageId)}`),
        { method: "GET", signal, maxBodyBytes: KB_MAX_RESPONSE_BYTES },
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
