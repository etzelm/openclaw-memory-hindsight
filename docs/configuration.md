# Configuration details

The README's Configuration table lists every key with its default. This page explains the keys that need more than a line.

## Recall, sessions and the breaker

Per-agent overrides: `agents` maps an agent id (normalized like `agentBankMap` keys) to any of
`autoRecall`, `recallTimeoutMs`, `recallTopK`, `recallMinScore`, `recallQueryShaping` and
`recallTypes`, with the same values as the global keys. On that agent's turns the entry replaces the
global value; an agent without an entry, and an empty map, behave as before. Other keys (bank
selection included: the bank follows the memory audience) are refused at load.

```json
"agents": { "main": { "recallTimeoutMs": 2000, "recallTopK": 5 }, "wb-review": { "autoRecall": false } }
```

Latency levers: `recallSkipEntities` (on by default) sends `include: {entities: null}` on
auto-recall, so Hindsight skips the entity observations the plugin never reads (smaller responses,
same results in our A/B); `recallSkipEntities: false` sends the 0.8.0 request. The other two are
off by default. `recallEarlyStart` (experimental) starts the recall on `message_received` for a
session whose last turn already recalled. It is experimental because it has not yet run on a live
Gateway, and its behavior may still change. `before_prompt_build` uses it only when the bank and the
request are the same, it answered, and it is younger than `recallTimeoutMs` plus 5 s (the run is
compared too, but only when both hooks carry a run id); otherwise the turn recalls as usual. A
`hindsight_retain` in the session drops it. It saves the time between message arrival and prompt
build, not the server's own time; the first turn of each session after a restart is not started
early. Every message the session receives is sent as a recall query, group messages the agent does
not answer included. An early request that timed out is not sent again: the turn counts the
timeout toward the circuit breaker and gets the stale block or nothing, so a hung server costs a
turn at most one `recallTimeoutMs`. One that failed fast (network error, 5xx) is sent again once,
and only that request counts. An early answer counts as an answer only when no outage was recorded
after it arrived. An early request no turn takes never counts, and none is started while the
breaker is open. `recallStaleOnTimeout` trades freshness for
availability: a turn that timed out, or that the open breaker skipped, gets the session's previous
block if it is younger than the value and was recalled from the same bank with the same request
settings (tag filter, score floor, types, budget). `session_end` and a service stop forget it.

Session patterns: `*` matches any run of characters except `:`, `**` matches anything including
`:`, everything else is literal. Patterns match the trimmed session key. `ignoreSessionPatterns`
sessions get no auto-recall, no auto-retain and no `hindsight_*` tools. `recallOnlySessionPatterns`
sessions (for example `agent:dev:subagent:**`) get auto-recall, `hindsight_recall`,
`hindsight_reflect` and, with `knowledgeReadTools`, the knowledge-base read tools, even when
`skipOperationalSessions` would skip them, but never auto-retain and no `hindsight_retain`.
`excludeProviders`, `temp:` and incognito sessions win over both lists, and ignore wins over
recall-only. A pattern never selects a bank; the bank still comes from the memory audience.

