import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryPluginCapability } from "./sdk-types.js";

/**
 * Memory backends (openclaw#201340, #202838; hosts 2026.11.7 and later).
 *
 * Two roles:
 * - Backend: another plugin (memfusion) owns `plugins.slots.memory` and the host loads this one
 *   with `registrationMode "memory-backend"`. Only the provider runtime registers.
 * - Fusion owner: this plugin owns the slot and the host passes `params.backends` to its
 *   `providerRuntime.open()`. The handle fuses Hindsight with every backend that opens.
 *
 * The floor SDK (2026.10.10) has none of these types, so they are structural copies here, as for
 * the `/learn` contribution in sdk-types.ts. Older hosts never pass `backends`.
 */

type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
export type MemoryProviderOpenParams = Parameters<MemoryProviderRuntime["open"]>[0];
type BaseHandle = NonNullable<Awaited<ReturnType<MemoryProviderRuntime["open"]>>["provider"]>;
export type MemorySearchRequest = Parameters<BaseHandle["search"]>[0];
export type MemorySearchPage = Awaited<ReturnType<BaseHandle["search"]>>;
export type MemorySearchHit = MemorySearchPage["hits"][number];
export type MemoryGetRequest = Parameters<BaseHandle["get"]>[0];
export type MemoryGetResult = Awaited<ReturnType<BaseHandle["get"]>>;
export type MemoryHealth = Awaited<ReturnType<BaseHandle["health"]>>;
export type MemoryReference = MemorySearchHit["reference"];
type MemoryCitation = NonNullable<MemorySearchHit["citations"]>[number];

export type MemoryStoreRequest = {
  text: string;
  title?: string;
  tags?: readonly string[];
  origin?: "tool" | "flush" | "capture";
};
export type MemoryStoreResult =
  | { status: "stored"; reference: MemoryReference }
  | { status: "rejected"; reason: string };

/** The provider handle with the optional `store` of hosts with memory backends. */
export type MemoryProviderHandle = Omit<BaseHandle, "capabilities"> & {
  capabilities: BaseHandle["capabilities"] & { store?: boolean };
  store?(request: MemoryStoreRequest): Promise<MemoryStoreResult>;
};

type OpenedBackend = {
  provider: MemoryProviderHandle | null;
  error?: string;
  providerId?: string;
  adapter?: "native" | "legacy";
};

/** `params.backends` on the slot owner's open(), present only when a backend loaded. */
export type MemoryBackendAccess = {
  list(): { id: string; name?: string }[];
  open(backendId: string): Promise<OpenedBackend>;
};

/** The open params as a host with memory backends passes them. */
export type BackendAwareOpenParams = MemoryProviderOpenParams & { backends?: MemoryBackendAccess };

/** The registration mode the host uses for a passive backend. Older hosts never set it. */
export const MEMORY_BACKEND_MODE = "memory-backend";

export function isMemoryBackendRegistration(api: { registrationMode?: unknown }): boolean {
  return api.registrationMode === MEMORY_BACKEND_MODE;
}

export const RRF_K = 60;
export const BACKEND_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Plugin ids the host config opts in as memory backends: enabled entries with
 * `memoryBackend: true`, other than this plugin. Older hosts reject the key, so on them the list
 * is always empty.
 */
export function configuredBackendIds(hostConfig: unknown, selfId: string): string[] {
  const entries = record(record(record(hostConfig)?.plugins)?.entries) ?? {};
  const self = selfId.toLowerCase();
  return Object.entries(entries)
    .filter(([id, entry]) => {
      const value = record(entry);
      return id.toLowerCase() !== self && value?.memoryBackend === true && value.enabled !== false;
    })
    .map(([id]) => id);
}

/**
 * A backend reference wrapped in the owner's provider id. Hindsight's own ids are UUIDs or
 * `doc:` ids, so an id that parses as a two-string JSON array is always a wrapped one.
 */
export function wrapReference(ownerId: string, inner: MemoryReference): MemoryReference {
  return {
    providerId: ownerId,
    id: JSON.stringify([inner.providerId, inner.id]),
    ...(inner.revision !== undefined ? { revision: inner.revision } : {}),
    ...(inner.fragment !== undefined ? { fragment: inner.fragment } : {}),
  };
}

