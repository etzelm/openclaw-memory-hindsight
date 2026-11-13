# Offline retain queue

How auto-retains survive a Hindsight outage. The short version is in the README's Operate section.

When an auto-retain cannot reach Hindsight (network error, timeout or HTTP 5xx), or Hindsight
refuses it for a reason that is not about the item (401, 403, 408 or 429: a token being rotated,
a rate limit), the plugin writes it to `<state dir>/hindsight-native/retain-queue.jsonl` and logs one warning per failed
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
  first, so each bank sees its writes in order. A network error, timeout or 5xx ends the pass for
  every bank; a bank that refuses (see below) is skipped for the rest of the pass while other banks'
  items still go out.
  While a bank has queued items, a new retain for that bank queues behind them. Two retains for one
  bank that are in flight at the same moment can still land out of order if the earlier one fails
  and is queued.
- **Not queued.** Any other 4xx answer (bad request, unknown bank, a 404 from a wrong
  `hindsightApiUrl` path) and a refused redirect are logged and dropped as before. On replay, only a Hindsight HTTP 4xx about the item drops it, with a
  warning: any 4xx except 401, 403, 408, 429 and an ambiguous 404 (a wrong `hindsightApiUrl` path, an
  HTML or empty body). Hindsight creates a bank on its first retain, so its explicit `Bank '<id>'
  not found` 404 is about the item and drops it. Everything else keeps the item and backs off:
  network errors, timeouts, 5xx, 401, 403, 408, 429, an ambiguous 404, a 4xx from bank setup
  (applying `retainMission`), a refused redirect and any unexpected error. Anything other than a
  network error, timeout or 5xx logs one warning until a pass ends with no bank refusing.
- **Shutdown.** An auto-retain whose live write is still in flight when the plugin stops is
  written to the queue at the stop, so a Gateway exit does not lose that turn. If the write then
  succeeds, its queued copy is removed again; a copy left behind replays as a harmless replace.
- **Tags.** An item keeps the tags resolved when the run ended (`retainTags` plus inline
  `<retain_tags>`); a later `retainTags` change does not touch queued items.
- **Limits.** Items beyond `retainQueueMaxItems` or a fixed 32 MiB total (UTF-8 bytes on disk,
  oldest first), or older than `retainQueueMaxAgeMs`, are dropped with one warning until the queue
  is empty again. A single retain larger than 32 MiB is not queued: it is sent live without waiting
  for its bank's queue, and its failure is logged as before.
- **Disk writes.** A new item is appended, on a new line even after a torn last line. Replacing,
  pruning and replay rewrite the file (fsync, then atomic rename); replay writes once per 25 delivered items and
  at the end of each pass, and a failed write is retried by the next one (a pass that a failed
  write ended is retried after the backoff). If a rewrite fails, the
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
