# Memory backends

OpenClaw lets one memory slot owner query other memory plugins that load as passive backends
([openclaw#201340](https://github.com/openclaw/openclaw/pull/201340), with legacy runtimes and
`store` from [#202838](https://github.com/openclaw/openclaw/pull/202838); upstream reference:
`docs/plugins/sdk-overview/memory-and-context.md`, "Memory backends"). hindsight-native supports
both sides:

| Setup                          | Slot owner         | hindsight-native role | Auto-recall and auto-retain | `hindsight_*` tools |
| ------------------------------ | ------------------ | --------------------- | --------------------------- | ------------------- |
| A. Hindsight fuses memory-core | `hindsight-native` | fusion owner          | on                          | on                  |
| B. memfusion fuses Hindsight   | `memfusion`        | backend               | off                         | off                 |

Both need an OpenClaw host with memory backends: 2026.11.7 or later. Older hosts reject the
`memoryBackend` key, ignore `params.backends` and never load a plugin as a backend, so
replace and sidecar behave exactly as in 0.10.0 there. The plugin needs no new config key for
either setup.

## A. hindsight-native owns the slot and fuses memory-core

```json5
{
  plugins: {
    slots: { memory: "hindsight-native" },
    entries: {
      "hindsight-native": {
        enabled: true,
        config: { hindsightApiUrl: "https://hindsight.example" },
      },
      "memory-core": {
        enabled: true,
        memoryBackend: true,
        // memory-core running as the dreaming sidecar never becomes a backend (host rule).
        config: { dreaming: { enabled: false } },
      },
    },
  },
}
```

What you get:

- `memory.search`, `memory.get` and `memory.status` (Gateway, CLI, Memory Wiki, voice context)
  answer from Hindsight and every opened backend. Results are merged by reciprocal rank (each
  store's own order counts, raw scores are never compared), identical excerpts are folded, and
  each backend has 15 s. A backend that fails or times out gives `coverage: "partial"` and a
  warning instead of an error.
- `memory_search` and `memory_get` agent tools over the fused results. Each result names its store
  (`hindsight`, `memory-core`) and carries a `ref` for `memory_get`. They are registered only when
  this plugin owns the slot and an enabled entry sets `memoryBackend: true`.
- Unchanged from replace mode: hooks, auto-recall (from Hindsight), auto-retain, the pre-compaction
  flush, `/learn` and the `hindsight_*` tools.
- References: Hindsight hits keep their 0.10.0 references. Backend references are wrapped under
  `hindsight-native` and unwrapped when read, as the host requires.
- Writes stay in Hindsight. Legacy backends such as memory-core are read only.

Why per entry and not the manifest flag: with `memoryBackends: true` in the manifest, every
enabled memory plugin would become a backend on every replace install as soon as the host
supports backends. Opting in per backend keeps today's installs unchanged. To undo, remove
`memoryBackend` (or set it to `false`).

## B. memfusion owns the slot, Hindsight is a backend

```json5
{
  plugins: {
    slots: { memory: "memfusion" },
    entries: {
      memfusion: { enabled: true },
      "hindsight-native": {
        enabled: true,
        config: { hindsightApiUrl: "https://hindsight.example" },
      },
      "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
    },
  },
}
```

memfusion's manifest requests backends, so every enabled memory plugin joins unless its entry sets
`memoryBackend: false`. The host then loads hindsight-native with
`registrationMode "memory-backend"`, and the plugin logs:
`memory-hindsight: loaded as a memory backend; the slot owner searches and stores through it.`

- Search and get work as in replace mode, under the caller's authority: a session reads only the
  bank its host-minted audience selects, operators read the owner bank, host operations read
  nothing.
- `store()` (memfusion's `memory_store`) retains to the caller's audience bank, under the same rules
  as `hindsight_retain`: not in `memoryMode: "context"`, not for incognito or retain-excluded
  sessions, never for operator, host or status leases. Each stored text gets a stable
  `openclaw-store:` document id with replace semantics, so a retried store does not duplicate.
- The tradeoff: in the backend role the host keeps only the provider runtime, so there is no
  auto-recall, no auto-retain, no `hindsight_*` tool, no metrics route and no offline retain queue
  (store writes live and fails loudly). Hindsight learns only what the model saves with
  `memory_store` (and memfusion's pre-compaction flush, which uses it) and is read only when the
  model searches. For automatic memory, use setup A.

## Checks

- A session needs a host-minted memory audience to read or write Hindsight. Sessions created by the
  operator (Control UI, `sessions.create`, `openclaw agent exec`) have one; a search from a session
  without one returns no Hindsight rows and the warning
  `stored memories were not searched: this session has no memory audience`.
- `openclaw hindsight doctor` still reports the slot role (owner or sidecar). In setup B the
  plugin's CLI is not registered, because the host drops it for backends; check the Gateway log
  line above instead.
