# Recall query shaping (`recallQueryShaping`)

Auto-recall sends one query per turn: the user message with host metadata and boilerplate
removed, capped at 800 characters. A subagent task does not start with the task. OpenClaw puts
an internal-context envelope in front of it:

```text
<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
[Subagent Context] ...
## Current Run
...
## Session Context
- Label: ...
- Requester session: agent:main:...
[Subagent Task]
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>

<the task>
```

With the default (`off`) the envelope fills most of the 800 characters. In one fleet's 625
subagent tasks over 14 days, it took 540 to 708 characters (median 568), so about 230
characters of the task reached Hindsight.

## Modes

| Value           | Query                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | The cleaned message, first 800 characters (unchanged behavior)                                                                                                                           |
| `strip`         | Every `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> ... <<<END_OPENCLAW_INTERNAL_CONTEXT>>>` block is removed first (an unterminated block runs to the end), then the 800-character cap applies |

Text without such a block is unchanged under `strip`, so ordinary messages and inter-session
messages get the same query as with `off`. A message that is only an envelope gives no query
and no recall. The same rule applies to the previous user message used by
`recallFollowupMaxWords`.

## Measured effect

Recall eval against a restored copy of a 442k-unit bank (Hindsight 1.2.1, live recall
settings, a Claude grader labelling each injected memory against the task text):

| Prompt set                | Mode    | Junk rate                 | Relevant per prompt | Prompts with only junk |
| ------------------------- | ------- | ------------------------- | ------------------- | ---------------------- |
| 40 subagent tasks         | `off`   | 0.546                     | 4.42                | 2                      |
| 40 subagent tasks         | `strip` | 0.315                     | 5.92                | 0                      |
| 20 inter-session messages | `off`   | 0.343                     | 5.45                | 0                      |
| 20 inter-session messages | `strip` | 0.343 (identical queries) | 5.45                | 0                      |

Per task, `strip` returned more relevant memories for 23 of 40, fewer for 9, the same for 8.
The 99 curated questions and the harvested set contain no envelope, so their queries and
scores are the same in both modes.

## Rollout and rollback

Set `"recallQueryShaping": "strip"` in the plugin config; the plugin reads it on the next turn
(live config reload, no restart). To roll back, remove the key or set `"off"`. Nothing is stored
differently: only the recall query changes, never what is retained.
