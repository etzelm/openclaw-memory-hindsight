# Design notes

What the plugin plugs into, and how it differs from the vendor plugin.

## What the plugin does

- **Provider runtime**: `memory.status`, `memory.search` (v2) and `memory.get` in the Gateway,
  CLI and Control UI read Hindsight through the host's audience-checked provider API.
  `memory.status` is `degraded` while retains wait in the queue, the recall breaker is open or the
  last auto-recall failed in the past 5 minutes (not reported while `autoRecall` is off globally
  and in every `agents` entry); its
  details give the queue depth, the breaker state and the error class
  (`timeout`, `unreachable`, `http_4xx`, `http_5xx`, `error`), never memory text, URLs or tokens.
- **Auto-recall** before each prompt and **auto-retain** of each finished run (one document per
  run, replaced on re-delivery). Host maintenance turns (the pre-compaction flush and Active
  Memory's recall child) get neither; they use the tools. A bank nothing was retained to yet
  reads as "no memories", without a warning.
- **Agent tools** `hindsight_retain`, `hindsight_recall`, `hindsight_reflect`, plus opt-in
  read-only knowledge-base tools (see [Knowledge-base read tools](configuration.md#knowledge-base-read-tools)).
  `hindsight_recall` takes optional `types` (world, experience, observation; replaces
  `recallTypes` for the call) and `since` / `until` (ISO date or date-time, sent as Hindsight's
  `temporal_window`). The window ranks memories dated inside it higher; it does not filter.
  `null` or an empty string for any of the three means not set. `hindsight_reflect` takes optional
  `types` (sent as Hindsight's `fact_types`; `recallTypes` does not apply to reflect). Hindsight
  1.2.1 reflect has no temporal window, so reflect has no `since` / `until`.
- **Recall tool declaration** (`recallToolNames`): Active Memory uses `hindsight_recall` and
  `hindsight_reflect` without a `toolsAllow` list.
- **Pre-compaction flush, tools arm**: before compaction the host runs a silent turn that saves
  durable context through `hindsight_retain` (deduplicated per flush id, stable document ids).
- **/learn**: lessons persist through `hindsight_retain` on hosts that have the learn seam
  (see [Compatibility](../README.md#compatibility)).
- **Audience-based banks**: the host-minted memory audience picks the bank. Owner-private
  sessions use the agent's bank (same id as the vendor plugin's per-agent bank, so existing
  memory carries over); group chats and other senders get a separate
  `<bank>::conv::<hash>` bank per conversation, so their memories never surface in the owner's
  private recall.

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

The vendor plugin has features this one does not port; see [Limitations](../README.md#limitations).
