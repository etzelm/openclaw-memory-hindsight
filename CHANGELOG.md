# Changelog

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
