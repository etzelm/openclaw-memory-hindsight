# @etzelm/openclaw-memory-hindsight

A native [Hindsight](https://github.com/vectorize-io/hindsight) memory engine for
[OpenClaw](https://docs.openclaw.ai), packaged as a third-party plugin (plugin id
`hindsight-native`). It owns the memory slot and plugs Hindsight into the host's memory
contracts (replace mode), or runs beside memory-core without touching `memory_search` (sidecar):

- **Auto-recall** before each prompt and **auto-retain** of each finished run. The host's memory
  audience picks the bank: owner-private sessions use the agent's bank, every other conversation
  gets its own, so group chats never surface in the owner's private recall.
- **Agent tools** `hindsight_retain`, `hindsight_recall`, `hindsight_reflect` (plus opt-in
  knowledge-base read tools), a **provider runtime** for `memory.status`, `memory.search` and
  `memory.get`, the pre-compaction flush and `/learn`.
- **Operations**: an offline retain queue, a recall circuit breaker, Gateway metrics and an
  `openclaw hindsight` CLI (status, doctor, recall, queue, forget).

How each part works: [docs/design.md](docs/design.md). Every key in detail:
[docs/configuration.md](docs/configuration.md).

It only imports `openclaw/plugin-sdk/*`. The single runtime dependency is `typebox`.

> **Runtime support:** memory works on turns that run on OpenClaw's embedded agent runtime. On
> CLI-backed runtimes such as `claude-cli`, released OpenClaw (through at least 2026.11.5-beta.2)
> does not give plugin hooks a memory audience, so this plugin recalls, retains and exposes tools
> for none of those turns. Upstream main has the host fixes. See [Limitations](#limitations).

## Quick start

1. Install: `openclaw plugins install npm:@etzelm/openclaw-memory-hindsight`
2. Point it at Hindsight and give it the memory slot (full example under [Install](#install)):

   ```sh
   openclaw config set plugins.entries.hindsight-native.config.hindsightApiUrl http://localhost:8888
   openclaw config set plugins.slots.memory hindsight-native
   openclaw config set plugins.entries.hindsight-native.hooks.allowConversationAccess true
   ```

3. Set `hindsightApiToken` if your Hindsight needs one (a SecretRef; see [Install](#install)).
4. Restart the Gateway, then run `openclaw hindsight doctor` and fix any `FAIL` line it prints.

## Troubleshooting

| You see (Gateway log or behavior)                                                                      | Cause                                                                                                  | Fix                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `memory-hindsight: disabled until configured (<reason>)`                                               | The config does not parse; the reason names the key                                                    | Fix that key; `openclaw hindsight doctor` prints the same reason                                    |
| `memory-hindsight: auto-recall skipped: this session has no memory audience` (debug)                   | The host gave the turn no memory audience: a CLI-backed runtime such as `claude-cli`, or an older host | Run the agent on the embedded runtime, or use a host with the fix (see [Limitations](#limitations)) |
| `memory-hindsight: auto-recall found no bank yet` (debug)                                              | Nothing was retained to this agent's bank yet                                                          | None; the first finished run creates it                                                             |
| `memory-hindsight: auto-recall paused for 60 s after 3 failed recalls (Hindsight slow or unreachable)` | Hindsight timed out or failed three times in a row; the breaker skips recall                           | Check Hindsight (`openclaw hindsight status`); recall resumes by itself                             |
| `memory-hindsight: hindsightApiToken not resolved; requests go unauthenticated`                        | The token SecretRef did not resolve                                                                    | Check the secrets provider path; the CLI takes `--token-file`                                       |
| `memory-hindsight: ignoring invalid live config (<reason>)`                                            | A live config change does not parse; the plugin keeps the config it started with                       | Fix the key the reason names                                                                        |
| No memories injected, no log line                                                                      | `autoRecall` off (globally or in `agents`), `memoryMode: tools`, or a session filter                   | `openclaw hindsight recall "<query>" --agent <id>` shows what auto-recall would inject              |

## Install

Needs OpenClaw 2026.10.10 or newer and a reachable Hindsight API.

From npm:

```sh
openclaw plugins install npm:@etzelm/openclaw-memory-hindsight
```

Released hosts through 2026.10.9 also resolve the bare name
(`openclaw plugins install @etzelm/openclaw-memory-hindsight`) from npm. Newer hosts resolve bare
package names from ClawHub, so the `npm:` prefix keeps the source fixed.

From ClawHub:

```sh
openclaw plugins install clawhub:@etzelm/openclaw-memory-hindsight
```

From GitHub source. `dist/` is not committed and `git:` installs do not run a build, so build a
tarball and install that:

```sh
git clone https://github.com/etzelm/openclaw-memory-hindsight.git
cd openclaw-memory-hindsight
npm ci && npm pack
openclaw plugins install npm-pack:./etzelm-openclaw-memory-hindsight-*.tgz --force --accept-capabilities
```

`--force` confirms the "outside ClawHub review" warning for a local archive. Every install asks for
capability consent (`--accept-capabilities`) because the plugin reads conversation messages in
`agent_end` (auto-retain) and registers memory-slot surfaces. The installer also reports a
`runtime-code-generation` compatibility note for `typebox` (its schema compiler uses
`Function`); tool schemas are only built, not compiled, by this plugin.

Then configure it, select it for the memory slot, allow it, and restart the Gateway:

```json5
{
  plugins: {
    allow: [/* ... */, "hindsight-native"], // only if you use an allowlist
    slots: { memory: "hindsight-native" },
    entries: {
      "hindsight-native": {
        enabled: true,
        hooks: { allowConversationAccess: true }, // auto-retain reads the finished run
        config: {
          hindsightApiUrl: "http://localhost:8888",
          hindsightApiToken: { source: "file", provider: "hindsight", id: "value" },
        },
      },
    },
  },
  secrets: {
    providers: {
      hindsight: {
        source: "file",
        path: "~/.openclaw/secrets/hindsight-api-token",
        mode: "singleValue",
      },
    },
  },
}
```

Memory Core can stay enabled as the dreaming sidecar. When another plugin owns the slot it
registers no `memory_search`/`memory_get` tools (host fix openclaw#191028), so there is no recall
tool conflict.

## Configuration

### Choose a mode: replace or sidecar

**Replace** (slot `hindsight-native`): Hindsight serves `memory_search`, Active Memory, the flush
and `/learn`; memory-core's file index is gone. **Sidecar** (slot `memory-core`): memory-core keeps
those and the plugin adds recall, retain and `hindsight_*` tools (+1265 cached prompt tokens per
turn, plus indexing); it needs a host with [openclaw#198445](https://github.com/openclaw/openclaw/issues/198445). [docs/sidecar-mode.md](docs/sidecar-mode.md)

| Key                               | Default              | Meaning                                                                                                |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `hindsightApiUrl`                 | required             | Base URL of the Hindsight API                                                                          |
| `hindsightApiToken`               | none                 | Bearer token; use a SecretRef                                                                          |
| `memoryMode`                      | `hybrid`             | `hybrid`: auto-recall and tools; `context`: auto-recall only, no tools, no flush; `tools`: tools only  |
| `autoRecall` / `autoRetain`       | `true`               | Turn the hooks on or off                                                                               |
| `recallBudget`                    | `mid`                | Hindsight recall budget: `low`, `mid`, `high`                                                          |
| `recallTypes`                     | all                  | Subset of `world`, `experience`, `observation`                                                         |
| `preferObservations`              | Hindsight default    | Prefer consolidated observations in recall                                                             |
| `recallPromptPreamble`            | built in             | Text above the injected `<hindsight_memories>` block                                                   |
| `retainMission`                   | none                 | Applied to each bank once before its first write                                                       |
| `retainContext`                   | built in             | Context string sent with each retain                                                                   |
| `retainTags`                      | `[]`                 | Tags added to every retained memory (auto-retain, `hindsight_retain`, pre-compaction flush)            |
| `excludeProviders`                | `[]`                 | Message providers that never recall or retain (for example `heartbeat`)                                |
| `skipOperationalSessions`         | `true`               | Skip cron, heartbeat and subagent sessions                                                             |
| `ignoreSessionPatterns`           | `[]`                 | Session-key globs with no recall, retain or `hindsight_*` tools (see below)                            |
| `recallOnlySessionPatterns`       | `[]`                 | Session-key globs that recall and read but never retain (see below)                                    |
| `agentBankMap`                    | `{}`                 | Agent id (normalized like agent ids) to bank id (not `.` or `..`); agents can share a bank             |
| `allowInsecureHttp`               | `false`              | Allow plain http to a non-loopback `hindsightApiUrl` (token and conversation text unencrypted)         |
| `retainQueueEnabled`              | `true`               | Queue auto-retains that fail because Hindsight is unreachable and send them later (see below)          |
| `retainQueueMaxItems`             | `500`                | Most queued retains kept (1 to 10000); the oldest are dropped first                                    |
| `retainQueueMaxAgeMs`             | `604800000` (7 days) | Queued retains older than this are dropped                                                             |
| `recallCacheTtlMs`                | `0` (off)            | Auto-recall cache per session and bank, 0 to 3600000 ms; a repeated query skips the API call           |
| `recallFollowupMaxWords`          | `0` (off)            | At most N words, no URL or path: skip after a recent recall with hits, else add the prior user turn    |
| `recallQueryShaping`              | `off`                | `strip` removes the subagent envelope from the query; see `docs/recall-query-shaping.md`               |
| `recallTopK`                      | none (all)           | Most memories auto-recall injects, 1 to 50, best first                                                 |
| `recallMinScore`                  | none                 | Final-score floor for auto-recall, 0 to 1 (Hindsight `min_scores.final`)                               |
| `recallTagGroups`                 | none                 | Hindsight `tag_groups` for auto-recall and `hindsight_recall` (see below)                              |
| `recallHistoryPattern`            | none                 | Restricted pattern (see below); a matching query recalls without `recallTagGroups`                     |
| `recallTimeoutMs`                 | `10000`              | Auto-recall timeout, 250 to 30000 ms; see the recall circuit breaker below                             |
| `agents`                          | `{}`                 | Per-agent auto-recall keys (see "Per-agent overrides" below); other agents use the global keys         |
| `recallEarlyStart`                | `false`              | Experimental: start recall at message arrival, await it at prompt build (see below); needs a restart   |
| `recallStaleOnTimeout`            | `0` (off)            | On a recall timeout, inject the session's last block from the same bank if younger (ms)                |
| `recallSkipEntities`              | `true`               | Send `include.entities: null`: no entity observations, which the plugin never reads                    |
| `knowledgeReadTools`              | `false`              | Offer the read-only knowledge-base tools (see below); turning it on needs a gateway restart            |
| `memoryPromptSection`             | `false`              | Add a static memory section (under 80 words) to the system prompt; needs a gateway restart             |
| `promptDirectives`                | `false`              | List the owner bank's active global directives in the system prompt (see below); needs a restart       |
| `privateTranscriptRecall`         | `false`              | Remember across conversations ([limits](docs/private-transcript-recall.md)); needs a restart           |
| `slotMode`                        | `auto`               | `replace`, `sidecar`, or `auto` (replace when the slot names this plugin); read at startup             |
| `corpusSupplement`                | `false`              | Sidecar: Hindsight hits in `memory_search` `corpus=wiki`/`all` for matching sessions; needs a restart  |
| `activeMemoryYield`               | `false`              | Sidecar: skip auto-recall on turns Active Memory visibly recalls from Hindsight (docs/sidecar-mode.md) |
| `corpusSupplementSessionPatterns` | `["agent:*:main"]`   | Session-key globs whose `memory_search` may read the owner bank through the supplement                 |
| `memoryFileSync`                  | `false`              | Retain MEMORY.md, USER.md and `memory/*.md` into the owner bank on change (see docs/sidecar-mode.md)   |
| `memoryFileSyncAgents`            | `[]` (default agent) | Agents whose workspace memory files are synced                                                         |
| `memoryFileSyncIntervalMs`        | `600000`             | Scan interval for `memoryFileSync`, 60000 to 86400000 ms                                               |

Config changes apply without a restart: the plugin re-reads its entry from the host's current
config snapshot (`api.runtime.config.current()`), falling back to the register-time
`api.pluginConfig`. One exception: `knowledgeReadTools` registers its tools at startup, so turning
it on takes a gateway restart (turning it off applies at once).

Per-agent overrides, latency levers, session patterns, the tag filter and history pattern, the
cache, cap and floor, the breaker, KB tools and directives: [docs/configuration.md](docs/configuration.md).

## Operate

### `openclaw hindsight` CLI

Operator commands that run in the CLI process, not the Gateway. They read this plugin's config from
the host config, talk to Hindsight directly and never print the token.

- `openclaw hindsight status [--json]`: plugin version, Hindsight URL with reachability and API
  version, the memory slot owner, mode, and the retain queue depth per bank. Exit 1 when Hindsight
  is unreachable.
- `openclaw hindsight doctor`: checks the config, the memory slot, the token, reachability, the
  server version (warns below 1.2.1), auth (one bank-list request) and the retain queue, and prints
  a fix under each failure. Exit 1 when a check fails. It also runs while the plugin is disabled by
  a bad config, to say why.
- `openclaw hindsight recall <query> [--agent <id>] [--bank <id>] [--types <list>] [--json]`:
  read-only. Sends the request auto-recall would send for the agent (default `main`, with its
  `agents` entry), to its owner bank or `--bank`; `--types` (comma list) replaces `recallTypes`.
  Prints each result with its type and final score, and marks the ones past `recallTopK` as not
  injected. Exit 1 when Hindsight does not answer.
- `openclaw hindsight queue --list | --drop <id> [--yes]`: `--list` prints the Gateway's retain
  queue as id, bank, document id, queue time and size, never the memory text. `--drop` removes one
  item so it is never sent: it asks first (outside a terminal it needs `--yes`) and appends a
  tombstone line to the queue file; a running Gateway forgets the item before its next replay step
  or queue write. A replay already sending that item is not stopped.
- `openclaw hindsight forget --session <key> [--agent <id>] [--bank <id>] [--dry-run] [--yes]`:
  deletes the session's auto-retained run documents, and the memory units Hindsight extracted from
  them, from the agent's owner bank and the session's conversation bank (or only `--bank`). It
  lists them first, and `--dry-run` stops there. Otherwise it asks for confirmation; outside a
  terminal it needs `--yes`. It refuses while the Gateway's retain queue still holds a copy of the
  session, or when it cannot read the queue, because replay would bring the text back. Retain
  picks the conversation bank from the session key of the host's memory audience, which can be
  the root session when the run belongs to a child session. If forget finds nothing for a child
  session, run it with the root session key or pass `--bank`.
  Memories saved with `hindsight_retain` or by
  the pre-compaction flush carry no session id and are not removed. Observations Hindsight already
  consolidated from those memories may outlive them until it consolidates again.
- `openclaw hindsight directives list [--all] [--json]`, `directives add --name <n> --content <text>
  [--priority <n>] [--tags <list>]` and `directives rm <id>`: the bank's directives, hard rules
  Hindsight applies to every reflect. All take `--agent <id>` (owner bank of that agent, default
  `main`) or `--bank <id>`. `list` shows active ones (`--all`: inactive too) and marks those
  `promptDirectives` lists. `add` and `rm` show the directive first, then ask; `--dry-run` stops
  after the preview, and outside a terminal they need `--yes`.
- `openclaw hindsight memory show <id> [--json]`, `memory curate <id> --text <text> | --restore |
  --clear-observations` and `memory invalidate <id> [--reason <text>]`: one memory unit by id
  (`hindsight_recall` and `recall --json` print ids), with `--agent`/`--bank` as above. `show`
  prints its type, curation state, dates, document, tags and entities. `curate --text` replaces a
  world or experience memory's text (Hindsight re-embeds it and rebuilds its observations),
  `--restore` makes an invalidated memory valid again, and `--clear-observations` deletes the
  observations derived from it so Hindsight consolidates it again. `invalidate` retires a wrong
  memory: out of recall and consolidation but kept for audit, and reversible. Observations are
  derived and cannot be curated. Each write shows the memory first and asks, like `directives`.
- `openclaw hindsight consolidate [--wait] [--timeout <s>]`: asks Hindsight to consolidate the
  bank's new memories into observations now instead of on its own schedule (`--agent`/`--bank` as
  above). It prints the operation id and returns; with `--wait` it polls every 2 s and prints
  each new status and progress, exits 0 when the operation completed and 1 when it failed, was
  cancelled or is still running after `--timeout` (default 600 s, at most 3600). A timeout does
  not cancel the job on the server.
- `openclaw hindsight export --out <dir>` and `openclaw hindsight sync-memory-files [--dry-run]`:
  bank memories to markdown, and one memory file sync pass; see [docs/sidecar-mode.md](docs/sidecar-mode.md).

The CLI does not resolve SecretRefs the way the Gateway does (checked on 2026.10.10), so with a
SecretRef token pass `--token-file <path>` to any of the three commands; the file holds the token
alone, is read for that run only and is never printed. Without it `doctor` warns and requests from
the CLI go unauthenticated.

### Retain queue

Auto-retains that fail because Hindsight is unreachable wait in a file-backed queue in the
Gateway's state dir and replay when it answers (`retainQueueEnabled`, on by default).
`openclaw hindsight queue --list` shows it; edge cases (bounds, restarts, rejections, tombstones)
are in [docs/offline-retain-queue.md](docs/offline-retain-queue.md).

### Gateway metrics

The plugin serves Prometheus text at `GET /plugins/hindsight-native/metrics` on the Gateway
port. The route uses Gateway auth and needs `operator.read` (or `operator.write` /
`operator.admin`), the same as `diagnostics-prometheus`, so scrape it with the token you use
for `/api/diagnostics/prometheus`. `diagnostics-prometheus` renders only core diagnostic
events and has no plugin metric surface, which is why this is a separate path. There is no
config key; counters live in memory and reset when the Gateway restarts.

| Series (`openclaw_hindsight_` prefix) | Type      | Labels                     |
| ------------------------------------- | --------- | -------------------------- |
| `recall_total`                        | counter   | `agent`, `bank`, `outcome` |
| `recall_duration_seconds`             | histogram | `agent`, `bank`            |
| `recall_skipped_total`                | counter   | `agent`, `reason`          |
| `recall_injected_memories`            | histogram | `agent`, `bank`            |
| `recall_injected_chars`               | histogram | `agent`, `bank`            |
| `retain_total`                        | counter   | `agent`, `bank`, `outcome` |
| `retain_duration_seconds`             | histogram | `agent`, `bank`            |
| `retain_queue_depth`                  | gauge     | `bank`                     |
| `retain_queue_replays_total`          | counter   | `bank`, `outcome`          |
| `retain_queue_drops_total`            | counter   | `bank`, `reason`           |

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
  Past 200 label sets per metric family, new `agent` and `bank` values fold into `other`;
  `outcome` and `reason` keep their value. No session ids, document ids or text.

### Rollback

Both plugins are `kind: memory`; only the slot owner runs. To go back to the vendor plugin:

```sh
openclaw config set plugins.slots.memory hindsight-openclaw
# restore plugins.entries.active-memory.config.toolsAllow if you removed it
openclaw gateway restart
```

Owner-private memory is in the same banks either way, so nothing is lost. Conversation banks
(`<bank>::conv::<hash>`) are only read by this plugin.

## Security

Every request carries the bearer token (if set) and, for recall and retain, conversation text. The
plugin refuses a plain `http://` `hindsightApiUrl` to any host other than `localhost`, `127.0.0.0/8`
or `::1`, and config resolution fails with an error that names `allowInsecureHttp`. Prefer `https://`
or a loopback tunnel. To accept the risk on a trusted network, set `allowInsecureHttp: true`; the
plugin then warns at service start that the token and conversation text travel unencrypted.
Redirects are refused, so an https endpoint cannot forward a request body to plain http. Report
vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Compatibility

### Supported OpenClaw versions

OpenClaw `>=2026.10.10` is supported. Older hosts lack APIs or session behavior the plugin needs
(see [Host API evidence](docs/host-api-evidence.md)). Memory needs the embedded agent runtime; CLI
runtimes such as `claude-cli` get none yet (see [Limitations](#limitations)).

`scripts/compat-matrix.sh` runs the live proof on the floor host (2026.10.10), the latest
OpenClaw release and OpenClaw `main`, on the embedded and `claude-cli` runtimes. See
[docs/compat-matrix.md](docs/compat-matrix.md) for how to run it and the expected cells.

## Releases and versioning

The plugin follows [semver](https://semver.org/). Before 1.0, a patch release (0.1.x) carries
fixes and security fixes only, and a minor release (0.x.0) may change config or behavior, with an
upgrade note in [CHANGELOG.md](CHANGELOG.md). Raising the minimum OpenClaw version is at least a
minor release. Each release has a CHANGELOG entry, a `vX.Y.Z` tag on GitHub and the same version
on npm and ClawHub. Only the latest release gets fixes. A version with a known security problem is
deprecated on npm once the fix ships, as 0.1.1 is.

## Limitations

- **No memory on CLI-backed runtimes in released OpenClaw.** Released OpenClaw (checked through
  2026.11.5-beta.2) builds the CLI runner's plugin hook context (for example `claude-cli`)
  without a memory audience
  ([openclaw/openclaw#194453](https://github.com/openclaw/openclaw/issues/194453)). On those
  turns auto-recall, auto-retain and the `hindsight_*` tools are skipped with "this session has
  no memory audience". Upstream main has the hook fix since 2026-11-09 and lists the tools with
  the audience since openclaw/openclaw#197274 (2026-11-11); the first release that ships both
  brings memory to CLI turns. Until then, use an embedded model route for agents that need
  memory, or keep `@vectorize-io/hindsight-openclaw` for them. The expected matrix cells are in
  [docs/compat-matrix.md](docs/compat-matrix.md).
- **Sessions without a memory audience get no memory.** Recall, retain and the tools need a
  host-minted audience. The host mints one only for sessions whose root has a durable chat
  type: owner direct chats get the owner-private bank, groups and other senders get a
  conversation bank. Sessions created by `openclaw agent` from the CLI, older Control UI
  (dashboard) roots and some cron or subagent rows have none, so they read and write nothing
  (the vendor plugin fell back to the agent bank). This is intended per the SDK contract ("a
  session authority without an audience has no private or conversation grant"). Run
  `openclaw doctor --fix` to stamp older dashboard roots.
- **Workspace memory files are outside the bank split.** The audience split covers Hindsight
  banks only. An agent with file or shell tools can write a fact to its workspace (for example
  the daily note `memory/YYYY-MM-DD.md`), and any later session of that agent with the same tools
  can read it, group chats included. To keep owner facts out of group sessions, sandbox non-main
  sessions or deny `group:fs` and `group:runtime` for them in OpenClaw's tool policy.
- **Auto-retain does not re-check audience currency.** The host runs `agent_end` unawaited and
  releases the audience when the attempt ends, so a check there would race and drop retains. The
  bank still comes from the run's host-minted audience; recall and the tools keep their checks.
- **`memory.search` through the provider runtime skips the plugin filters.** It is gated by the
  caller's audience (owner-private or conversation), not by `memoryMode`, `excludeProviders`,
  `ignoreSessionPatterns`, `recallOnlySessionPatterns`, `skipOperationalSessions` or incognito
  session keys. Those filters apply to auto-recall, auto-retain and the tools only.
- `hindsightApiUrl` must not contain credentials, a query string or a fragment, even an empty
  one such as a trailing `?` or `#` (the parser rejects it). An unresolved SecretRef token, or a
  token sent over plain `http` to a non-loopback host, logs one warning at service start.
- Flush dedupe is per process; a restart mid-cycle can repeat a flush write, which the stable
  document id plus `update_mode: replace` turns into an overwrite.
- Conversation banks are never pruned by the plugin, and `openclaw memory forget` reaches neither
  mode (no host seam yet); `openclaw hindsight forget` removes one session's auto-retained documents.

Not ported from the vendor plugin: knowledge-base write tools, `retainToolCalls`, `retainEveryNTurns`,
the local Hindsight daemon, and per-user/per-channel banks (replaced by audience routing).

## Development

```sh
npm ci
npm run typecheck && npm run build && npm test && npm run lint && npm run format:check
npm pack --dry-run   # dist/*.js, openclaw.plugin.json, README, CHANGELOG, LICENSE only
```

`scripts/live-proof.sh` (one host, one runtime, real turns, `--slot sidecar` for the sidecar
build) and `scripts/compat-matrix.sh` (floor, latest, main): [docs/compat-matrix.md](docs/compat-matrix.md).
