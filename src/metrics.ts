import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";

/**
 * Gateway-side metrics for auto-recall, auto-retain and the retain queue, rendered as Prometheus
 * text on a gateway-auth plugin route. diagnostics-prometheus renders only core diagnostic events
 * and has no plugin metric surface, so the plugin serves its own series on the gateway port.
 * Labels are agent and bank plus fixed enums; never session ids, document ids or text.
 */

export const METRICS_ROUTE_PATH = "/plugins/hindsight-native/metrics";
const PREFIX = "openclaw_hindsight_";
// Seconds. Recall times out at 10 s, retain at 30 s.
export const LATENCY_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;
// Label sets per family before new agent and bank values fold into "other"; agents and banks come
// from config. Outcome and reason keep their value, so the bound grows by the enum size at most.
export const MAX_SERIES_PER_FAMILY = 200;
const OTHER = "other";
const FOLDED_LABELS = new Set(["agent", "bank"]);

export type RecallOutcome = "injected" | "empty" | "error" | "timeout";
export type RetainOutcome = "sent" | "queued" | "error" | "timeout";
export type ReplayOutcome = "delivered" | "deferred";
export type DropReason = "limit" | "too_large" | "rejected";

/** Agent label: the normalized agent id, or "unknown" when it is missing or not label-safe. */
export function agentLabel(agentId: string | undefined): string {
  // The guard runs first: normalizing would turn a session-shaped value into a safe-looking id.
  // The strict form never falls back to the default agent, so an odd id reads unknown, not main.
  const safe = normalizeDiagnosticValue(agentId);
  if (safe === "unknown") {
    return safe;
  }
  const normalized = normalizeAgentIdStrict(safe);
  return normalized.ok ? normalized.value : "unknown";
}

/**
 * Bank label. A conversation bank (`<owner>::conv::<digest>`, one per root session) folds into
 * `<owner>::conv`, so the label set stays as small as the configured agents and bank map.
 */
export function bankLabel(bankId: string | undefined): string {
  if (!bankId) {
    return "unknown";
  }
  const conv = bankId.indexOf("::conv::");
  return normalizeDiagnosticValue(conv >= 0 ? `${bankId.slice(0, conv)}::conv` : bankId);
}

/** True for the error an `AbortSignal.timeout` fetch rejects with. */
export function isTimeoutError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

type Labels = Readonly<Record<string, string>>;

function labelKey(labels: Labels): string {
  return JSON.stringify(Object.entries(labels));
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: Labels, extra?: [string, string]): string {
  const pairs = Object.entries(labels);
  if (extra) {
    pairs.push(extra);
  }
  if (pairs.length === 0) {
    return "";
  }
  return `{${pairs.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`;
}

/** Bounded map of label set to state; past the bound every new set lands on the "other" set. */
class Series<T> {
  private readonly entries = new Map<string, { labels: Labels; value: T }>();

  constructor(private readonly create: () => T) {}

  get(labels: Labels): T {
    let key = labelKey(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_SERIES_PER_FAMILY) {
        labels = Object.fromEntries(
          Object.entries(labels).map(([k, v]) => [k, FOLDED_LABELS.has(k) ? OTHER : v]),
        );
        key = labelKey(labels);
        entry = this.entries.get(key);
      }
      if (!entry) {
        entry = { labels, value: this.create() };
        this.entries.set(key, entry);
      }
    }
    return entry.value;
  }

  values(): Array<{ labels: Labels; value: T }> {
    return [...this.entries.values()];
  }
}

type Histogram = { buckets: number[]; sum: number; count: number };

function newHistogram(): Histogram {
  return { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 };
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : value > 0 ? "+Inf" : "-Inf";
}

export type QueueDepthSource = () => ReadonlyMap<string, number> | undefined;

export class HindsightMetrics {
  private readonly recalls = new Series(() => ({ n: 0 }));
  private readonly recallLatency = new Series(newHistogram);
  private readonly retains = new Series(() => ({ n: 0 }));
  private readonly retainLatency = new Series(newHistogram);
  private readonly replays = new Series(() => ({ n: 0 }));
  private readonly drops = new Series(() => ({ n: 0 }));
  // Kept across scrapes, so a bank whose queue drained reads 0 instead of disappearing.
  private readonly depth = new Series(() => ({ n: 0 }));

