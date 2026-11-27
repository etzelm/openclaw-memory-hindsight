# Gateway metrics

The plugin publishes its metrics one of two ways, never both:

- **Through the Gateway's Prometheus scrape** (OpenClaw hosts with `api.metrics`, openclaw#198455,
  in no release yet). Set `allowMetrics: true` on the plugin's host entry, not in its `config`,
  and enable `diagnostics-prometheus`:

  ```json5
  {
    plugins: {
      entries: {
        "diagnostics-prometheus": { enabled: true },
        "hindsight-native": { enabled: true, allowMetrics: true, config: {/* ... */} },
      },
    },
  }
  ```

  The families below then appear on `/api/diagnostics/prometheus` with the host prefix
  `openclaw_plugin_hindsight_native_` (for example
  `openclaw_plugin_hindsight_native_recall_total`), and the plugin route is not served. A family
  shows up after its first sample. The queue depth gauge is refreshed every 15 s and on every
  queue change. Past 120 label sets per family, new `agent` and `bank` values fold into `other`
  (the host keeps at most 128). If `allowMetrics` is set but `diagnostics-prometheus` is off,
  nothing is exported.

- **On the plugin route** (the floor host, or `allowMetrics` off, or the host refuses the
  registration). The plugin serves Prometheus text at `GET /plugins/hindsight-native/metrics` on
  the Gateway port with the `openclaw_hindsight_` prefix. The route uses Gateway auth and needs
  `operator.read` (or `operator.write` / `operator.admin`), the same as `diagnostics-prometheus`,
  so scrape it with the token you use for `/api/diagnostics/prometheus`.

Switching paths renames the series (`openclaw_hindsight_X` becomes
`openclaw_plugin_hindsight_native_X`; labels are unchanged), so update dashboards and alerts or
rename at ingest with a `metric_relabel_configs` rule. Counters live in memory and reset when the
Gateway restarts (or, on the scrape path, when the exporter stops). Alert triage and rollback:
[metrics-runbook.md](metrics-runbook.md).

| Series (after the prefix)     | Type      | Labels                     |
| ----------------------------- | --------- | -------------------------- |
| `recall_total`                | counter   | `agent`, `bank`, `outcome` |
| `recall_duration_seconds`     | histogram | `agent`, `bank`            |
| `recall_skipped_total`        | counter   | `agent`, `reason`          |
| `recall_injected_memories`    | histogram | `agent`, `bank`            |
| `recall_injected_chars`       | histogram | `agent`, `bank`            |
| `retain_total`                | counter   | `agent`, `bank`, `outcome` |
| `retain_duration_seconds`     | histogram | `agent`, `bank`            |
| `retain_queue_depth`          | gauge     | `bank`                     |
| `retain_queue_replays_total`  | counter   | `bank`, `outcome`          |
| `retain_queue_drops_total`    | counter   | `bank`, `reason`           |
| `metrics_series_folded_total` | counter   | `family`                   |

- `retain_queue_depth` always has a series for the owner bank of the default agent from plugin
  start (0 when the queue is empty), so an alert can tell an idle plugin from gone metrics.
- Every counter family starts at 0 for the owner agent and bank with each `outcome` or `reason`
  (and `metrics_series_folded_total` for each family), so `rate()` and `increase()` have a
  baseline before the first event. On the route these series are there from start. On the
  `api.metrics` path the plugin sends the zero increments, but the host exporter ignores an
  increment of 0 (diagnostics-prometheus `prometheus-metric-store.ts`), so a counter shows up
  with its first event; alert on those with `or vector(0)`.
- `metrics_series_folded_total{family}` counts samples recorded as `other` because their family
  reached its label-set bound (120 with `api.metrics`, 200 on the route). The first fold of a
  family also logs one warning. Nothing is dropped by the plugin: past the bound, new `agent` and
  `bank` values fold into `other`, and `outcome` and `reason` keep their value, so a family holds
  at most 126 label sets, under the host cap of 128. If the host still drops a series (its shared
  series budget is full), it counts it in `openclaw_prometheus_family_series_dropped_total`.
- Recall counts the auto-recall request only: `injected`, `empty` (no results or no bank yet),
  `timeout`, `error`. A recall the host cancels (audience changed, hook invocation stale) is
  not counted. Retain counts auto-retain only: `sent`, `queued`, `timeout`, `error`. Tool
  calls are not counted.
- Skips count eligible auto-recall turns that sent no request, by `reason`: `filter` (excluded
  provider, operational session, ignore pattern, incognito), `no_audience`, `empty_query` (no
  usable text after boilerplate stripping), `followup` (the follow-up rule), `cache_hit` (memories
  injected from the cache) and `breaker_open` (the recall circuit breaker). Recall turned off and
  host maintenance turns are not counted.
- `recall_injected_memories` and `recall_injected_chars` observe each injected block, fresh or
  from the cache: how many memories and how many characters reached the prompt. Buckets: 1, 2,
  3, 5, 8, 10, 15, 20, 30, 50 memories; 250 to 32000 characters.
- The latency histograms cover every outcome, so timeouts and fast `queued` retains are in the
  same quantiles as successful calls.
- Replays: `delivered`, or `deferred` (Hindsight unreachable, item kept). Drops count retains
  that are lost: `limit` (`retainQueueMaxItems`, `retainQueueMaxAgeMs` or the size bound),
  `too_large` (the live write failed and the item is over the queue's size bound), `rejected`
  (a 4xx on replay).
- `agent` is the normalized agent id. `bank` is the owner bank; every conversation bank of
  that owner shares one `<bank>::conv` label. Values that are not label-safe read `unknown`.
  On the route, past 200 label sets per metric family, new `agent` and `bank` values fold into `other`;
  `outcome` and `reason` keep their value. No session ids, document ids or text.
