import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";

/**
 * Gateway-side metrics for auto-recall, auto-retain and the retain queue. On a host that grants
 * `api.metrics` (plugins.entries.hindsight-native.allowMetrics), the families go out on the
 * Gateway's Prometheus scrape as `openclaw_plugin_hindsight_native_*`. Otherwise they are rendered
 * as Prometheus text on a gateway-auth plugin route. Never both, so nothing is counted twice.
 * Labels are agent and bank plus fixed enums; never session ids, document ids or text.
 */

export const METRICS_ROUTE_PATH = "/plugins/hindsight-native/metrics";
const PREFIX = "openclaw_hindsight_";
// Seconds. Recall times out at 10 s, retain at 30 s.
export const LATENCY_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;
// Memories and characters in one injected <hindsight_memories> block.
export const INJECTED_COUNT_BUCKETS = [1, 2, 3, 5, 8, 10, 15, 20, 30, 50] as const;
export const INJECTED_CHARS_BUCKETS = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000] as const;
// Label sets per family before new agent and bank values fold into "other"; agents and banks come
// from config. Outcome and reason keep their value, so the bound grows by the enum size at most.
export const MAX_SERIES_PER_FAMILY = 200;
// With api.metrics the host keeps at most 128 label sets per family and drops the rest; folding
// below that keeps new agents and banks visible as "other" instead of dropped.
export const SINK_MAX_SERIES_PER_FAMILY = 120;
// How often the pushed queue depth gauge is refreshed with api.metrics (the route reads it per scrape).
export const QUEUE_DEPTH_PUBLISH_MS = 15_000;
const OTHER = "other";
const FOLDED_LABELS = new Set(["agent", "bank"]);

export const RECALL_OUTCOMES = ["injected", "empty", "error", "timeout"] as const;
export type RecallOutcome = (typeof RECALL_OUTCOMES)[number];
export const RETAIN_OUTCOMES = ["sent", "queued", "error", "timeout"] as const;
export type RetainOutcome = (typeof RETAIN_OUTCOMES)[number];
export const REPLAY_OUTCOMES = ["delivered", "deferred"] as const;
export type ReplayOutcome = (typeof REPLAY_OUTCOMES)[number];
export const DROP_REASONS = ["limit", "too_large", "rejected"] as const;
export type DropReason = (typeof DROP_REASONS)[number];
/**
 * Why an eligible auto-recall turn sent no Hindsight request: a session filter (excluded provider,
 * operational session, ignore pattern, incognito), no memory audience, no usable query, the
 * follow-up rule, a cache hit (memories injected from the cache) or the circuit breaker.
 */
export const RECALL_SKIP_REASONS = [
  "filter",
  "no_audience",
  "empty_query",
  "followup",
  "cache_hit",
  "breaker_open",
] as const;
export type RecallSkipReason = (typeof RECALL_SKIP_REASONS)[number];

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

/**
 * The recorder shape `api.metrics.register()` returns (openclaw#198455). Declared here because the
 * peer floor (2026.10.10) has no `metrics` on the plugin API type.
 */
export type MetricsSink = {
  counter: (name: string) => { inc: (labels?: Labels, amount?: number) => void };
  gauge: (name: string) => { set: (labels: Labels, value: number) => void };
  histogram: (name: string) => { observe: (labels: Labels, value: number) => void };
};

export type MetricFamilyDeclaration =
  | { name: string; type: "counter" | "gauge"; help: string; labels: readonly string[] }
  | {
      name: string;
      type: "histogram";
      help: string;
      labels: readonly string[];
      buckets: readonly number[];
    };

/** Families as declared to api.metrics; the host adds the `openclaw_plugin_hindsight_native_` prefix. */
export const METRIC_FAMILIES: readonly MetricFamilyDeclaration[] = [
  {
    name: "recall_total",
    type: "counter",
    help: "Auto-recall attempts by outcome.",
    labels: ["agent", "bank", "outcome"],
  },
  {
    name: "recall_duration_seconds",
    type: "histogram",
    help: "Auto-recall latency.",
    labels: ["agent", "bank"],
    buckets: LATENCY_BUCKETS,
  },
  {
    name: "recall_skipped_total",
    type: "counter",
    help: "Eligible auto-recall turns that sent no Hindsight request, by reason.",
    labels: ["agent", "reason"],
  },
  {
    name: "recall_injected_memories",
    type: "histogram",
    help: "Memories in each injected auto-recall block.",
    labels: ["agent", "bank"],
    buckets: INJECTED_COUNT_BUCKETS,
  },
  {
    name: "recall_injected_chars",
    type: "histogram",
    help: "Characters in each injected auto-recall block.",
    labels: ["agent", "bank"],
    buckets: INJECTED_CHARS_BUCKETS,
  },
  {
    name: "retain_total",
    type: "counter",
    help: "Auto-retain attempts by outcome.",
    labels: ["agent", "bank", "outcome"],
  },
  {
    name: "retain_duration_seconds",
    type: "histogram",
    help: "Auto-retain latency.",
    labels: ["agent", "bank"],
    buckets: LATENCY_BUCKETS,
  },
  {
    name: "retain_queue_depth",
    type: "gauge",
    help: "Retains waiting in the offline queue.",
    labels: ["bank"],
  },
  {
    name: "retain_queue_replays_total",
    type: "counter",
    help: "Queued retain replay attempts by outcome.",
    labels: ["bank", "outcome"],
  },
  {
    name: "retain_queue_drops_total",
    type: "counter",
    help: "Retains dropped from the queue by reason.",
    labels: ["bank", "reason"],
  },
  {
    name: "metrics_series_folded_total",
    type: "counter",
    help: "Samples recorded with agent or bank other because their family reached its label-set bound.",
    labels: ["family"],
  },
];