Fixed values (not configurable): recall max tokens 1024, query cap 800 characters,
`hindsight_recall` timeout 10 s, retain and reflect timeout 30 s, memory get and knowledge-base tool timeout 10 s
(each combined with the host's abort signal when there is one), retained roles user and
assistant, JSON transcript format, recall injected before the user message (outside the system
prompt, so the cached prefix stays stable). A recall, reflect or memory-get response body over
4 MiB fails. Knowledge-base tool caps: a response body over 1 MiB fails; a page shows its first 32000 characters, then `(truncated, N more characters)`;
the tree shows 500 entries, then `(truncated, N more entries)`; search shows at most 50 hits
with snippets cut at 500 characters and names and ids at 200.

On claude-cli sessions, auto-recall and auto-retain need a host that gives CLI hooks a memory
audience (openclaw/openclaw#194453, fixed on upstream main since 2026-11-09), and the
`hindsight_*` tools also need one that passes that audience when it lists MCP tools
(openclaw/openclaw#197274, merged 2026-11-11). A main build from between those dates gets
auto-recall and auto-retain but no `hindsight_*` tools; released builds get neither (see
[Limitations](../README.md#limitations)). `listToolsWithoutAudience` (0.5.0) is deprecated and ignored since
0.6.0; remove it from your config.

With `recallCacheTtlMs` set, a `hindsight_retain` call drops the calling session's cached
recall, so its next turn recalls fresh. Hindsight extracts memories in the background, so that
recall can miss a memory Hindsight has not processed yet, and its result is cached like any
other. The new memory shows up once Hindsight has processed it and that cache entry has expired.

Recall cap and floor: both are off by default, so every result Hindsight returns is injected.
`recallTopK` keeps the first N results (Hindsight ranks best first) and is applied at injection,
so a cached recall follows a live change. `recallMinScore` is sent as Hindsight's
`min_scores.final`; Hindsight documents its reranker scores as not calibrated across queries, so
prefer the cap. Neither applies to `hindsight_recall`. Pick values with an eval run; see
[docs/recall-ab.md](recall-ab.md).

Recall tag filter: `recallTagGroups` is passed through as Hindsight's recall `tag_groups` (groups
are AND-ed; each is a leaf `{tags, match, resolve}` or `{and: [...]}`, `{or: [...]}`,
`{not: ...}`, the Hindsight 1.2.1 shape, at most 32 groups per list and 8 levels deep). It applies
to auto-recall and `hindsight_recall`, not to the provider runtime's search. When the recall query
matches `recallHistoryPattern` (case-insensitive), that recall runs without the filter. Example
that keeps status units ("waiting on CI") out of recall unless the question asks about history:

```json
"recallTagGroups": [{ "not": { "tags": ["kind:status"], "match": "any_strict" } }],
"recallHistoryPattern": "\\b(?:history|timeline|status|progress|what happened|when did|so far|previous|earlier|changed|still)\\b"
```

The pattern runs on the first 800 characters of every recall query, on the Gateway's event loop,
so since 0.9.0 it must fit a small grammar that cannot backtrack: literal text, escaped
punctuation (`\.`, `\(`, `\|` and the like), `\b`, `\s`, `\d` and `\w` as single atoms, `^`, `$`,
`|`, and at most one `(?:a|b)` group per `|` alternative, not nested and not quantified. Nothing
else: no `*`, `+`, `?` or `{n}`, no character class `[...]`, no `.`, no capture group, no
backreference, lookahead or lookbehind. A pattern outside the grammar stops the config from
loading, with an error naming the first bad token and its position, like
`recallHistoryPattern: "?" at character 6 is a quantifier`. Write `colou?r` as `colour|color`
and `(a|b)` as `(?:a|b)`. A pattern that matches the empty string, such as one with an empty `|`
alternative (`history|timeline|`), is refused too: it would match every query. At most 500
characters.

With no quantifier, each alternative of the group is tried once per start position with the
rest of its `|` alternative, so the 500-character cap sets a fixed ceiling. Measured on a Mac
Studio (node 24) on 800-character queries: the example above takes under 0.01 ms, and the slowest
accepted pattern we found (one group of 140 `a` alternatives, then 210 `a` and `\b`, 495
characters) about 3.7 ms once warm and 4.6 ms on the first query after load. A new regular
expression is slow on its first run (about 19 ms for that pattern); config load pays that once,
on the empty string, when it checks the pattern does not match it.

`any_strict` inside `not` keeps untagged memories, which matters because Hindsight observations
carry no tags. A filter only helps if the tags exist at retain time; check the bank before turning
it on, and measure it with an eval run, since a filter can hide the answer.

Recall circuit breaker: auto-recall waits on the reply path, so a slow or unreachable Hindsight
would cost every turn up to `recallTimeoutMs`. After 3 auto-recalls in a row end in a timeout, a
network error or an HTTP 5xx, auto-recall skips for 60 s without sending a request (one warning in
the log), then lets one probe through while other turns keep skipping. Any answer to the probe
closes the breaker (`auto-recall resumed` in the log); another failure pauses it for 60 s more. A
4xx, a missing bank or an empty result never counts, and a live cached recall (and, with
`recallStaleOnTimeout`, a young stale block) is still served while the breaker is open. The breaker
is global (one server), resets when `hindsightApiUrl` changes or the service restarts, and does not
apply to the `hindsight_*` tools. Timeouts are judged by the global `recallTimeoutMs`: a timeout of
an agent whose `agents` entry sets a shorter `recallTimeoutMs` does not count (it shows that the
agent's budget is tight, not that Hindsight is down), so one agent's tight timeout cannot pause
auto-recall for the others. That agent's network errors and 5xx answers still count. If only such
agents are active, the breaker does not open on a hang; each of their turns still costs at most
their own shorter timeout. The global value is read when the request is sent. When such an agent
carries the probe after a cool-down and it times out under the agent's timeout, the plugin frees
the probe slot without a new cool-down, so the next turn probes again.

## Knowledge-base read tools

With `knowledgeReadTools: true` the agent also gets three read-only tools over Hindsight's
knowledge pages (documents Hindsight writes and refreshes from memories), under the same names as
the vendor plugin:

- `hindsight_get_knowledge_base_tree`: folders and pages with page ids and a stale mark
  (`GET .../pages/tree`).
- `hindsight_search_knowledge_base`: pages matching a query, with a snippet (`query`, optional
  `limit` clamped to 1-50; `GET .../pages/search`).
- `hindsight_get_knowledge_page`: one page as markdown by `page_id`
  (`GET .../pages/<id>`).

Hindsight 1.2.1 moved these routes from `.../knowledge-base/*` to `.../pages/*` and deprecated the
old ones. The plugin reads `/pages/*` first. When the server answers a new route with a route 404
(`{"detail":"Not Found"}`, an older server), the client switches to `/knowledge-base/*` for the
rest of the process, so an older server costs one extra request. A missing bank or page does not
trigger the switch.

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

## Prompt directives

Hindsight directives are hard rules stored in a bank; Hindsight injects them into every reflect.
Recall and auto-recall do not see them. With `promptDirectives: true` the plugin also lists the
owner bank's directives in the system prompt (the memory prompt section), so the agent follows
them on every turn:

- Only active directives without tags. A tagged directive applies to a reflect with a matching
  scope, which a system prompt does not have.
- Highest priority first, then by name; at most 20, each cut at 500 characters.
- Fetched at service start for `main` and every agent named in `agents` or `agentBankMap`, and
  for other agents on their first prompt build. After 10 minutes the next build starts one
  background refresh and keeps serving the cached list until it lands. A turn never waits for
  the request, and the prompt text changes only when the directives do, so the cached prompt
  prefix stays stable. A failed refresh keeps the last list and logs a warning.
- Shown in every session of the agent, group chats included. Keep private data out of
  directives.
- Works with or without `memoryPromptSection`; with both, the directives come after the memory
  section. Turning it on or off needs a gateway restart.

Manage directives with `openclaw hindsight directives list | add | rm` (see the README).

## Mapping from `@vectorize-io/hindsight-openclaw`

| Vendor key                                                                                                                                                                                                                                                                                                        | Here                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hindsightApiUrl`, `hindsightApiToken`, `memoryMode`, `autoRecall`, `autoRetain`, `recallBudget`, `recallTypes`, `preferObservations`, `recallPromptPreamble`, `retainMission`, `retainContext`, `retainTags`, `excludeProviders`, `skipOperationalSessions`, `agentBankMap`, `recallTimeoutMs`                   | Same key, same meaning                                                                                    |
| `dynamicBankId`, `dynamicBankGranularity`, `bankIdPrefix`                                                                                                                                                                                                                                                         | Replaced by audience routing: owner bank = agent id (or `agentBankMap`), conversations get their own bank |
| `retainRoles`, `recallRoles`, `retainFormat`, `recallMaxTokens`, `recallMaxQueryChars`, `recallInjectionPosition`, `retainSource`                                                                                                                                                                                 | Fixed values (see above)                                                                                  |
| `retainQueueMaxAgeMs`                                                                                                                                                                                                                                                                                             | Same key; must be a positive number of ms (the vendor's `-1` for no limit is rejected)                    |
| `retainToolCalls`, `retainEveryNTurns`, `retainOverlapTurns`, `recallContextTurns`, `retainQueuePath`, `retainQueueFlushIntervalMs`, `enableKnowledgeTools`, `allowKnowledgeDelete`, daemon keys (`apiPort`, `embedPort`, `embedVersion`, `daemonIdleTimeout`), `llm*`, `debug*`, `log*`, `skipStatelessSessions` | Not supported; remove them (unknown keys are rejected)                                                    |
