# Changelog

## 0.8.0 (2026-11-11)

### Upgrade notes

- Six config keys are added: `recallTimeoutMs`, `recallTagGroups`, `recallHistoryPattern`,
  `recallTopK`, `recallMinScore` and `recallQueryShaping`. Their defaults keep requests as they
  were: the timeout stays 10 s, no tag filter is sent, every result is injected, no score floor
  is sent and the query is built as before. No key is
  removed or renamed.
- New default behavior: a recall circuit breaker. After 3 auto-recalls in a row end in a timeout,
  a network error or an HTTP 5xx, auto-recall skips for 60 s without a request (one warning in the
  log), then sends one probe; any answer closes it. A 4xx, a missing bank or an empty result never
  counts. Before, every turn waited up to 10 s while Hindsight was slow or down. The
  `hindsight_*` tools are not affected.
- New metrics: `openclaw_hindsight_recall_skipped_total{agent, reason}` and the
  `openclaw_hindsight_recall_injected_memories` and `_chars` histograms. A skipped auto-recall
  turn now records a skip sample (it recorded nothing before); `recall_total` and the latency
  histogram are unchanged.
- The manifest declares `cliCommands`, so `openclaw hindsight` appears as a root command once the
  plugin owns the memory slot.
- Document ids, the retain queue file format and bank routing are unchanged.

### Added

- `recallTimeoutMs` (250 to 30000 ms, default 10000) bounds the auto-recall request, and the
  circuit breaker described above protects the reply path.
- `recallTagGroups` is passed through as Hindsight's recall `tag_groups` on auto-recall and
  `hindsight_recall`, validated against the Hindsight 1.2.1 shape (leaf `{tags, match, resolve}`,
  `and`, `or`, `not`; 32 groups, 32 tags per leaf, 8 levels). `recallHistoryPattern` (a
  case-insensitive regex) lifts the filter for a matching query. Example in the README: keep
  `kind:status` units out of recall unless the question asks about history.
- `recallTopK` (1 to 50) caps the memories auto-recall injects, best first; `recallMinScore`
  (0 to 1) is sent as Hindsight's `min_scores.final`. Both are off by default and do not apply to
  `hindsight_recall`. `docs/recall-ab.md` has the A/B plan, and `scripts/recall-ab.sh` (not in the
  package) runs an eval harness once per arm.
- `recallQueryShaping` (`off`, the default, or `strip`). `strip` removes OpenClaw's
  internal-context envelope (run notes, spawning rules, session keys) from a message before the
  800-character query cap, for the current message and the previous one a follow-up adds. Text
  without the envelope is unchanged, and an envelope-only message gives no query. On 40 real
  subagent tasks against a restored copy of the maintainer's bank, the junk rate of injected
  memories went from 0.546 to 0.315; the curated eval set has no envelope and is unchanged. See
  `docs/recall-query-shaping.md`.
- Metrics for skipped auto-recalls by reason (`filter`, `no_audience`, `empty_query`, `followup`,
  `cache_hit`, `breaker_open`) and for the count and size of every injected block.
- `openclaw hindsight status`, `doctor` and `forget`. `forget --session <key>` deletes a session's
  auto-retained documents and their memory units after listing them; `--dry-run` deletes nothing,
  it asks before deleting (outside a terminal it needs `--yes`), and it refuses while the retain
  queue still holds a copy of the session. `--token-file` covers a SecretRef token, which the CLI
  process does not resolve.