const FOLDED_HELP = METRIC_FAMILIES.find((f) => f.name === "metrics_series_folded_total")!.help;

/**
 * The zero series every counter family gets at start: the owner agent and bank with each outcome
 * or reason, so a rate or increase has a 0 baseline before the first event.
 */
type CounterSeeds = Readonly<
  Record<
    | "recall_total"
    | "recall_skipped_total"
    | "retain_total"
    | "retain_queue_replays_total"
    | "retain_queue_drops_total"
    | "metrics_series_folded_total",
    (agent: string, bank: string) => readonly Labels[]
  >
>;
export const COUNTER_SEEDS: CounterSeeds = {
  recall_total: (agent, bank) => RECALL_OUTCOMES.map((outcome) => ({ agent, bank, outcome })),
  recall_skipped_total: (agent) => RECALL_SKIP_REASONS.map((reason) => ({ agent, reason })),
  retain_total: (agent, bank) => RETAIN_OUTCOMES.map((outcome) => ({ agent, bank, outcome })),
  retain_queue_replays_total: (_agent, bank) =>
    REPLAY_OUTCOMES.map((outcome) => ({ bank, outcome })),
  retain_queue_drops_total: (_agent, bank) => DROP_REASONS.map((reason) => ({ bank, reason })),
  metrics_series_folded_total: () => METRIC_FAMILIES.map((f) => ({ family: f.name })),
};

type MetricsLogger = { warn: (message: string) => void };

/**
 * Registers the families through `api.metrics` when the host grants it. Undefined when the host has
 * no `api.metrics` (older host, or allowMetrics off) or `register()` throws; the caller then serves
 * the route instead.
 */
export function openMetricsSink(
  metricsApi: unknown,
  logger: MetricsLogger,
): MetricsSink | undefined {
  const register = (metricsApi as { register?: unknown } | undefined)?.register;
  if (typeof register !== "function") {
    return undefined;
  }
  try {
    return register.call(metricsApi, { families: METRIC_FAMILIES }) as MetricsSink;
  } catch (error) {
    logger.warn(
      `memory-hindsight: api.metrics register failed (${error instanceof Error ? error.message : String(error)}); serving the metrics route instead`,
    );
    return undefined;
  }
}

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

/**
 * Bounded map of label set to state; past the bound every new set lands on the "other" set and
 * `onFold` runs once per folded sample, so a fold is never silent.
 */
class Series<T> {
  private readonly entries = new Map<string, { labels: Labels; value: T }>();

  constructor(
    private readonly create: () => T,
    private readonly max: number,
    private readonly onFold?: () => void,
  ) {}

  get(labels: Labels): T {
    return this.entry(labels).value;
  }

  /** The entry for a label set, with the labels it was stored under (folded past the bound). */
  entry(labels: Labels): { labels: Labels; value: T } {
    let key = labelKey(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.max) {
        this.onFold?.();
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
    return entry;
  }

  values(): Array<{ labels: Labels; value: T }> {
    return [...this.entries.values()];
  }
}

type Histogram = { bounds: readonly number[]; buckets: number[]; sum: number; count: number };

function histogramOf(bounds: readonly number[]): () => Histogram {
  return () => ({ bounds, buckets: bounds.map(() => 0), sum: 0, count: 0 });
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : value > 0 ? "+Inf" : "-Inf";
}

export type QueueDepthSource = () => ReadonlyMap<string, number> | undefined;

export type HindsightMetricsOptions = {
  /** Recorders from api.metrics. When set, every record is also pushed there, folded at 120. */
  sink?: MetricsSink;
  logger?: MetricsLogger;
};

export class HindsightMetrics {
  private readonly sink: MetricsSink | undefined;
  private readonly logger: MetricsLogger | undefined;
  private sinkFailed = false;
  private readonly max: number;
  private readonly foldWarned = new Set<string>();
  private queueDepthSource: QueueDepthSource | undefined;
  private readonly recalls: Series<{ n: number }>;
  private readonly recallLatency: Series<Histogram>;
  private readonly skips: Series<{ n: number }>;
  private readonly injectedCount: Series<Histogram>;
  private readonly injectedChars: Series<Histogram>;
  private readonly retains: Series<{ n: number }>;
  private readonly retainLatency: Series<Histogram>;
  private readonly replays: Series<{ n: number }>;
  private readonly drops: Series<{ n: number }>;
  // Kept across scrapes, so a bank whose queue drained reads 0 instead of disappearing.
  private readonly depth: Series<{ n: number }>;
  // One label per family name, so it never folds itself.
  private readonly folded = new Series(() => ({ n: 0 }), Number.POSITIVE_INFINITY);

