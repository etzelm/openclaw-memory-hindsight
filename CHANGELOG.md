# Changelog

## 0.6.0 (2026-11-11)

### Upgrade notes

- Needs an OpenClaw build with openclaw/openclaw#197274 (merged 2026-11-11) for `hindsight_*`
  tools on claude-cli sessions. That host change passes the turn's memory audience when it lists
  claude-cli MCP tools, so the tools list through the normal audience route. On an older
  2026.11.x host, claude-cli sessions keep auto-recall but lose the `hindsight_*` tools; stay on
  0.5.0 there.
- `listToolsWithoutAudience` is deprecated and ignored. The key still validates, so an existing
  config keeps loading; remove it. A later major release rejects it.

### Removed

- The `listToolsWithoutAudience` workaround from 0.5.0: a tool context without a memory audience
  gets no `hindsight_*` tools again, whatever the config says.

## 0.5.0 (2026-11-10)

### Upgrade notes

- No config change is needed. All new keys default off.
- The auto-recall query strip is always on. Recall queries change slightly, because host
  boilerplate is no longer sent.
- The config schema rejects unknown keys. A config that uses `listToolsWithoutAudience`,
  `ignoreSessionPatterns`, `recallOnlySessionPatterns`, `recallCacheTtlMs` or
  `recallFollowupMaxWords` fails validation on 0.3.0 and 0.4.0. Remove those keys before a
  downgrade.

### Added

- `listToolsWithoutAudience` (default off): list the `hindsight_*` tools for agent sessions whose
  tool list the host builds without a memory audience. OpenClaw 2026.11.x does this for claude-cli
  turns (MCP tool projection), so those sessions had no Hindsight tools. A call still resolves its
  bank only from the host-minted audience and fails without one.
- `ignoreSessionPatterns` and `recallOnlySessionPatterns` (session-key globs, both default `[]`).
  An ignored session gets no auto-recall, no auto-retain and no `hindsight_*` tools. A
  recall-only session gets auto-recall and the read tools (`hindsight_recall`,
  `hindsight_reflect`, and the knowledge-base read tools when `knowledgeReadTools` is on) even if
  `skipOperationalSessions` would skip it, but never retains. Ignore wins over recall-only;
  `excludeProviders`, `temp:` and incognito sessions still win over both. Patterns never select
  a bank. See README, Configuration.
- Auto-recall drops host boilerplate from the query (inter-session header, routed-by line,
  messages-recorded banner, subagent context lines, cron tag, CLI-resumed and automation-repair
  notices); a message that is only boilerplate no longer triggers a recall.
- `recallCacheTtlMs` (default `0`, off): per-session cache of auto-recall results, keyed by
  session, bank and query. Never shared across sessions or banks.
- `recallFollowupMaxWords` (default `0`, off): short follow-ups skip auto-recall while the session
  has a recent recall that returned memories, and otherwise recall with the previous user message
  added to the query. An empty recall never enables the skip. Debug log tags each auto-recall
  `fresh`, `cached`, `followup-skip` or `followup-expanded`.

## 0.4.0 (2026-11-09)

### Upgrade notes

- No config change is needed. The plugin now serves Prometheus metrics at
  `GET /plugins/hindsight-native/metrics` on the Gateway port. To collect them, add a scrape job
  for that path that sends a Gateway token with `operator.read`. Without a scrape job nothing
  changes.

### Added

- Gateway metrics: Prometheus text at `GET /plugins/hindsight-native/metrics` on the Gateway
  port (Gateway auth, `operator.read`). Auto-recall and auto-retain counts by outcome with
  latency histograms, and retain queue depth, replays and drops. Labels are `agent` and `bank`
  plus fixed outcome and reason values; conversation banks share one label per owner bank.
  See README, Gateway metrics.

## 0.3.0 (2026-11-08)

### Upgrade notes

- No config change is needed. The new `knowledgeReadTools` key is off by default, so the
  registered tools are the same as in 0.2.0 unless you turn it on.
- The retain queue file format is unchanged. See Downgrade notes before going back to 0.2.0.
- Recalled memories that contain text shaped like the `<hindsight_memories>` wrapper or
  OpenClaw's internal-context delimiters are now escaped before they reach the model.

