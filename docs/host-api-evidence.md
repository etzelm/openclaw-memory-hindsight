# Host API evidence

Why the supported floor is OpenClaw 2026.10.10: the host APIs and behavior the plugin depends on.

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