  constructor(options: HindsightMetricsOptions = {}) {
    this.sink = options.sink;
    this.logger = options.logger;
    const max = this.sink ? SINK_MAX_SERIES_PER_FAMILY : MAX_SERIES_PER_FAMILY;
    this.max = max;
    const count = (family: string) =>
      new Series(
        () => ({ n: 0 }),
        max,
        () => this.onFold(family),
      );
    const hist = (family: string, bounds: readonly number[]) =>
      new Series(histogramOf(bounds), max, () => this.onFold(family));
    this.recalls = count("recall_total");
    this.recallLatency = hist("recall_duration_seconds", LATENCY_BUCKETS);
    this.skips = count("recall_skipped_total");
    this.injectedCount = hist("recall_injected_memories", INJECTED_COUNT_BUCKETS);
    this.injectedChars = hist("recall_injected_chars", INJECTED_CHARS_BUCKETS);
    this.retains = count("retain_total");
    this.retainLatency = hist("retain_duration_seconds", LATENCY_BUCKETS);
    this.replays = count("retain_queue_replays_total");
    this.drops = count("retain_queue_drops_total");
    this.depth = count("retain_queue_depth");
  }

  /** A sample folded into "other": warned once per family and counted, never silent. */
  private onFold(family: string) {
    if (!this.foldWarned.has(family)) {
      this.foldWarned.add(family);
      this.logger?.warn(
        `memory-hindsight: metric ${family} reached ${this.max} label sets; new agent and bank values are recorded as "other" (counted in metrics_series_folded_total)`,
      );
    }
    this.count(this.folded, "metrics_series_folded_total", { family });
  }

  /**
   * Creates every counter series of the owner agent and bank at 0 if absent (COUNTER_SEEDS) and
   * pushes a zero increment for each to the sink. Never changes a count. The route shows them at 0;
   * a host that ignores zero increments shows them from their first event.
   */
  seedCounters(agentId: string | undefined, bankId: string) {
    const agent = agentLabel(agentId);
    const bank = bankLabel(bankId);
    const series: Record<keyof CounterSeeds, Series<{ n: number }>> = {
      recall_total: this.recalls,
      recall_skipped_total: this.skips,
      retain_total: this.retains,
      retain_queue_replays_total: this.replays,
      retain_queue_drops_total: this.drops,
      metrics_series_folded_total: this.folded,
    };
    for (const [family, seeds] of Object.entries(COUNTER_SEEDS)) {
      for (const labels of seeds(agent, bank)) {
        this.count(series[family as keyof CounterSeeds], family, labels, 0);
      }
    }
  }

  /** Pushes one sample to the sink. A recorder that throws (disposed instance) never reaches the turn. */
  private push(record: (sink: MetricsSink) => void) {
    if (!this.sink) {
      return;
    }
    try {
      record(this.sink);
    } catch (error) {
      if (!this.sinkFailed) {
        this.sinkFailed = true;
        this.logger?.warn(
          `memory-hindsight: api.metrics recorder failed (${error instanceof Error ? error.message : String(error)}); further failures are not logged`,
        );
      }
    }
  }

  private count(series: Series<{ n: number }>, family: string, labels: Labels, amount = 1) {
    const entry = series.entry(labels);
    entry.value.n += amount;
    this.push((sink) => sink.counter(family).inc(entry.labels, amount));
  }

  private observe(series: Series<Histogram>, family: string, labels: Labels, value: number) {
    const entry = series.entry(labels);
    observe(entry.value, value);
    this.push((sink) => sink.histogram(family).observe(entry.labels, value));
  }