/** Reverses wrapReference; null for a reference this owner did not wrap. */
export function unwrapReference(ownerId: string, outer: MemoryReference): MemoryReference | null {
  if (outer.providerId !== ownerId || !outer.id.startsWith("[")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outer.id);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !parsed[0] ||
    parsed[0] === ownerId
  ) {
    return null;
  }
  return {
    providerId: parsed[0],
    id: parsed[1],
    ...(outer.revision !== undefined ? { revision: outer.revision } : {}),
    ...(outer.fragment !== undefined ? { fragment: outer.fragment } : {}),
  };
}

function wrapCitations(ownerId: string, citations: MemoryCitation[] | undefined) {
  return citations?.map((citation) =>
    citation.reference
      ? { ...citation, reference: wrapReference(ownerId, citation.reference) }
      : { ...citation },
  );
}

function wrapHit(ownerId: string, hit: MemorySearchHit): MemorySearchHit {
  const citations = wrapCitations(ownerId, hit.citations);
  return {
    ...hit,
    reference: wrapReference(ownerId, hit.reference),
    ...(citations ? { citations } : {}),
  };
}

type RankedList = { id: string; hits: readonly MemorySearchHit[] };

function excerptKey(excerpt: string): string {
  return excerpt.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Reciprocal rank fusion: each list's own order counts, raw scores are never compared across
 * stores. Identical excerpts merge into one hit (the best-ranked copy) with summed weight.
 */
export function fuseRanked(lists: readonly RankedList[], k = RRF_K): MemorySearchHit[] {
  const merged = new Map<
    string,
    { hit: MemorySearchHit; score: number; best: number; order: number }
  >();
  let order = 0;
  for (const list of lists) {
    list.hits.forEach((hit, index) => {
      const contribution = 1 / (k + index + 1);
      const key = excerptKey(hit.excerpt) || `\u0000${order}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { hit, score: contribution, best: contribution, order: order++ });
        return;
      }
      existing.score += contribution;
      if (contribution > existing.best) {
        existing.hit = hit;
        existing.best = contribution;
      }
    });
  }
  return [...merged.values()]
    .toSorted((a, b) => b.score - a.score || a.order - b.order)
    .map(({ hit }) => hit);
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Backend = { id: string; providerId: string; handle: MemoryProviderHandle };
type Failure = { id: string; error: string };

/** Opens every backend the host lists; failures are reported, never thrown. */
export async function openBackends(
  access: MemoryBackendAccess,
): Promise<{ backends: Backend[]; failures: Failure[] }> {
  const listed = access.list();
  const settled = await Promise.allSettled(listed.map(({ id }) => access.open(id)));
  const backends: Backend[] = [];
  const failures: Failure[] = [];
  settled.forEach((outcome, index) => {
    const id = listed[index]!.id;
    if (outcome.status === "rejected") {
      failures.push({ id, error: formatErrorMessage(outcome.reason) });
    } else if (!outcome.value.provider) {
      failures.push({ id, error: outcome.value.error ?? "no provider" });
    } else {
      backends.push({
        id,
        providerId: outcome.value.providerId ?? id,
        handle: outcome.value.provider,
      });
    }
  });
  return { backends, failures };
}

function describeFailures(failures: readonly Failure[]): string | undefined {
  return failures.length > 0
    ? `memory backends unavailable: ${failures.map((f) => `${f.id} (${f.error})`).join("; ")}`
    : undefined;
}

/**
 * The slot owner's handle with backends: Hindsight (the plugin's own handle) plus every backend,
 * merged by rank. Hindsight's references are unchanged; backend references are wrapped.
 */
export function createFusedHandle(params: {
  ownerId: string;
  own: MemoryProviderHandle;
  backends: Backend[];
  openFailures?: Failure[];
  timeoutMs?: number;
}): MemoryProviderHandle {
  const { ownerId, own, backends } = params;
  const openFailures = params.openFailures ?? [];
  const timeoutMs = params.timeoutMs ?? BACKEND_TIMEOUT_MS;
  const byProvider = new Map(backends.map((backend) => [backend.providerId, backend]));
  const sources = new Set(own.capabilities.sources);
  for (const { handle } of backends) {
    handle.capabilities.sources.forEach((source) => sources.add(source));
  }
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("memory-hindsight: the memory lease is closed");
    }
  };
  const { store: _ownStore, ...ownCapabilities } = own.capabilities;
  return {
    capabilities: {
      ...ownCapabilities,
      sources: [...sources],
      pagination: false,
      candidates: [],
      projectFilter: false,
    },
    async search(request) {
      assertOpen();
      const wanted = request.sources;
      const covers = (handle: MemoryProviderHandle) =>
        !wanted || wanted.some((source) => handle.capabilities.sources.includes(source));
      const forward = (handle: MemoryProviderHandle): MemorySearchRequest => {
        const { cursor: _cursor, ...rest } = request;
        return wanted
          ? { ...rest, sources: wanted.filter((s) => handle.capabilities.sources.includes(s)) }
          : rest;
      };
      const targets: { id: string; wrap: boolean; handle: MemoryProviderHandle }[] = [
        ...(covers(own) ? [{ id: ownerId, wrap: false, handle: own }] : []),
        ...backends.filter(({ handle }) => covers(handle)).map((b) => ({ ...b, wrap: true })),
      ];
      const settled = await Promise.allSettled(
        targets.map(({ id, handle }) =>
          withDeadline(handle.search(forward(handle)), timeoutMs, `${id} search`),
        ),
      );
      const failures = [...openFailures];
      const warnings: string[] = [];
      const lists: RankedList[] = [];
      let partial = openFailures.length > 0;
      settled.forEach((outcome, index) => {
        const target = targets[index]!;
        if (outcome.status === "rejected") {
          failures.push({ id: target.id, error: formatErrorMessage(outcome.reason) });
          partial = true;
          return;
        }
        const page = outcome.value;
        if (page.coverage === "partial") {
          partial = true;
        }
        if (page.warning) {
          warnings.push(`${target.id}: ${page.warning}`);
        }
        lists.push({
          id: target.id,
          hits: target.wrap ? page.hits.map((hit) => wrapHit(ownerId, hit)) : page.hits,
        });
      });
      const fused = fuseRanked(lists);
      const max = request.maxResults;
      const hits = max !== undefined && max > 0 ? fused.slice(0, Math.floor(max)) : fused;
      const warning = [describeFailures(failures), ...warnings].filter(Boolean).join(" ");
      return {
        hits,
        coverage: partial ? "partial" : "complete",
        ...(warning ? { warning } : {}),
      };
    },
    async get(request) {
      assertOpen();
      const inner = unwrapReference(ownerId, request.reference);
      if (!inner) {
        return await own.get(request);
      }
      const backend = byProvider.get(inner.providerId);
      if (!backend) {
        return { status: "not_found" };
      }
      const result = await withDeadline(
        backend.handle.get({ ...request, reference: inner }),
        timeoutMs,
        `${backend.id} get`,
      );
      if (result.status !== "ok") {
        return result;
      }
      const citations = wrapCitations(ownerId, result.citations);
      return {
        ...result,
        reference: wrapReference(ownerId, result.reference),
        ...(citations ? { citations } : {}),
      };
    },
    async health(): Promise<MemoryHealth> {
      const ownHealth = await own.health();
      const settled = await Promise.allSettled(
        backends.map(({ id, handle }) => withDeadline(handle.health(), timeoutMs, `${id} health`)),
      );
      const statuses: Record<string, string> = {};
      openFailures.forEach(({ id }) => (statuses[id] = "unavailable"));
      settled.forEach((outcome, index) => {
        statuses[backends[index]!.id] =
          outcome.status === "fulfilled" ? outcome.value.status : "unavailable";
      });
      const notReady = Object.entries(statuses).filter(([, status]) => status !== "ready");
      const details = { ...ownHealth.details, backends: statuses };
      if (ownHealth.status !== "ready" || notReady.length === 0) {
        return { ...ownHealth, details };
      }
      return {
        status: "degraded",
        message: `Hindsight answers, but ${notReady.length === 1 ? "memory backend" : "memory backends"} ${notReady.map(([id]) => id).join(", ")} ${notReady.length === 1 ? "is" : "are"} not ready.`,
        details,
      };
    },
    async refresh() {
      assertOpen();
      await Promise.allSettled(backends.map(({ handle }) => handle.refresh?.()));
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await Promise.allSettled([own.close(), ...backends.map(({ handle }) => handle.close())]);
    },
  };
}