  recordRecall(agentId: string | undefined, bankId: string, outcome: RecallOutcome, ms: number) {
    const base = { agent: agentLabel(agentId), bank: bankLabel(bankId) };
    this.recalls.get({ ...base, outcome }).n += 1;
    observe(this.recallLatency.get(base), ms);
  }

  recordRetain(agentId: string | undefined, bankId: string, outcome: RetainOutcome, ms: number) {
    const base = { agent: agentLabel(agentId), bank: bankLabel(bankId) };
    this.retains.get({ ...base, outcome }).n += 1;
    observe(this.retainLatency.get(base), ms);
  }

  recordReplay(bankId: string, outcome: ReplayOutcome) {
    this.replays.get({ bank: bankLabel(bankId), outcome }).n += 1;
  }

  recordDrop(bankId: string, reason: DropReason, count = 1) {
    if (count > 0) {
      this.drops.get({ bank: bankLabel(bankId), reason }).n += count;
    }
  }

  /** Prometheus text exposition (version 0.0.4). Families with no samples print only HELP/TYPE. */
  render(queueDepth?: QueueDepthSource): string {
    const lines: string[] = [];
    const counter = (name: string, help: string, series: Series<{ n: number }>) => {
      lines.push(`# HELP ${PREFIX}${name} ${help}`, `# TYPE ${PREFIX}${name} counter`);
      for (const { labels, value } of series.values()) {
        lines.push(`${PREFIX}${name}${formatLabels(labels)} ${value.n}`);
      }
    };
    const histogram = (name: string, help: string, series: Series<Histogram>) => {
      lines.push(`# HELP ${PREFIX}${name} ${help}`, `# TYPE ${PREFIX}${name} histogram`);
      for (const { labels, value } of series.values()) {
        LATENCY_BUCKETS.forEach((le, i) => {
          lines.push(
            `${PREFIX}${name}_bucket${formatLabels(labels, ["le", String(le)])} ${value.buckets[i]}`,
          );
        });
        lines.push(
          `${PREFIX}${name}_bucket${formatLabels(labels, ["le", "+Inf"])} ${value.count}`,
          `${PREFIX}${name}_sum${formatLabels(labels)} ${formatNumber(value.sum)}`,
          `${PREFIX}${name}_count${formatLabels(labels)} ${value.count}`,
        );
      }
    };
    counter("recall_total", "Auto-recall attempts by outcome.", this.recalls);
    histogram("recall_duration_seconds", "Auto-recall latency.", this.recallLatency);
    counter("retain_total", "Auto-retain attempts by outcome.", this.retains);
    histogram("retain_duration_seconds", "Auto-retain latency.", this.retainLatency);
    lines.push(
      `# HELP ${PREFIX}retain_queue_depth Retains waiting in the offline queue.`,
      `# TYPE ${PREFIX}retain_queue_depth gauge`,
    );
    for (const { value } of this.depth.values()) {
      value.n = 0;
    }
    for (const [bankId, n] of queueDepth?.() ?? []) {
      this.depth.get({ bank: bankLabel(bankId) }).n += n;
    }
    for (const { labels, value } of this.depth.values()) {
      lines.push(`${PREFIX}retain_queue_depth${formatLabels(labels)} ${value.n}`);
    }
    counter(
      "retain_queue_replays_total",
      "Queued retain replay attempts by outcome.",
      this.replays,
    );
    counter("retain_queue_drops_total", "Retains dropped from the queue by reason.", this.drops);
    return `${lines.join("\n")}\n`;
  }
}

function observe(h: Histogram, ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  LATENCY_BUCKETS.forEach((le, i) => {
    if (seconds <= le) {
      h.buckets[i]! += 1;
    }
  });
  h.sum += seconds;
  h.count += 1;
}

// Mirrors diagnostics-prometheus: the route is gateway-auth, and read access is checked here so a
// scope-narrowed operator identity cannot read it.
const READ_SCOPES = ["operator.read", "operator.write", "operator.admin"] as const;

function hasReadScope(): boolean {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes;
  return Array.isArray(scopes) && READ_SCOPES.some((scope) => scopes.includes(scope));
}

export function createMetricsRouteHandler(
  metrics: HindsightMetrics,
  queueDepth: QueueDepthSource,
  readScope: () => boolean = hasReadScope,
) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    res.setHeader("Cache-Control", "no-store");
    if (!readScope()) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("missing scope: operator.read");
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end("Method Not Allowed");
      return true;
    }
    const body = metrics.render(queueDepth);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.setHeader("Content-Length", String(Buffer.byteLength(body, "utf8")));
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  };
}
