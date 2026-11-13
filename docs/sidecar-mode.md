# Choose a mode: replace or sidecar

The plugin runs in one of two roles, set by `slotMode` (default `auto`, which follows
`plugins.slots.memory`):

- **replace**: `plugins.slots.memory` is `hindsight-native`. The plugin owns the memory slot and
  replaces memory-core: `memory_search`, `memory_get`, `memory.status`, Active Memory recall, the
  pre-compaction flush and `/learn` all go to Hindsight.
- **sidecar**: the slot stays with memory-core (or another owner). The plugin adds auto-recall,
  auto-retain and the `hindsight_*` tools beside it, and never registers the memory runtime, so it
  never shadows `memory_search` or `memory_get`. Optional: Hindsight hits inside `memory_search`
  (`corpusSupplement`), workspace memory files retained into Hindsight (`memoryFileSync`).

## What each mode has and loses

|                                                                     | replace                                                               | sidecar                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `memory_search`, `memory_get`, Memory page, `openclaw memory`       | Hindsight (provider runtime)                                          | memory-core: MEMORY.md, USER.md, memory/*.md (and session transcripts if indexed)               |
| Auto-recall, auto-retain, `hindsight_*` tools, audience-split banks | yes                                                                   | yes                                                                                             |
| Active Memory recall                                                | Hindsight's `hindsight_recall`/`hindsight_reflect` by default         | memory-core's tools by default; add `hindsight_recall` to its `toolsAllow` to include Hindsight |
| Pre-compaction flush, `/learn`                                      | Hindsight (`hindsight_retain`)                                        | memory-core (curated files)                                                                     |
| Workspace memory files searchable                                   | only through `memoryFileSync` (or the external sync script)           | natively by memory-core; `memoryFileSync` optional                                              |
| Dreaming, `openclaw memory forget`, Memory page                     | memory-core as dreaming sidecar only; forget does not reach Hindsight | memory-core in full; `openclaw hindsight forget` for Hindsight                                  |
| Extra per-turn cost                                                 | none                                                                  | about 1265 cached prompt tokens, memory-core indexing                                           |
| Host requirement                                                    | OpenClaw 2026.10.10+                                                  | a host with [openclaw#198445](https://github.com/openclaw/openclaw/issues/198445)               |

What replace loses: memory-core's file index and its tools (unless the files are synced into
Hindsight), the Memory page and most of the `openclaw memory` CLI. What sidecar loses: Hindsight as
the provider behind `memory_search` (only an opt-in supplement for the main session), Active Memory
on Hindsight by default, and the flush and `/learn` writing to Hindsight.

## Measured cost (2026-11-13)

Scratch hosts on OpenClaw 2026.11.3, Hindsight 1.2.1 on loopback, tokens counted with Anthropic
`count_tokens` (claude-haiku-5-5). Method and scripts: kept with the measurement notes.

| Item                                                                    |      Tokens | Replace | Sidecar               |
| ----------------------------------------------------------------------- | ----------: | ------- | --------------------- |
| `hindsight_recall`, `hindsight_reflect`, `hindsight_retain` definitions |         843 | yes     | yes                   |
| `memory_search` + `memory_get` definitions                              |         890 | no      | yes                   |
| memory-core "Memory Recall" prompt section                              |         375 | no      | yes                   |
| Auto-recall block, median / p95 of 20 queries                           | 2227 / 3800 | yes     | yes, unless it yields |
| Active Memory summary at its 220-character cap                          |          97 | if on   | if on                 |

- Sidecar adds about 1265 tokens, all in the cached prompt prefix (tool definitions and system
  prompt). The uncached part per turn is the auto-recall block in both modes.
- Auto-recall latency: median 2.1 s, p95 3.5 s (budget `mid`), bounded by `recallTimeoutMs`.
  memory-core `memory_search` from the CLI: about 3.3 s cold (warm in-gateway not measured).
- memory-core indexing of a workspace sized like a busy one (71 files, 518 KB, 532 chunks) with
  a LAN embedding server: 13 s of local CPU and about 4 minutes of embedder time for a full
  reindex, 910 MB peak RSS in the CLI; a one-file change reindexes in seconds.

### Double injection

In sidecar mode two systems can inject memory before a reply: this plugin's auto-recall block and
Active Memory's summary. With `activeMemoryYield: true` the plugin skips its own block on a turn
where Active Memory will visibly recall from Hindsight: the active-memory plugin is enabled and
allowed, not paused, `mode` is `always`, the agent is in its `agents`, its `toolsAllow` names
`hindsight_recall`, and the turn's chat type and chat id pass `allowedChatTypes` (default direct
only), `allowedChatIds` and `deniedChatIds`. In every other case (mode `escalate`, the default, or
`off`, group chats, threads, unknown chat types) it injects as in replace mode. Active Memory's
per-session toggle and its model resolution are not visible to this plugin, which is why the yield
is opt-in: with it on, a session where Active Memory was turned off with its own toggle gets no
memory block. Active Memory's summary is small (under 100 tokens) but it runs its own recall model
call before each reply. A sidecar's recall tools reach Active Memory only through an explicit
`toolsAllow` today; [openclaw#198447](https://github.com/openclaw/openclaw/issues/198447) proposes adding them to its default.

## Set up sidecar mode

Sidecar mode needs an OpenClaw host with the operator-approved memory sidecar setting proposed in
[openclaw#198445](https://github.com/openclaw/openclaw/issues/198445). Without it, OpenClaw (checked on 2026.11.3 and on main of
2026-11-13) disables every `kind: "memory"` plugin that does not own `plugins.slots.memory`, before
it registers anything; the plugin then does not run at all. On such a host use replace mode.

On a host with that setting:

```sh
openclaw config set plugins.slots.memory memory-core
openclaw config set plugins.entries.hindsight-native.memory.sidecar true
openclaw config set plugins.entries.hindsight-native.config.slotMode sidecar
openclaw config set plugins.entries.hindsight-native.hooks.allowConversationAccess true
# optional: Active Memory recalls from both stores, and the plugin skips its own block
openclaw config set plugins.entries.active-memory.config.mode always
openclaw config set plugins.entries.active-memory.config.toolsAllow '["memory_search","memory_get","hindsight_recall"]'
openclaw config set plugins.entries.hindsight-native.config.activeMemoryYield true
openclaw gateway restart
openclaw hindsight doctor   # PASS memory slot: sidecar beside "memory-core"
```

If the host refuses the memory capability while `plugins.slots.memory` names this plugin or
`slotMode` is `replace`, the Gateway logs an error (`host refused the memory capability ... serves
no memory runtime`) and `openclaw hindsight doctor` fails the slot check; the plugin does not
quietly turn into a sidecar.

Testing only: `scripts/sidecar-variant.mjs` rewrites a packed copy without the manifest `kind`, so
the compat lane (`live-proof.sh --slot sidecar`) can exercise sidecar mode on released hosts. It is
not an install route: that build can never own the slot and is not published.

Related upstream: [openclaw#198445](https://github.com/openclaw/openclaw/issues/198445) (sidecar setting), [openclaw#198447](https://github.com/openclaw/openclaw/issues/198447)
(Active Memory recall tools from a sidecar), [openclaw#198448](https://github.com/openclaw/openclaw/issues/198448) (named supplement
corpora instead of `wiki`), [openclaw#190720](https://github.com/openclaw/openclaw/issues/190720) (`openclaw memory forget` reaching
memory plugins).

## Corpus supplement (`corpusSupplement`)

With `corpusSupplement: true` (sidecar only), `memory_search` with `corpus=wiki` or `corpus=all`
also returns Hindsight hits from the agent's owner bank, labeled `source: hindsight` and
`provenanceLabel: Hindsight bank <id>`, and `memory_get` reads one back by its `hindsight/<id>`
path. Two host limits:

- The host files every supplement under the corpus name `wiki`; a plain `memory_search` (no
  `corpus`) does not search supplements ([openclaw#198448](https://github.com/openclaw/openclaw/issues/198448)).
- The host passes a supplement no memory audience, so it cannot tell the owner's private chat from
  a group. The supplement therefore answers only sessions whose key matches
  `corpusSupplementSessionPatterns` (default `agent:*:main`), never sandboxed, incognito or
  excluded sessions, and only from the owner bank. With `session.dmScope: main`, direct messages
  from other senders share `agent:<id>:main`; use per-peer DM scopes before turning this on.

## Workspace memory files (`memoryFileSync`)

With `memoryFileSync: true` the gateway retains MEMORY.md, USER.md and every `memory/**/*.md` of
the synced agents (`memoryFileSyncAgents`, default the default agent) into the agent's owner bank,
one document per file, every `memoryFileSyncIntervalMs` (default 10 minutes, first pass 30 s after
start). Only changed files are sent (`update_mode: replace`); a deleted file's document is
deleted. Skipped: `memory/dreaming/**`, hidden files and folders, empty files, session stubs and
files over 1 MB. `openclaw hindsight sync-memory-files [--agent <id>] [--dry-run]` runs one pass
from the CLI.

Moving from `hindsight-memory-sync.sh`: the document ids (workspace-relative path), the
`source:memory-file` tag, the metadata and the replace mode are the same, so the plugin replaces
the script's documents in place and never stores a file twice. Run once with
`--import-legacy-state ~/.openclaw/state/hindsight-memory-sync.tsv` so unchanged files are not
re-extracted, then remove the script's MEMORY.md/USER.md/memory part from its schedule. The import
keeps only paths the plugin scans (MEMORY.md, USER.md, `memory/**.md`), and the plugin never
deletes a document outside that set. The script's sub-agent folders (`worker/memory/...`,
`lane-blog/memory/...` and the like) are not covered: their documents stay as the script left them,
so keep the script for them (`AGENT_DIRS`) or list those agents in `memoryFileSyncAgents`, which
sends their files to each agent's own owner bank under ids without the folder prefix. Checked
read-only against the live script state of 2026-11-13: 52 of 68 entries imported, 16 sub-agent
entries skipped, 0 deletes, MEMORY.md re-sent once (the script cuts lines out of it, the plugin
does not).

## Export (`openclaw hindsight export`)

`openclaw hindsight export --out <dir> [--agent <id> | --bank <id>] [--types world,experience,observation] [--mental-models] [--max-items <n>] [--overwrite]`
writes `<dir>/<bank>/INDEX.md`, `facts.md`, `experiences.md`, `observations.md` and, with
`--mental-models`, one file per mental model. One line per memory, oldest first, with date,
document id, tags and memory id. Read only.