### Security

- Recall wrapper: `<hindsight_memories>` and `</hindsight_memories>` tags inside recalled text
  are neutralized in more forms than the exact literal: any case, whitespace inside the tag,
  attributes, self-closing, a missing `>`, `-` for `_`, invisible characters, accents, common
  Cyrillic/Greek lookalike letters, fullwidth letters and `<` lookalikes (everything Unicode
  confusables.txt maps to `<`, plus angle brackets).
- OpenClaw prompt delimiters in recalled text are escaped: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`
  and `<<<END_OPENCLAW_INTERNAL_CONTEXT>>>` (variants in case, spacing or invisible characters
  too), `OpenClaw runtime context:`, `End OpenClaw runtime context.`,
  `OpenClaw runtime context (internal):`, the runtime-context notice line and the legacy
  carrier prefaces that precede it. Prose that mentions OpenClaw runtime context is unchanged.

### Added

- `scripts/compat-matrix.sh`: host keyword `beta` (npm dist-tag `beta`), comma-separated
  `--hosts` and `--runtimes`, and matrix rows in the requested host order.
- `knowledgeReadTools` (default off): opt-in read-only knowledge-base tools
  `hindsight_get_knowledge_base_tree`, `hindsight_search_knowledge_base` and
  `hindsight_get_knowledge_page`, with the vendor plugin's names. They read the same
  audience-routed bank as `hindsight_recall`; a missing bank reads as empty. Off, the
  registered tool set is unchanged; the manifest's static `contracts.tools` still lists the
  three names. Output is capped (page 32000 characters, tree 500 entries, search 50 hits)
  and a knowledge-base response body over 1 MiB fails.

### Changed

- CI enforces a vitest coverage floor (`npm run test:coverage`, `@vitest/coverage-v8`) at
  lines 94%, branches 86%, functions 95%, statements 93% (develop's measured coverage minus a
  margin). GitLab shows the percentage on MRs and keeps the report as an artifact. Both pack
  checks also reject `coverage/` (the `files` allowlist already kept it out of the pack).
- `scripts/launchd/hs-compat-nightly.plist.example`: `LimitLoadToSessionType` Aqua and
  Background, so it also loads in the `user/<uid>` domain; the docs cover installing it for an
  account without a GUI session.

### Fixes

- `scripts/live-proof.sh`: X2 now searches every Claude Code project dir that appeared during
  the run, and every file under the projects dir modified during it, for the code word, not
  only names with `hs-live-proof`. Dirs it did not predict are counted and never deleted;
  symlinks there are not followed.
- `scripts/compat-matrix.sh`: an empty `--hosts` or `--runtimes` list is refused (exit 2).
- `scripts/compat-nightly.sh`: one run at a time per `WORK_ROOT`; a lock is stale when its pid
  does not run the same script path or it is older than 12 h.
- Config: `hindsightApiUrl` with a bare trailing `?` or `#` is rejected like a non-empty query
  string or fragment.
- Retain queue: a retain is no longer lost when the file cannot be rewritten but can still be
  appended to. The new copy is appended instead (load keeps the newest copy per document), and the
  32 MiB bound still applies to appends, so the file cannot grow without bound. A failed replay
  save is retried by the next one.
- Retain queue: after a crash between replay's batched writes, load keeps only the newest copy
  per bank and document id, and replay always sends `update_mode: replace` with the item's
  document id.
- Auto-retain no longer loses a turn when the host continues a run after a transient model
  retry. The second `agent_end` for the same run id now re-sends the whole run from its first
  start instead of only the continuation, so the run's document is replaced with complete
  content. The run start is kept per session and run id; a new run id, `session_end` or a stop
  drops it. Host maintenance turns no longer touch it.

### Downgrade notes

- The queue file format is unchanged. 0.2.0 keeps duplicate copies and replays them oldest first
  (same document id, replace), so a re-retain of that document before replay finishes can leave
  older text. A build that ignores tombstone lines (unreleased queue builds before 0.2.0) may
  replay an out-of-date copy over a newer one that was sent live. Let the queue drain, or delete
  `retain-queue.jsonl`, before downgrading.

