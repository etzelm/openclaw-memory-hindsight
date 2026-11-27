# Metrics runbook

What to do when `hindsight-plugin-metrics-down` fires, how to tell an idle plugin from missing
metrics, and how to roll back from the `api.metrics` path. The two paths are described in
[metrics.md](metrics.md). After a Prometheus rename rule both paths store the same names
(`openclaw_hindsight_*`), and only the `job` label differs: `openclaw-hindsight` for the plugin
route and `openclaw` for the Gateway scrape (`/api/diagnostics/prometheus`).

Owner: claw main. Escalate to Mitchell when a rollback needs a studio-configs merge or revert,
or when the Gateway itself is down.

## What the alert means

`hindsight-plugin-metrics-down` (warning, `for: 15m`) has two branches:

| Path                             | Fires when                                                                                                                                                                   | Usually means                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Route (job `openclaw-hindsight`) | `up{job="openclaw-hindsight"}` is 0 or absent, and no `openclaw_hindsight_*` series came in under job `openclaw` in the last 6 h                                             | Gateway down, plugin not loaded, route not served (`allowMetrics` on), token rejected, or the scrape job removed |
| Api (job `openclaw`)             | `up{job="openclaw"}` is 1, the heartbeat `openclaw_hindsight_retain_queue_depth{job="openclaw"}` was seen in the last 7 d and is absent now, and the route job has no series | Gateway up but the plugin is not publishing: not loaded, `register()` failed, or `allowMetrics` was removed      |

If the whole Gateway scrape is down (`up{job="openclaw"}` 0), the api branch stays quiet and the
Gateway alerts fire instead. Without any `up{job="openclaw"}` sample, only the route branch with
its 6 h window applies.

## Idle or gone

The plugin always publishes `retain_queue_depth{bank="<owner bank>"}` from start (0 when the queue
is empty), on both paths. Counters only move on traffic. On the route every counter family shows 0
for the owner bank from start; on the api path a counter appears with its first event (the host
exporter ignores zero increments). A growing `openclaw_hindsight_metrics_series_folded_total`
means a family hit its label-set bound and new agents or banks read `other`; the first fold also
logs one warning.

- **Idle**: the heartbeat series is present (value 0 is fine) and counters are flat. Nothing to do.
- **Gone**: the heartbeat is absent while the scrape target is up. Check, in order:
  1. `openclaw plugins inspect hindsight-native --json`: status `loaded`, and the install source.
  2. The Gateway log for `memory-hindsight: api.metrics register failed` (the plugin fell back to
     the route) or `memory-hindsight: api.metrics recorder failed`.
  3. `openclaw config get plugins.entries.hindsight-native.allowMetrics` and whether
     `diagnostics-prometheus` is enabled. `allowMetrics: true` with the exporter off exports
     nothing.
  4. On the route path: `curl -s -H "Authorization: Bearer <gateway token>" <gateway>/plugins/hindsight-native/metrics`
     should answer 200 with `openclaw_hindsight_` lines. Control UI HTML means the route is not
     served (the `api.metrics` path is active).

## Rollback A: back to the route, keep the build

Use it when the build is fine but the `api.metrics` path is not (no series, wrong labels, a
dashboard gap).

```bash
openclaw config set plugins.entries.hindsight-native.allowMetrics false --strict-json
openclaw config validate
openclaw gateway restart --safe
```

Check: the route answers 200 with `openclaw_hindsight_` lines, the Gateway scrape has no
`openclaw_plugin_hindsight_native_` lines, and `up{job="openclaw-hindsight"}` is 1 within a minute.

Measured on an isolated dev Gateway (OpenClaw d7d546f, 3 runs, Mac Studio under load): config set
plus validate 13.7 s (median 42.6 s), stop 0.5 s (median 1.4 s), start to healthy 6.0 s (median
13.4 s), healthy to route serving 7.5 s (median 13.8 s). Total 31 s on the fastest run, 75 s
median, 171 s worst. On that build `config set` already hot-reloads the plugin, and the route
served before the restart in every run. The restart is still part of the procedure so the plugin
registers cleanly.

**On the mini:** studio-configs !340 removed the `openclaw-hindsight` scrape job. Rollback A brings
the route back, but nothing scrapes it, and the api branch of the alert fires after 15 min. If
!340 is not reverted, the route branch fires too, once its 6 h window has passed with no
`openclaw_hindsight_*` series under job `openclaw`. Revert !340 as well (Mitchell merges
studio-configs), then check `up{job="openclaw-hindsight"}` is 1.

## Rollback B: back to the npm 0.10.0 release

Use it when the build itself misbehaves.

```bash
openclaw config unset plugins.entries.hindsight-native.allowMetrics
openclaw plugins install npm:@etzelm/openclaw-memory-hindsight@0.10.0 --pin --force --no-enable
openclaw config validate
openclaw gateway restart --safe
openclaw plugins inspect hindsight-native --json | grep -E '"(source|version|shasum|status)"'
```

Expect source `npm`, version `0.10.0`, shasum `0819e4bbe14328ecb4f5bc2567d31c58cec2c4cd`, status
`loaded`. Replacing a local archive install with the npm one needed no consent prompt in the
drill.

Measured (same setup): unset 9.6 s (median 24.8 s), npm install 22.2 s (median 39.5 s), validate
2.5 s (median 2.6 s), stop 0.7 s (median 0.8 s), start to healthy 9.1 s (median 16.8 s), route
serving 5.1 s (median 10.5 s), inspect 3.3 s (median 4.8 s). Total 62 s on the fastest run, 97 s
median, 181 s worst. The same studio-configs note as rollback A applies on the mini.

## Restart notes

`openclaw gateway restart --safe` waits for active work to drain (bounded at 5 min) and relies on
the service supervisor to start the new process. A Gateway run in the foreground with
`gateway run` exits on it and does not come back; restart such a Gateway by hand.
