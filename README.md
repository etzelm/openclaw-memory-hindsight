# @etzelm/openclaw-memory-hindsight

A native [Hindsight](https://github.com/vectorize-io/hindsight) memory engine for
[OpenClaw](https://docs.openclaw.ai), packaged as a third-party plugin (plugin id
`hindsight-native`). It owns the memory slot and plugs Hindsight into the host's memory
contracts instead of only hooking prompts:

- **Provider runtime**: `memory.status`, `memory.search` (v2) and `memory.get` in the Gateway,
  CLI and Control UI read Hindsight through the host's audience-checked provider API.
- **Auto-recall** before each prompt and **auto-retain** of each finished run (one document per
  run, replaced on re-delivery). Host maintenance turns (the pre-compaction flush and Active
  Memory's recall child) get neither; they use the tools. A bank nothing was retained to yet
  reads as "no memories", without a warning.
- **Agent tools** `hindsight_retain`, `hindsight_recall`, `hindsight_reflect`, plus opt-in
  read-only knowledge-base tools (see [Knowledge-base read tools](#knowledge-base-read-tools)).
- **Recall tool declaration** (`recallToolNames`): Active Memory uses `hindsight_recall` and
  `hindsight_reflect` without a `toolsAllow` list.
- **Pre-compaction flush, tools arm**: before compaction the host runs a silent turn that saves
  durable context through `hindsight_retain` (deduplicated per flush id, stable document ids).
- **/learn**: lessons persist through `hindsight_retain` on hosts that have the learn seam
  (see [Compatibility](#compatibility)).
- **Audience-based banks**: the host-minted memory audience picks the bank. Owner-private
  sessions use the agent's bank (same id as the vendor plugin's per-agent bank, so existing
  memory carries over); group chats and other senders get a separate
  `<bank>::conv::<hash>` bank per conversation, so their memories never surface in the owner's
  private recall.

It only imports `openclaw/plugin-sdk/*`. The single runtime dependency is `typebox`.

> **Runtime support:** memory works on turns that run on OpenClaw's embedded agent runtime. On
> CLI-backed runtimes such as `claude-cli`, OpenClaw (through at least 2026.11.1) does not give
> plugin hooks a memory audience, so this plugin recalls, retains and exposes tools for none of
> those turns. See [Limitations](#limitations).

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
openclaw plugins install npm-pack:./etzelm-openclaw-memory-hindsight-0.3.0.tgz --force --accept-capabilities
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

| Key                         | Default              | Meaning                                                                                               |
| --------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `hindsightApiUrl`           | required             | Base URL of the Hindsight API                                                                         |
| `hindsightApiToken`         | none                 | Bearer token; use a SecretRef                                                                         |
| `memoryMode`                | `hybrid`             | `hybrid`: auto-recall and tools; `context`: auto-recall only, no tools, no flush; `tools`: tools only |
| `autoRecall` / `autoRetain` | `true`               | Turn the hooks on or off                                                                              |
| `recallBudget`              | `mid`                | Hindsight recall budget: `low`, `mid`, `high`                                                         |
| `recallTypes`               | all                  | Subset of `world`, `experience`, `observation`                                                        |
| `preferObservations`        | Hindsight default    | Prefer consolidated observations in recall                                                            |
| `recallPromptPreamble`      | built in             | Text above the injected `<hindsight_memories>` block                                                  |
| `retainMission`             | none                 | Applied to each bank once before its first write                                                      |
| `retainContext`             | built in             | Context string sent with each retain                                                                  |
| `retainTags`                | `[]`                 | Tags added to every retained memory (auto-retain, `hindsight_retain`, pre-compaction flush)           |
| `excludeProviders`          | `[]`                 | Message providers that never recall or retain (for example `heartbeat`)                               |
| `skipOperationalSessions`   | `true`               | Skip cron, heartbeat and subagent sessions                                                            |
| `ignoreSessionPatterns`     | `[]`                 | Session-key globs with no recall, retain or `hindsight_*` tools (see below)                           |
| `recallOnlySessionPatterns` | `[]`                 | Session-key globs that recall and read but never retain (see below)                                   |
| `agentBankMap`              | `{}`                 | Agent id to bank id, so several agents share one owner bank                                           |
| `allowInsecureHttp`         | `false`              | Allow plain http to a non-loopback `hindsightApiUrl` (token and conversation text unencrypted)        |
| `retainQueueEnabled`        | `true`               | Queue auto-retains that fail because Hindsight is unreachable and send them later (see below)         |
| `retainQueueMaxItems`       | `500`                | Most queued retains kept (1 to 10000); the oldest are dropped first                                   |
| `retainQueueMaxAgeMs`       | `604800000` (7 days) | Queued retains older than this are dropped                                                            |
| `recallCacheTtlMs`          | `0` (off)            | Auto-recall cache per session and bank, 0 to 3600000 ms; a repeated query skips the API call          |
| `recallFollowupMaxWords`    | `0` (off)            | At most N words, no URL or path: skip after a recent recall with hits, else add the prior user turn   |
| `knowledgeReadTools`        | `false`              | Offer the read-only knowledge-base tools (see below); turning it on needs a gateway restart           |
| `listToolsWithoutAudience`  | `false`              | List the `hindsight_*` tools when the host builds the tool list without an audience (see below)       |

Session patterns: `*` matches any run of characters except `:`, `**` matches anything including
`:`, everything else is literal. Patterns match the trimmed session key. `ignoreSessionPatterns`
sessions get no auto-recall, no auto-retain and no `hindsight_*` tools. `recallOnlySessionPatterns`
sessions (for example `agent:dev:subagent:**`) get auto-recall, `hindsight_recall`,
`hindsight_reflect` and, with `knowledgeReadTools`, the knowledge-base read tools, even when
`skipOperationalSessions` would skip them, but never auto-retain and no `hindsight_retain`.
`excludeProviders`, `temp:` and incognito sessions win over both lists, and ignore wins over
recall-only. A pattern never selects a bank; the bank still comes from the memory audience.

Fixed values (not configurable): recall max tokens 1024, query cap 800 characters, recall
timeout 10 s, retain and reflect timeout 30 s, memory get and knowledge-base tool timeout 10 s
(each combined with the host's abort signal when there is one), retained roles user and
assistant, JSON transcript format, recall injected before the user message (outside the system
prompt, so the cached prefix stays stable). Knowledge-base tool caps: a response body over
1 MiB fails; a page shows its first 32000 characters, then `(truncated, N more characters)`;
the tree shows 500 entries, then `(truncated, N more entries)`; search shows at most 50 hits
with snippets cut at 500 characters and names and ids at 200.

`listToolsWithoutAudience`: the claude-cli runtime on OpenClaw 2026.11.x builds a turn's MCP tool
list before it attaches the turn's memory audience, so every tool factory sees no audience, returns
null, and `hindsight_*` never reach claude-cli sessions (auto-recall still works; it reads the
audience from the hook context). With this key on, an agent session with a session key gets the
tools listed anyway. The host then builds the callable copy with the audience from the run's grant,
and that copy alone reaches Hindsight; a call that still has no audience fails with an error before
any request. The session filters (`memoryMode`, incognito, `excludeProviders`,
`skipOperationalSessions`) apply as before, and an audience for another agent is still refused.

Config changes apply without a restart: the plugin re-reads its entry from the host's current
config snapshot (`api.runtime.config.current()`), falling back to the register-time
`api.pluginConfig`. One exception: `knowledgeReadTools` registers its tools at startup, so turning
it on takes a gateway restart (turning it off applies at once).

### Offline retain queue

When an auto-retain cannot reach Hindsight (network error, timeout or HTTP 5xx), the plugin
writes it to `<state dir>/hindsight-native/retain-queue.jsonl` and logs one warning per failed
retain. The state dir is the one the host passes to plugin services (`~/.openclaw` by default,
or `OPENCLAW_STATE_DIR`). The file is mode 600 in a mode 700 directory, one JSON line per item.
It holds the bank id, document id and the retain payload (transcript, context, tags, metadata),
and never the API URL or token. The transcript is conversation text, so treat the file like
session transcripts.

- **Same bank, always.** Each item keeps the bank chosen from the run's memory audience when the
  run ended. Replay writes to that bank only, even if `agentBankMap` changed in between. Items do
  not record the server: if `hindsightApiUrl` points at another Hindsight by then, they go there
  under the same bank id.
- **No duplicates.** Each item keeps its document id and is sent with `update_mode: replace`. A
  second retain of the same document replaces the queued copy, and a replay that the server had
  already received overwrites instead of adding a document.
- **Replay.** At service start, on a timer after a failure, and after the next successful retain.
  The first retry comes 30 s after a failed pass, and the wait doubles after each further failed
  pass (a turn for a bank with queued items also starts a pass), up to 15 min. Items go out oldest
  first and a pass stops at the first item it cannot deliver, so each bank sees its writes in order.
  While a bank has queued items, a new retain for that bank queues behind them. Two retains for one
  bank that are in flight at the same moment can still land out of order if the earlier one fails
  and is queued.
- **Not queued.** A 4xx answer (bad request, unknown bank, auth) and a refused redirect are logged
  and dropped as before. On replay, only a Hindsight HTTP 4xx about the item drops it, with a
  warning: any 4xx except 401, 403, 429 and an ambiguous 404 (a wrong `hindsightApiUrl` path, an
  HTML or empty body). Hindsight creates a bank on its first retain, so its explicit `Bank '<id>'
  not found` 404 is about the item and drops it. Everything else keeps the item, ends the pass and
  backs off: network errors, timeouts, 5xx, 401, 403, 429, an ambiguous 404, a 4xx from bank setup
  (applying `retainMission`), a refused redirect and any unexpected error. Kept items hold back
  items for other banks until the next attempt; anything other than a network error, timeout or 5xx
  logs one warning until something is delivered again.
- **Tags.** An item keeps the tags resolved when the run ended (`retainTags` plus inline
  `<retain_tags>`); a later `retainTags` change does not touch queued items.
- **Limits.** Items beyond `retainQueueMaxItems` or a fixed 32 MiB total (UTF-8 bytes on disk,
  oldest first), or older than `retainQueueMaxAgeMs`, are dropped with one warning until the queue
  is empty again. A single retain larger than 32 MiB is not queued: it is sent live without waiting
  for its bank's queue, and its failure is logged as before.
- **Disk writes.** A new item is appended, on a new line even after a torn last line. Replacing,
  pruning and replay rewrite the file (atomic rename); replay writes once per 25 delivered items and
  at the end of each pass, and a failed write is retried by the next one. If a rewrite fails, the
  new or newer copy is appended instead, with a tombstone for any item the limits drop; the older
  copy stays in the file until the next successful rewrite, and load keeps only the newest line per
  bank and document id. An append that would take
  the file past 32 MiB rewrites it instead. Only when that rewrite fails too is the item not queued:
  an out-of-date copy it replaced gets a tombstone line so a restart does not replay it, and the
  retain is sent live, or, when its live write already failed, logged and not kept. Until the next
  successful rewrite, the file stays within 32 MiB plus at most one short tombstone line per item
  removed from the queue meanwhile. A crash between replay's writes can also leave an already delivered copy before
  a newer one; load keeps the newer one, and replay always sends `update_mode: replace` with the
  item's document id, so a repeat is harmless. One queue per file per process, shared across
  service restarts.
- **Downgrade.** The file format is unchanged. 0.2.0 reads tombstones but keeps every copy of a
  document (left by a crash during replay or by a replace that could not rewrite the file) and
  sends them oldest first, same document id with replace, so the newest text wins unless the same
  document is retained again before that replay finishes. 0.1.x has no queue and ignores the file.
  A build that ignores tombstone lines (only unreleased queue builds before 0.2.0) can replay an
  out-of-date copy a tombstone hid; if the newer copy was then sent live and never queued, the stale
  text overwrites it on the server. Let the queue drain (the file is deleted when it is empty), or
  delete the file, before downgrading.
- Only auto-retain is queued. `hindsight_retain` and the pre-compaction flush return the error to
  the agent, as before. With `retainQueueEnabled: false` the plugin neither reads nor writes the
  file; delete it, or turn the queue back on to drain it. `retainQueueEnabled` is read at service
  start (restart the gateway after changing it); the two limits apply live. One gateway process per
  state dir: the file is not locked.

### Knowledge-base read tools

With `knowledgeReadTools: true` the agent also gets three read-only tools over Hindsight's
knowledge pages (documents Hindsight writes and refreshes from memories), under the same names as
the vendor plugin:

- `hindsight_get_knowledge_base_tree`: folders and pages with page ids and a stale mark
  (`GET .../knowledge-base/tree`).
- `hindsight_search_knowledge_base`: pages matching a query, with a snippet (`query`, optional
  `limit` clamped to 1-50; `GET .../knowledge-base/search`).
- `hindsight_get_knowledge_page`: one page as markdown by `page_id`
  (`GET .../knowledge-base/pages/<id>`).

They follow the recall tools' rules: same bank from the host-minted memory audience (an
owner-private session reads the owner bank, a conversation reads only its own
`<bank>::conv::<hash>` bank), same session filters, none in `context` mode or without an
audience. Hindsight scopes page ids to the bank in the URL, so a page id from the owner bank is
"not found" through a conversation bank. A bank nothing was written to reads as "no knowledge
pages yet"; as with recall, a 404 with an empty body counts as a missing bank too. A route 404
(`{"detail":"Not Found"}`: wrong URL or a Hindsight version without these endpoints) stays an
error. `page_id` must look like a Hindsight id (letters, digits, `_ . : -`, starting with a
letter or digit, at most 200 characters) and is refused otherwise, before any request. Output
is marked as untrusted data, like recall, and capped (see Fixed values). The manifest's
`contracts.tools` always lists the three names (it is static), so they appear in plugin status
and doctor tool-owner output even with the key off; they are registered only when it is on.
Host tool listings can therefore show them while the key is off: the manifest's `configSignals`
only test that a key is present, not that it is `true`, so they cannot express this key. The
write tools (create folder, create page, update, delete) are not ported.

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
| `retain_total`                        | counter   | `agent`, `bank`, `outcome` |
| `retain_duration_seconds`             | histogram | `agent`, `bank`            |
| `retain_queue_depth`                  | gauge     | `bank`                     |
| `retain_queue_replays_total`          | counter   | `bank`, `outcome`          |
| `retain_queue_drops_total`            | counter   | `bank`, `reason`           |

- Recall counts the auto-recall request only: `injected`, `empty` (no results or no bank yet),
  `timeout`, `error`. A recall the host cancels (audience changed, hook invocation stale) is
  not counted. Retain counts auto-retain only: `sent`, `queued`, `timeout`, `error`. Tool
  calls are not counted.
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

### Mapping from `@vectorize-io/hindsight-openclaw`

| Vendor key                                                                                                                                                                                                                                                                                                        | Here                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hindsightApiUrl`, `hindsightApiToken`, `memoryMode`, `autoRecall`, `autoRetain`, `recallBudget`, `recallTypes`, `preferObservations`, `recallPromptPreamble`, `retainMission`, `retainContext`, `retainTags`, `excludeProviders`, `skipOperationalSessions`, `agentBankMap`                                      | Same key, same meaning                                                                                    |
| `dynamicBankId`, `dynamicBankGranularity`, `bankIdPrefix`                                                                                                                                                                                                                                                         | Replaced by audience routing: owner bank = agent id (or `agentBankMap`), conversations get their own bank |
| `retainRoles`, `recallRoles`, `retainFormat`, `recallMaxTokens`, `recallMaxQueryChars`, `recallTimeoutMs`, `recallInjectionPosition`, `retainSource`                                                                                                                                                              | Fixed values (see above)                                                                                  |
| `retainQueueMaxAgeMs`                                                                                                                                                                                                                                                                                             | Same key; must be a positive number of ms (the vendor's `-1` for no limit is rejected)                    |
| `retainToolCalls`, `retainEveryNTurns`, `retainOverlapTurns`, `recallContextTurns`, `retainQueuePath`, `retainQueueFlushIntervalMs`, `enableKnowledgeTools`, `allowKnowledgeDelete`, daemon keys (`apiPort`, `embedPort`, `embedVersion`, `daemonIdleTimeout`), `llm*`, `debug*`, `log*`, `skipStatelessSessions` | Not supported; remove them (unknown keys are rejected)                                                    |

## Compared with `@vectorize-io/hindsight-openclaw`

Both plugins talk to the same Hindsight API and use the same per-agent owner bank ids. Differences
as of the vendor plugin 1.2.0:

- **`recallToolNames`**: this plugin declares `hindsight_recall` and `hindsight_reflect`, so
  Active Memory's deep recall uses them without a `toolsAllow` list. The vendor plugin declares
  none, and once Memory Core stops registering its tools for a slot it does not own
  (openclaw#191028) deep recall has no tools unless `toolsAllow` is set
  ([vectorize-io/hindsight#6303](https://github.com/vectorize-io/hindsight/issues/6303)).
- **Provider runtime**: both register one. Here `memory.search` (v2) and `memory.get` resolve the
  bank from the caller's memory audience. The vendor runtime refuses search unless the bank
  depends on the agent alone, which excludes its default user and channel banking.
- **Banks**: the vendor plugin derives banks from config (`dynamicBankId`,
  `dynamicBankGranularity`, `bankIdPrefix`). Here the host-minted audience picks the bank:
  owner-private sessions use the agent bank, every other conversation gets its own
  `<bank>::conv::<hash>` bank.
- **Pre-compaction flush**: the vendor plugin has none and relies on per-turn retain. Here the
  tools-arm flush saves in-turn context through `hindsight_retain` before compaction, deduplicated
  per flush id with stable document ids.

The vendor plugin has features this one does not port; see [Limitations](#limitations).

## Security

Every request carries the bearer token (if set) and, for recall and retain, conversation text. The
plugin refuses a plain `http://` `hindsightApiUrl` to any host other than `localhost`, `127.0.0.0/8`
or `::1`, and config resolution fails with an error that names `allowInsecureHttp`. Prefer `https://`
or a loopback tunnel. To accept the risk on a trusted network, set `allowInsecureHttp: true`; the
plugin then warns at service start that the token and conversation text travel unencrypted.
Redirects are refused, so an https endpoint cannot forward a request body to plain http.

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md) for how and for supported
versions.

## Compatibility

### Supported OpenClaw versions

OpenClaw `>=2026.10.10` is supported. Older hosts lack APIs or session behavior the plugin needs
(see [Host API evidence](#host-api-evidence)). Memory needs the embedded agent runtime; CLI
runtimes such as `claude-cli` get none yet (see [Limitations](#limitations)).

`scripts/compat-matrix.sh` runs the live proof on the floor host (2026.10.10), the latest
OpenClaw release and OpenClaw `main`, on the embedded and `claude-cli` runtimes. See
[docs/compat-matrix.md](docs/compat-matrix.md) for how to run it and the expected cells.

### Host API evidence

`openclaw.install.minHostVersion` is `>=2026.10.10`; `openclaw.compat.pluginApi` is
`>=2026.10.1`. Evidence (published `openclaw` npm tarballs and release tags, checked 2026-11-03
and 2026-11-07):

- 2026.10.10 is the first release that records a dashboard session created by
  `sessions.create` as a direct chat (openclaw#181359). On 2026.10.1 through 2026.10.9 the host
  gives turns in such a session no memory audience ("root session ... has no durable chat
  type"), so the plugin neither recalls nor retains there: no memory is read or written in those
  sessions, including `openclaw agent --session-key` runs in them.
- 2026.9.36 has no tools-arm flush plan (`persistenceToolNames`) and no
  `assertMemoryAudienceCurrent`. 2026.10.1 is the first release with `recallToolNames`, the
  tools-arm `providerFlushPlanResolver` result and `memoryAudience` /
  `assertMemoryAudienceCurrent` on hook and tool contexts; every release through 2026.10.10
  keeps them. The package typechecks against the `openclaw@2026.10.10` types.
- `/learn`: no tagged release through 2026.10.10 has a memory learn hook. `main` had
  `learnToolNames` / `learnGuidanceBuilder` on the memory capability from openclaw#181879, and
  openclaw#191665 (2026-11-03) replaced them with `api.registerLearnContribution`. The plugin
  calls `registerLearnContribution` when the host has it, sets the two capability fields
  otherwise, and on tagged releases `/learn` simply does not route lessons here.
- openclaw#191028 (Memory Core registers `memory_search`/`memory_get` only when it owns the slot)
  is on `main` after 2026.10.10. On older hosts Memory Core's tools can appear next to ours when
  dreaming keeps it loaded.

## Releases and versioning

The plugin follows [semver](https://semver.org/). Before 1.0, a patch release (0.1.x) carries
fixes and security fixes only, and a minor release (0.x.0) may change config or behavior, with an
upgrade note in [CHANGELOG.md](CHANGELOG.md). Raising the minimum OpenClaw version is at least a
minor release. Each release has a CHANGELOG entry, a `vX.Y.Z` tag on GitHub and the same version
on npm and ClawHub. Only the latest release gets fixes. A version with a known security problem is
deprecated on npm once the fix ships, as 0.1.1 is.

## Limitations

- **No memory on CLI-backed runtimes.** OpenClaw's CLI runner (for example `claude-cli`)
  builds its plugin hook context without a memory audience (checked on 2026.11.1 and on main
  as of 2026-11-07). On those turns auto-recall, auto-retain and the `hindsight_*` tools are
  skipped with "this session has no memory audience". Use an embedded model route for agents
  that need memory, or keep `@vectorize-io/hindsight-openclaw` for them until the host passes
  the audience on CLI turns. The host bug is
  [openclaw/openclaw#194453](https://github.com/openclaw/openclaw/issues/194453); the fix,
  [openclaw/openclaw#194454](https://github.com/openclaw/openclaw/pull/194454), is in review and
  not merged as of 2026-11-07.
- **Sessions without a memory audience get no memory.** Recall, retain and the tools need a
  host-minted audience. The host mints one only for sessions whose root has a durable chat
  type: owner direct chats get the owner-private bank, groups and other senders get a
  conversation bank. Sessions created by `openclaw agent` from the CLI, older Control UI
  (dashboard) roots and some cron or subagent rows have none, so they read and write nothing
  (the vendor plugin fell back to the agent bank). This is intended per the SDK contract ("a
  session authority without an audience has no private or conversation grant"). Run
  `openclaw doctor --fix` to stamp older dashboard roots.
- **Workspace memory files are outside the bank split.** The audience split covers Hindsight
  banks only. An agent with file or shell tools can still write a fact to its workspace (for
  example the daily note `memory/YYYY-MM-DD.md` that the default `AGENTS.md` suggests for
  "remember this"), and any later session of that agent with the same tools can read it,
  group chats included. To keep owner facts out of group sessions, sandbox non-main sessions
  or deny `group:fs` and `group:runtime` for them in OpenClaw's tool policy.
- **Auto-retain does not re-check audience currency.** The host starts `agent_end` handlers
  without awaiting them and releases the run's audience when the attempt ends, so a currency
  check there would race and drop retains. The bank still comes from the host-minted audience of
  the run that produced the messages. Recall and the tools keep their checks.
- **`memory.search` through the provider runtime skips the plugin filters.** It is gated by the
  caller's audience (owner-private or conversation), not by `memoryMode`, `excludeProviders` or
  incognito session keys. Those filters apply to auto-recall, auto-retain and the tools only.
- `hindsightApiUrl` must not contain credentials, a query string or a fragment, even an empty
  one such as a trailing `?` or `#` (the parser rejects it). An unresolved SecretRef token, or a
  token sent over plain `http` to a non-loopback host, logs one warning at service start.
- Flush dedupe is per process; a restart mid-cycle can repeat a flush write, which the stable
  document id plus `update_mode: replace` turns into an overwrite.
- Conversation banks are never pruned by the plugin, and `openclaw memory forget` does not reach
  slot owners (no host seam yet).

Not ported from the vendor plugin: knowledge-base write tools (create, update, delete; the
read tools are opt-in, see above), tool-call retention
(`retainToolCalls`), `retainEveryNTurns` windows, the local Hindsight daemon, and
per-user/per-channel bank granularity (replaced by audience routing).

## Rollback

Both plugins are `kind: memory`; only the slot owner runs. To go back to the vendor plugin:

```sh
openclaw config set plugins.slots.memory hindsight-openclaw
# restore plugins.entries.active-memory.config.toolsAllow if you removed it
openclaw gateway restart
```

Owner-private memory is in the same banks either way, so nothing is lost. Conversation banks
(`<bank>::conv::<hash>`) are only read by this plugin.

## Development

```sh
npm ci
npm run typecheck && npm run build && npm test && npm run lint && npm run format:check
npm pack --dry-run   # dist/*.js, openclaw.plugin.json, README, CHANGELOG, LICENSE only
```

`scripts/live-proof.sh` runs one OpenClaw host (npm version, git ref or path) on the embedded
or `claude-cli` runtime through a throwaway Gateway and real turns, and prints a PASS/FAIL
table. `scripts/compat-matrix.sh` runs it for the floor host, the latest release and `main`.
See [docs/compat-matrix.md](docs/compat-matrix.md), including the expected `claude-cli` cells
and an optional nightly launchd schedule.