## 0.2.0 (2026-11-07)

### Upgrade notes

- OpenClaw `>=2026.10.10` is now required (was `>=2026.10.1`). Upgrade OpenClaw first; older
  hosts refuse the install. See Fixes below for why.
- The offline retain queue is on by default (`retainQueueEnabled`). Auto-retains that fail
  because Hindsight is unreachable are written to
  `<state dir>/hindsight-native/retain-queue.jsonl` and sent later. The file holds conversation
  text (mode 600). Set `retainQueueEnabled: false` to drop them as before.

### Added

- `retainTags`: tags added to every retained memory, with the same key and meaning as
  `@vectorize-io/hindsight-openclaw`. They apply to auto-retain, `hindsight_retain` and the
  pre-compaction flush, merged before inline `<retain_tags>` and per-call tags without
  duplicates. A vendor config that sets it no longer fails with "unknown keys: retainTags".
- `scripts/live-proof.sh` is now a reusable harness: `--openclaw` (npm version, git ref or
  path), `--runtime embedded|claude-cli`, `--plugin` (checkout, tarball or install spec) and
  `--phase`, with a PASS/FAIL/SKIP table and `results.json`. It replaces the earlier
  single-host script.
- `scripts/compat-matrix.sh` runs the harness for the minimum host version, the latest release
  and `main` on both runtimes and writes `MATRIX.md`. A nightly launchd example is documented,
  not installed.
- Offline retain queue, on by default (`retainQueueEnabled`). An auto-retain that fails because
  Hindsight is unreachable (network error, timeout, HTTP 5xx) is saved to
  `<state dir>/hindsight-native/retain-queue.jsonl` (mode 600) and sent later, instead of being
  dropped. A 4xx answer is still logged and dropped.
- Each queued item keeps its bank and document id. Replay never routes it to another bank, and a
  second retain of the same document replaces the queued copy. No URL or token is stored.
- Replay runs at service start, on a backoff timer (30 s doubling to 15 min) and after the next
  successful retain, oldest first, so each bank sees its writes in order.
- `retainQueueMaxItems` (default 500), `retainQueueMaxAgeMs` (default 7 days) and a fixed 32 MiB
  total (UTF-8 bytes) bound the queue. A single retain over the bound is not queued. Dropped
  items log one warning until the queue drains.
- Queued items keep the tags resolved when the run ended (`retainTags` plus inline
  `<retain_tags>`). A queued retain whose bank no longer exists (Hindsight 404 `Bank not found`)
  is dropped with a warning on replay, like other 4xx answers.
- Replay drops an item only on a Hindsight HTTP 4xx about that item. A refused redirect, an
  ambiguous 404, auth and rate-limit answers, a 4xx from bank setup and unexpected errors keep it
  and back off. If a bank already has queued items and the queue file cannot be written, the
  retain is sent live instead.

### Fixes

- A first recall on a bank nothing was retained to yet no longer logs a warning
  (`auto-recall skipped: Hindsight recall failed: HTTP 404`). Hindsight's
  `Bank '<id>' not found` 404 now reads as "no memories" in auto-recall, memory search and the
  `hindsight_recall` / `hindsight_reflect` tools, with a debug line at most. A 404 from a route
  that does not exist (wrong `hindsightApiUrl` path) and other HTTP errors stay loud.
- No auto-recall and no auto-retain on host maintenance turns: the pre-compaction flush turn
  (trigger `memory`) and Active Memory's recall child (`<session>:active-memory:<id>`). Before,
  the flush turn recalled with the host's flush prompt as the query, and the recall child could
  be retained as if it were a conversation. The `hindsight_*` tools stay available to both.
