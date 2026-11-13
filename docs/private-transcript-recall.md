# Private transcript recall

Active Memory's "Remember across conversations" (`memory.search.rememberAcrossConversations`)
reads earlier private conversations of the same agent. It runs only when the memory slot owner
declares `supportsPrivateTranscriptRecall` and names a `deterministicRecallToolName`. Otherwise
Active Memory logs "the current memory provider does not support protected private transcript
recall" and skips it.

This plugin declares both only when `privateTranscriptRecall` is `true` (default `false`, read at
startup) and the host has the public session store readers (`session-store-runtime`,
`agent-scope-runtime`). The tool is `hindsight_conversation_recall`.

## What it returns

Raw transcript excerpts of earlier auto-retained runs (`openclaw:<session>-<digest>:run:<run>`)
from the agent's owner-private bank. Never facts or observations, because Hindsight merges those
across sessions. Two paths nominate runs:

- Recall over fact types `world` and `experience`, with the facts' source chunks. Only the chunks
  are returned.
- Hindsight's document text search on up to three query words. Hindsight skips a fact that
  repeats an existing one, so a run can end up with no fact and no chunk. Such a run is found
  this way and returns a window of its stored text.

Both paths only nominate runs. The rules below decide.

The tool works only with the host grant `ctx.conversationRecall`. The model cannot supply it.
Without the grant it returns nothing.

## Rules

The rules follow OpenClaw memory-core (`session-search-visibility.ts`):

- The requester is the anchor session or Active Memory's recall run for it, and it is not sandboxed.
- The anchor is a private conversation of the same agent, under every key of its transcript.
- A run document must belong to the same agent, carry `audience: owner-private`, and not be
  marked `sandboxed: true`. Memory Core has no rule for sandboxed sources. The CLI runner does
  not report the flag, so a run without it is admitted.
- Its session must still exist, must be private under every key that shares its transcript,
  and must not be the anchor conversation.
- Its `session_id` must be the session's current transcript. Deleted sessions, recreated keys
  and earlier generations of a reset session are refused.
- The chunk id must belong to the document, and the metadata comes from the stored document.

Eligibility is judged on a fresh session store snapshot taken after Hindsight answers.

## Limits

- Runs retained before this version have no `session_id` and are never returned.
- Memory Core's forget records (`openclaw memory forget`) are internal to Memory Core
  (openclaw/openclaw#197150), so this tool cannot see them. With a foreign slot owner, the host
  says that command "acts on Memory Core's sidecar index, not the agent's selected memory". To
  remove a session from Hindsight, use `openclaw hindsight forget --session <key>`.
- Memory Core also recalls earlier generations of a reset session and the anchor's lines from
  before an in-place reset. The readers it uses are private to OpenClaw, so this tool returns
  less there. It never returns more.
