# @etzelm/openclaw-memory-hindsight

A native [Hindsight](https://github.com/vectorize-io/hindsight) memory engine for
[OpenClaw](https://docs.openclaw.ai), packaged as a third-party plugin (plugin id
`hindsight-native`). It owns the memory slot and plugs Hindsight into the host's memory
contracts instead of only hooking prompts:

- **Provider runtime**: `memory.status`, `memory.search` (v2) and `memory.get` in the Gateway,
  CLI and Control UI read Hindsight through the host's audience-checked provider API.
- **Auto-recall** before each prompt and **auto-retain** of each finished run (one document per
  run, replaced on re-delivery).
- **Agent tools** `hindsight_retain`, `hindsight_recall`, `hindsight_reflect`.
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

Needs OpenClaw 2026.10.1 or newer and a reachable Hindsight API.

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
openclaw plugins install npm-pack:./etzelm-openclaw-memory-hindsight-0.1.1.tgz --force --accept-capabilities
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

| Key                         | Default           | Meaning                                                                                               |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `hindsightApiUrl`           | required          | Base URL of the Hindsight API                                                                         |
| `hindsightApiToken`         | none              | Bearer token; use a SecretRef                                                                         |
| `memoryMode`                | `hybrid`          | `hybrid`: auto-recall and tools; `context`: auto-recall only, no tools, no flush; `tools`: tools only |
| `autoRecall` / `autoRetain` | `true`            | Turn the hooks on or off                                                                              |
| `recallBudget`              | `mid`             | Hindsight recall budget: `low`, `mid`, `high`                                                         |
| `recallTypes`               | all               | Subset of `world`, `experience`, `observation`                                                        |
| `preferObservations`        | Hindsight default | Prefer consolidated observations in recall                                                            |
| `recallPromptPreamble`      | built in          | Text above the injected `<hindsight_memories>` block                                                  |
| `retainMission`             | none              | Applied to each bank once before its first write                                                      |
| `retainContext`             | built in          | Context string sent with each retain                                                                  |
| `excludeProviders`          | `[]`              | Message providers that never recall or retain (for example `heartbeat`)                               |
| `skipOperationalSessions`   | `true`            | Skip cron, heartbeat and subagent sessions                                                            |
| `agentBankMap`              | `{}`              | Agent id to bank id, so several agents share one owner bank                                           |
| `allowInsecureHttp`         | `false`           | Allow plain http to a non-loopback `hindsightApiUrl` (token and conversation text unencrypted)        |

Fixed values (not configurable): recall max tokens 1024, query cap 800 characters, recall
timeout 10 s, retain and reflect timeout 30 s, memory get timeout 10 s (each combined with the
host's abort signal when there is one), retained roles user and assistant, JSON transcript format, recall injected before
the user message (outside the system prompt, so the cached prefix stays stable).

Config changes apply without a restart: the plugin re-reads its entry from the host's current
config snapshot (`api.runtime.config.current()`), falling back to the register-time
`api.pluginConfig`.

### Mapping from `@vectorize-io/hindsight-openclaw`

| Vendor key                                                                                                                                                                                                                                                                                     | Here                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hindsightApiUrl`, `hindsightApiToken`, `memoryMode`, `autoRecall`, `autoRetain`, `recallBudget`, `recallTypes`, `preferObservations`, `recallPromptPreamble`, `retainMission`, `retainContext`, `excludeProviders`, `skipOperationalSessions`, `agentBankMap`                                 | Same key, same meaning                                                                                    |
| `dynamicBankId`, `dynamicBankGranularity`, `bankIdPrefix`                                                                                                                                                                                                                                      | Replaced by audience routing: owner bank = agent id (or `agentBankMap`), conversations get their own bank |
| `retainRoles`, `recallRoles`, `retainFormat`, `recallMaxTokens`, `recallMaxQueryChars`, `recallTimeoutMs`, `recallInjectionPosition`, `retainSource`                                                                                                                                           | Fixed values (see above)                                                                                  |
| `retainToolCalls`, `retainEveryNTurns`, `retainOverlapTurns`, `recallContextTurns`, `retainTags`, `retainQueue*`, `enableKnowledgeTools`, `allowKnowledgeDelete`, daemon keys (`apiPort`, `embedPort`, `embedVersion`, `daemonIdleTimeout`), `llm*`, `debug*`, `log*`, `skipStatelessSessions` | Not supported; remove them (unknown keys are rejected)                                                    |

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

## Compatibility

`openclaw.install.minHostVersion` and `openclaw.compat.pluginApi` are `>=2026.10.1`. Evidence
(published `openclaw` npm tarballs and release tags, checked 2026-11-03):

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

## Limitations

- **No memory on CLI-backed runtimes.** OpenClaw's CLI runner (for example `claude-cli`)
  builds its plugin hook context without a memory audience (checked on 2026.11.1 and on main
  as of 2026-11-07). On those turns auto-recall, auto-retain and the `hindsight_*` tools are
  skipped with "this session has no memory audience". Use an embedded model route for agents
  that need memory, or keep `@vectorize-io/hindsight-openclaw` for them until the host passes
  the audience on CLI turns.
- **Sessions without a memory audience get no memory.** Recall, retain and the tools need a
  host-minted audience. The host mints one only for sessions whose root has a durable chat
  type: owner direct chats get the owner-private bank, groups and other senders get a
  conversation bank. Sessions created by `openclaw agent` from the CLI, older Control UI
  (dashboard) roots and some cron or subagent rows have none, so they read and write nothing
  (the vendor plugin fell back to the agent bank). This is intended per the SDK contract ("a
  session authority without an audience has no private or conversation grant"). Run
  `openclaw doctor --fix` to stamp older dashboard roots.
- **Auto-retain does not re-check audience currency.** The host starts `agent_end` handlers
  without awaiting them and releases the run's audience when the attempt ends, so a currency
  check there would race and drop retains. The bank still comes from the host-minted audience of
  the run that produced the messages. Recall and the tools keep their checks.
- **`memory.search` through the provider runtime skips the plugin filters.** It is gated by the
  caller's audience (owner-private or conversation), not by `memoryMode`, `excludeProviders` or
  incognito session keys. Those filters apply to auto-recall, auto-retain and the tools only.
- `hindsightApiUrl` must not contain credentials, a query string or a fragment (the parser
  rejects it). An unresolved SecretRef token, or a token sent over plain `http` to a
  non-loopback host, logs one warning at service start.
- Flush dedupe is per process; a restart mid-cycle can repeat a flush write, which the stable
  document id plus `update_mode: replace` turns into an overwrite.
- Conversation banks are never pruned by the plugin, and `openclaw memory forget` does not reach
  slot owners (no host seam yet).

Not ported from the vendor plugin: knowledge-base tools, tool-call retention
(`retainToolCalls`), `retainEveryNTurns` windows, the offline retain queue, the local Hindsight
daemon, and per-user/per-channel bank granularity (replaced by audience routing).

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

`scripts/live-proof.sh` runs the end-to-end proof against a throwaway Gateway; see
[docs/proof/2026-11-03.md](docs/proof/2026-11-03.md).
