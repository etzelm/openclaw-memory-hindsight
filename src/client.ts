import type { RecallBudget, RecallType } from "./config.js";

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
  ) {
    super(message);
    this.name = "HindsightHttpError";
  }
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

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HindsightClientOptions = {
  /** Read per request so a token rotated by `openclaw secrets reload` applies without restart. */
  resolveEndpoint(): { apiUrl: string; apiToken?: string };
  fetch?: FetchLike;
  userAgent?: string;
};

const HEALTH_TIMEOUT_MS = 5_000;

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
    init: { method: string; body?: unknown; signal?: AbortSignal },
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
      const body = response.status === 404 ? await response.text().catch(() => "") : "";
      const bankMissing = response.status === 404 && isBankMissingBody(body);
      const bankMissingExplicit = response.status === 404 && isExplicitBankMissingBody(body);
      // Server error bodies can echo request content; keep only the status in the message.
      throw new HindsightHttpError(
        `Hindsight ${operation} failed: HTTP ${response.status}`,
        response.status,
        bankMissing,
        bankMissingExplicit,
      );
    }
    const text = await response.text();
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
    const response = await this.request<{ results?: HindsightRecallResult[] }>(
      "recall",
      this.bankUrl(bankId, "/memories/recall"),
      { method: "POST", body, signal: options.signal },
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
      { method: "POST", body: { query, budget: options.budget }, signal: options.signal },
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
        { method: "GET", signal },
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