- Documentation (not in the package): SUPPORT.md, the release and support policy (release
  cadence, which versions get fixes, deprecation notice, the supported OpenClaw window, the road
  to 1.0); RELEASING.md "Before a release" (CI, the compat matrix, the recall release gate and 48
  hours on the maintainer's Gateway for a minor); SECURITY.md points to SUPPORT.md.
- Tests and tooling (not in the package): seeded model tests of the retain queue with disk-full,
  failed-rename and torn-write faults and concurrent replays; `scripts/host-types.sh`, which
  type-checks and unit-tests the plugin against the floor host, the latest release or a built
  `main` (CI runs the latest release); `scripts/api-contract.mjs` with a contract recorded from
  Hindsight 1.2.1, a client test against it, and an optional live check in the compat nightly
  (`HS_COMPAT_API_URL`, exit 5 on drift).

### Changed

- The auto-recall cache key includes the tag filter and the score floor, so a live change to
  either recalls fresh. A live `recallTopK` change applies to a cached result.

### Fixed

- Retain queue replay: a bank that refuses (auth, rate limit, bank setup) is held for the
  current backoff, and the passes a turn starts (a retain queued behind its bank, a live retain
  delivered while items wait) skip it. Before, every such turn sent one request to each
  refusing bank with queued items. The startup pass and the backoff timer still try it. A 429 or
  503 with `Retry-After` holds the bank for that long in every pass, at most 15 minutes.
- Retain queue replay: after a pass that delivered every item, a failing save was retried every
  30 s. The wait now grows while the save keeps failing, as 0.7.1 described, and goes back to the
  base after a pass and its save both succeed.
- Retain queue: parking in-flight live writes at a stop no longer evicts queued items when the
  queue is at `retainQueueMaxItems` or its size bound. What does not fit is not parked, and one
  warning says how many.
- Retain queue: appended items are fsynced, so a retain survives a power loss right after it was
  queued (about 2 ms per queued item, only while Hindsight is unreachable). Every queue write
  loops until all bytes are written and fails on a write that makes no progress.
- Tests (not in the package): the short-write test now exercises the write loop it guards; before,
  it mocked a call the queue no longer made.

## 0.7.1 (2026-11-11)

### Upgrade notes

- No config key is added or removed.
- Config validation is stricter. A config that loaded on 0.7.0 fails to load when:
  `hindsightApiToken` holds a control character (usually a secret file with a second line), a
  space or a non-ASCII character; an `agentBankMap` bank id is `.` or `..`; two `agentBankMap`
  keys name the same agent after normalization; or a key has no usable characters. Most of these
  were already broken: every request failed, or went to the wrong path or an arbitrary bank. A
  token with an inner space or a Latin-1 character (U+00A0 to U+00FF) was sent as is and could
  work on 0.7.0; it is refused now too.
- `agentBankMap` keys are normalized like agent ids. A key such as `WB Dev` was ignored before
  (the agent kept its own bank); it now applies to agent `wb-dev`, so that agent reads and writes
  the mapped bank from now on.
- A live auto-retain that gets HTTP 401, 403, 408 or 429 is now queued and replayed instead of
  dropped. A rotated token or a rate limit no longer loses turns. Replay keeps 408 too (it
  dropped it before).
- Replay no longer stops for every bank at one bank that refuses (auth, rate limit, bank setup,
  ambiguous 404): that bank is skipped for the pass and the others go out. A network error,
  timeout or 5xx still ends the pass.
- `hindsight_recall` output prints each memory on one line, and `hindsight_reflect` output starts
  with an untrusted-data line. Both neutralize memory wrapper tags.

### Security

- A token with a line break or another control character was passed to fetch, whose error
  quotes the header value; the plugin logged that error and returned it from `hindsight_*`
  tools. The token is now validated when the config loads, and the error never contains it.

### Fixed

- Retain queue: when replay had delivered a bank's only queued copy of a document but not saved
  yet, a newer copy went out live with no tombstone, and a crash or a failed save replayed the
  old copy over it. A live write that succeeds now tombstones that copy.
- Retain queue: rewrites fsync the file before the rename (and the directory after it), so a
  power loss cannot leave an empty or missing queue file. A rewrite writes every byte before the
  rename, so a short write on a nearly full disk cannot replace the file with a truncated copy.
  Appends of a new item are not fsynced yet.
- Retain queue: an auto-retain whose live write is still in flight when the plugin stops is
  queued at the stop, so a Gateway exit does not lose it. A write that then succeeds removes it.
- Retain queue: a replay pass that a write error ended is retried after the backoff, with the
  wait growing while the error lasts, instead of waiting for the next retain or a restart. That
  includes a pass that delivered every item and then could not save, though for that case the
  wait stayed at the 30 s base until 0.8.0.
- Retain queue: repeated too-large or unwritable retains of the same document write one
  tombstone instead of one each. A tombstone that could not be written is tried again on the next
  attempt.
- `agentBankMap`: agent ids `constructor` and `__proto__` no longer resolve to `Object.prototype`
  members (the bank id was a function or an object).
- `hindsight_recall` has its own 10 s timeout, as documented; it waited only for the host signal.
  Recall, reflect and memory-lookup bodies are read with a 4 MiB bound.
- README: the source install no longer names a 0.3.0 tarball; the claude-cli text in the runtime
  note, under the fixed values and in Limitations now agrees with `docs/compat-matrix.md`; the
  provider-runtime limitation lists every session filter it skips; a note on the recall cache
  and Hindsight's background processing.
- Compatibility matrix (not in the package): B1 counts as the expected claude-cli failure only
  when the chat.send session itself shows no audience, not another session in the same window.
- Compatibility nightly (not in the package): a failed tag listing with `latest-release` logs
  "could not list tags" instead of "no vX.Y.Z tag found". The docs name the tag-push trust
  boundary of `latest-release` and say when the status file is written.
- CI (not in the package): GitLab uses the shared pack guard and runs its tests, both CIs run the
  compat script tests, and the release workflow enforces the coverage floor.

## 0.7.0 (2026-11-11)

### Upgrade notes

- No config change is needed, and no key is added or removed.
- A 404 whose body cannot be read (request aborted, connection lost) is now an error, not "no
  bank yet". Auto-recall logs it at warn and injects nothing, as before. Replay is unchanged: it
  drops a queued retain only on an explicit `Bank '<id>' not found` body, so such a retain stayed
  queued before and still does. A live auto-retain whose 404 body read timed out or was aborted
  is now queued for replay; before, it was dropped as a 404.
- With `recallCacheTtlMs` set, a `hindsight_retain` call now drops that session's cached recall,
  so the next turn of the session recalls fresh. Other sessions keep their cache. The new memory
  appears once Hindsight has processed it; a recall before that misses it and is cached as usual.

### Fixed

- Retain queue: a copy that replay delivered but whose batched save failed stays in the file until
  the next save. When a newer copy of the same document then could not be queued (too large, or
  the file could not be written) and went out live, a restart replayed the old copy over it. The
  queue now writes a tombstone for that copy.
- Auto-retain: the host does not await `agent_end`, so run N's handler can run after run N+1
  started. It used and deleted run N+1's start marker, so run N retained the wrong slice and run
  N+1 lost its start. A marker of another run is now left alone.
- A 404 whose body read failed counted as a missing bank, so recall reported "no memories"
  instead of an error. The read error is now thrown. Bodies of non-404 errors are cancelled
  instead of left unread.
- Auto-recall cache (`recallCacheTtlMs`): a `hindsight_retain` call drops the session's cached
  recall. Auto-retain leaves the cache alone; that turn is already in the transcript.
- Compatibility proof (not in the package): the owner fact is a boat name instead of a "launch
  code word", which Hindsight's retain model sometimes stored without its value. B1 and B2 judge
  the chat.send session, so a host heartbeat turn in the same window no longer fails them, and
  B2 still fails on a code hit from any session. The probe imports the memory host SDK while it
  registers, because upstream main now closes a plugin's invocation scope after the run.
- Compatibility matrix (not in the package): G2 counts with the audience checks for the
  expected `claude-cli` failure. With `CLI_AUDIENCE_FIXED_IN` set, a host built from source must
  pass, and `CLI_AUDIENCE_FIXED_IN=main` covers a fix that is only on upstream main.
- Compatibility nightly (not in the package): an unwritable `WORK_ROOT` exits 4 with "cannot
  write WORK_ROOT" instead of "another nightly run took the lock". The example plist starts bash
  through a node binary with Full Disk Access, because a LaunchAgent bootstrapped from cron after
  a macOS reboot gets no access to an external disk.

### Added

- Compatibility nightly (not in the package): `HS_COMPAT_REF=latest-release` tests the highest
  `vX.Y.Z` tag, and `HS_COMPAT_STATUS_FILE` writes a Prometheus textfile (last attempt, last run,
  last success, exit code) for a missed-nightly alert.

## 0.6.0 (2026-11-11)

### Upgrade notes

- Needs an OpenClaw build with openclaw/openclaw#197274 (merged 2026-11-11) for `hindsight_*`
  tools on claude-cli sessions. That host change passes the turn's memory audience when it lists
  claude-cli MCP tools, so the tools list through the normal audience route. On a host without
  it, claude-cli sessions lose the `hindsight_*` tools; stay on 0.5.0 there. (Corrected in 0.7.1:
  only a main build from 2026-11-09 to 2026-11-11 keeps auto-recall on those sessions; released
  builds through 2026.11.5-beta.2 give CLI turns no memory at all, see README.)
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
