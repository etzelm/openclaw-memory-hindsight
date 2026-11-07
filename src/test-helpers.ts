import { vi } from "vitest";
import { type HindsightConfig, hindsightConfigSchema } from "./config.js";
import { createHindsightService } from "./service.js";

type LogFn = (message: string) => void;

export type RecordedRequest = { method: string; url: string; body: unknown; auth?: string };

/** A fake Hindsight API: records requests and answers from a route table. */
export function createFakeHindsight(
  routes: Record<string, (body: unknown) => { status?: number; json?: unknown }> = {},
) {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ method, url, body, auth: headers.Authorization });
      const path = new URL(url).pathname;
      const handler = routes[`${method} ${path}`];
      const answer = handler ? handler(body) : { status: 404 };
      return new Response(answer.json === undefined ? "" : JSON.stringify(answer.json), {
        status: answer.status ?? 200,
      });
    },
  );
  return { fetch, requests };
}

/** A fetch that never answers; it rejects only when the request signal aborts. */
export function createHangingFetch() {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
}

/** Records every AbortSignal.timeout(ms) request and shortens the real timer to 20 ms. */
export function spyOnTimeouts() {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const requested: number[] = [];
  const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    requested.push(ms);
    return original(20);
  });
  return { requested, restore: () => spy.mockRestore() };
}

export function createTestService(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  overrides: Record<string, unknown> = {},
) {
  const config: HindsightConfig = hindsightConfigSchema.parse({
    hindsightApiUrl: "http://hindsight.test",
    hindsightApiToken: "test-token",
    ...overrides,
  });
  const service = createHindsightService({
    config: () => config,
    logger: { warn: vi.fn<LogFn>(), info: vi.fn<LogFn>(), debug: vi.fn<LogFn>() },
    fetch,
  });
  return { service };
}