  recordRecall(agentId: string | undefined, bankId: string, outcome: RecallOutcome, ms: number) {
    const base = { agent: agentLabel(agentId), bank: bankLabel(bankId) };
    this.count(this.recalls, "recall_total", { ...base, outcome });
    this.observe(this.recallLatency, "recall_duration_seconds", base, Math.max(0, ms) / 1000);
  }

  recordRecallSkip(agentId: string | undefined, reason: RecallSkipReason) {
    this.count(this.skips, "recall_skipped_total", { agent: agentLabel(agentId), reason });
  }

  /** One injected block: how many memories and how many characters reached the prompt. */
  recordInjection(agentId: string | undefined, bankId: string, count: number, chars: number) {
    const base = { agent: agentLabel(agentId), bank: bankLabel(bankId) };
    this.observe(this.injectedCount, "recall_injected_memories", base, count);
    this.observe(this.injectedChars, "recall_injected_chars", base, chars);
  }

  recordRetain(agentId: string | undefined, bankId: string, outcome: RetainOutcome, ms: number) {
    const base = { agent: agentLabel(agentId), bank: bankLabel(bankId) };
    this.count(this.retains, "retain_total", { ...base, outcome });
    this.observe(this.retainLatency, "retain_duration_seconds", base, Math.max(0, ms) / 1000);
    if (outcome === "queued") {
      this.queueChanged();
    }
  }

  recordReplay(bankId: string, outcome: ReplayOutcome) {
    this.count(this.replays, "retain_queue_replays_total", { bank: bankLabel(bankId), outcome });
    this.queueChanged();
  }

  recordDrop(bankId: string, reason: DropReason, count = 1) {
    if (count > 0) {
      this.count(
        this.drops,
        "retain_queue_drops_total",
        { bank: bankLabel(bankId), reason },
        count,
      );
      this.queueChanged();
    }
  }

  /** With a sink, queue events push the depth gauge from this source (the timer covers the rest). */
  trackQueueDepth(source: QueueDepthSource) {
    this.queueDepthSource = source;
  }

  private queueChanged() {
    if (this.queueDepthSource) {
      this.publishQueueDepth(this.queueDepthSource);
    }
  }

  /**
   * Creates the depth entry of a bank at 0 if absent, so an idle plugin still has one series
   * (a heartbeat that tells "idle" from "metrics gone"). Never changes an existing depth.
   */
  seedQueueDepth(bankId: string) {
    this.depth.get({ bank: bankLabel(bankId) });
  }

  /** Recomputes the per-bank queue depth (folded banks summed, drained banks 0). */
  private collectDepth(queueDepth?: QueueDepthSource) {
    for (const { value } of this.depth.values()) {
      value.n = 0;
    }
    for (const [bankId, n] of queueDepth?.() ?? []) {
      this.depth.get({ bank: bankLabel(bankId) }).n += n;
    }
    return this.depth.values();
  }

  /** Pushes the queue depth gauge to the sink; the route reads it per scrape instead. */
  publishQueueDepth(queueDepth: QueueDepthSource) {
    if (!this.sink) {
      return;
    }
    let entries: Array<{ labels: Labels; value: { n: number } }>;
    try {
      entries = this.collectDepth(queueDepth);
    } catch {
      return;
    }
    for (const { labels, value } of entries) {
      this.push((sink) => sink.gauge("retain_queue_depth").set(labels, value.n));
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
        value.bounds.forEach((le, i) => {
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
    counter(
      "recall_skipped_total",
      "Eligible auto-recall turns that sent no Hindsight request, by reason.",
      this.skips,
    );
    histogram(
      "recall_injected_memories",
      "Memories in each injected auto-recall block.",
      this.injectedCount,
    );
    histogram(
      "recall_injected_chars",
      "Characters in each injected auto-recall block.",
      this.injectedChars,
    );
    counter("retain_total", "Auto-retain attempts by outcome.", this.retains);
    histogram("retain_duration_seconds", "Auto-retain latency.", this.retainLatency);
    lines.push(
      `# HELP ${PREFIX}retain_queue_depth Retains waiting in the offline queue.`,
      `# TYPE ${PREFIX}retain_queue_depth gauge`,
    );
    for (const { labels, value } of this.collectDepth(queueDepth)) {
      lines.push(`${PREFIX}retain_queue_depth${formatLabels(labels)} ${value.n}`);
    }
    counter(
      "retain_queue_replays_total",
      "Queued retain replay attempts by outcome.",
      this.replays,
    );
    counter("retain_queue_drops_total", "Retains dropped from the queue by reason.", this.drops);
    counter("metrics_series_folded_total", FOLDED_HELP, this.folded);
    return `${lines.join("\n")}\n`;
  }
}

function observe(h: Histogram, value: number) {
  h.bounds.forEach((le, i) => {
    if (value <= le) {
      h.buckets[i]! += 1;
    }
  });
  h.sum += value;
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