- `openclaw.install.minHostVersion` and the `openclaw` peer dependency are now `>=2026.10.10`
  (was `>=2026.10.1`). OpenClaw 2026.10.1 through 2026.10.9 give turns in a dashboard session
  created by `sessions.create` no memory audience, so the plugin could not recall or retain
  there. 2026.10.10 records those sessions as direct chats (openclaw#181359).

## 0.1.2 (2026-11-06)

### Security

- Refuse plain http to a non-loopback `hindsightApiUrl` unless the new `allowInsecureHttp` option
  is `true` (CWE-319, cleartext transmission). Before, 0.1.1 sent the bearer token and
  conversation text unencrypted and only warned when a token was set. Config resolution now
  throws an error naming `allowInsecureHttp`; loopback http and https are unchanged.
- With the opt-in set, the service start warning says both the bearer token (if any) and
  conversation text go unencrypted, even when no token is configured.
- Every request to Hindsight is sent with `redirect: "error"`, so an https endpoint cannot answer
  307/308 and move the body (conversation text) to plain http.
- Upgrade note: a config that used a remote `http://` URL must switch to https, a loopback
  tunnel, or set `allowInsecureHttp: true`.

## 0.1.1 (2026-11-06)

First version published to npm and ClawHub (0.1.0 was never published). Pre-publish hardening
from the review of 0.1.0, plus release metadata.

- Package metadata: `repository`, `homepage` and `bugs` point at
  github.com/etzelm/openclaw-memory-hindsight.
- README: install from npm, ClawHub or GitHub source, and a comparison with
  `@vectorize-io/hindsight-openclaw`.
- README: memory needs the embedded agent runtime; CLI-backed runtimes such as `claude-cli` get
  no memory audience from the host (Limitations).
- `scripts/live-proof.sh --ref <ref>` builds a fresh clone of a branch, tag or commit instead of
  the current checkout.

- Bounded I/O: auto-retain, `hindsight_retain` and `hindsight_reflect` abort after 30 s and
  `memory.get` after 10 s, combined with the host signal when present. Auto-retain failures are
  logged at warn and never thrown.
- Bank ids are encoded once: routing returns the raw id and `HindsightClient` encodes it for the
  URL. Ids made of `a-z0-9_-` (main, dev, openclaw, wb, researcher) are unchanged.
- Recall wrapper: literal `<hindsight_memories>` and `</hindsight_memories>` inside recalled text
  are neutralized, and the default preamble says memories are untrusted historical data.
- Config: `hindsightApiUrl` with userinfo, a query string or a fragment is rejected. One warning
  at service start for an unresolved token, and one for a token over plain http to a non-loopback
  host.
- Auto-retain document ids now include a 12-hex sha256 of the raw session key
  (`openclaw:<sanitized key>-<hash>:run:<run>`), so sanitized keys cannot collide. Documents
  retained by 0.1.0 under the old id are not replaced.
- README: `memory.search` through the provider runtime does not apply the incognito,
  `excludeProviders` or `memoryMode` filters because it is gated by audience.

## 0.1.0 (unreleased)

First standalone release, ported from the staged bundled extension
(openclaw branch `memory-hindsight`, commit e67c0103551; the bundled-only config budget commit is
not carried over).

- Plugin id `hindsight-native`, `kind: memory`, package `@etzelm/openclaw-memory-hindsight`.
- Provider runtime for `memory.status`, `memory.search` v2 and `memory.get`; auto-recall and
  auto-retain hooks; `hindsight_retain`, `hindsight_recall`, `hindsight_reflect` tools;
  `recallToolNames`; tools-arm pre-compaction flush plan; audience-based owner and conversation
  banks.
- Capability types come from `OpenClawPluginApi["registerMemoryCapability"]` instead of the
  removal-pending `plugin-sdk/memory-host-core`.
- Live config is read from `api.runtime.config.current()` with `api.pluginConfig` as the fallback,
  instead of the deprecated `plugin-sdk/plugin-config-runtime` helper.
- `/learn`: uses `api.registerLearnContribution` when the host has it (openclaw#191665) and the
  older `learnToolNames` / `learnGuidanceBuilder` capability fields otherwise.
- New `agentBankMap` key (same shape as the vendor plugin) so several agents can share one owner
  bank.
- Auto-retain no longer asserts audience currency at `agent_end`, because the host releases the
  run's audience before fire-and-forget `agent_end` handlers start.
- Tests use a local fake plugin API; the host's test helpers are not exported.
