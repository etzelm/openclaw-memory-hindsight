# A/B plan: `recallTopK` and `recallMinScore`

Both keys are off by default. Turn one on only after an eval run shows it does not cost answers.
This page is the plan for that run and for reading its result.

## Question

Auto-recall injects every memory Hindsight returns, about 10 per prompt. In the maintainer's
weekly eval about 1 in 4 of them is graded irrelevant (junk rate 0.27 to 0.32 over 40 real
prompts). Junk costs input tokens on every eligible turn and can mislead the model. Questions:

1. Does a cap of N memories (`recallTopK`) lower the junk rate without dropping answers the
   uncapped recall injects?
2. Does a final-score floor (`recallMinScore`) do better than the cap?

Prior: Hindsight documents reranker scores as not calibrated across queries, so a fixed floor
is expected to abstain unevenly, and the cap is the main candidate. MRR@10 of 0.76 to 0.81 says
the answer is usually in the top 2, so a cap of 5 to 8 should rarely cut it.

## Arms

| Arm                    | Plugin equivalent         | Harness flags            |
| ---------------------- | ------------------------- | ------------------------ |
| baseline               | neither key set           | `--topk 0`               |
| topk-5, topk-6, topk-8 | `recallTopK: 5`, `6`, `8` | `--topk N --hit-k N`     |
| min-score-X (optional) | `recallMinScore: X`       | `--topk 0 --min-score X` |

Everything else stays as the deployed plugin config sends it (types, budget, `max_tokens` 1024,
`prefer_observations`, tag filter if any). Same bank, same question and prompt sets, same grader,
run back to back so the bank changes as little as possible between arms.

## Metrics and decision rule

- **Answer injected**: questions whose answer is inside what the plugin would inject. For a cap
  arm that is hit@N (the harness's `hit5` field, scored with `--hit-k N`). For the baseline and
  floor arms it is `hit_all`.
- **Junk rate** and **average injected** on the real-prompt set (graded).
- **MRR@10** and **p95 latency** as guards (a cap does not change either; a floor can).

Run-to-run noise is about 1 question of 99. Adopt the smallest N that:

1. loses at most 1 answer against the baseline's answer-injected count, and
2. lowers the junk rate by at least 0.05.

If no N meets both, keep the cap off. Adopt a floor only if it beats the chosen cap on junk rate
with the same answer-injected count, on two runs a week apart.

## Running it

`scripts/recall-ab.sh` drives the harness once per arm and prints one table:

```bash
scripts/recall-ab.sh --harness /path/to/recall-eval.py --topk "5 6 8" --out ./recall-ab-run
# optional floor arms, only if the harness supports --min-score:
scripts/recall-ab.sh --harness /path/to/recall-eval.py --topk "" --min-score "0.05 0.1"
```

- Each arm writes its history line to `--out/results.jsonl` and its Prometheus textfile to
  `--out/<arm>.prom`. The weekly history, textfile and alert are never touched, and
  `--push-textfile` is refused.
- Extra harness arguments go after `--` (for example `-- --skip-questions`). The flags the script
  sets per arm (`--label`, `--history`, `--textfile`, `--topk`, `--hit-k`, `--min-score`) are
  refused there.
- `--dry-run` prints the commands without running them.
- Cost: each arm is a full harness run (about 6 minutes against a large bank, plus the grader
  for memories it has not graded yet). The cap arms inject a subset of the baseline's memories,
  so a shared grades cache grades almost nothing new for them.
- Exit 0 when every arm ran, 1 when one failed (the others still run), 2 on a usage error.

Harness contract (what the script relies on): `python3 -I HARNESS` accepts `--label`,
`--history FILE` (appends one JSON line per run), `--textfile FILE`, `--topk N` (0 = all) and
`--hit-k K`, and, for the floor arms, `--min-score X` (detected from `--help`). Each history line
has `label`, `questions.{n, hit5, hit_all, mrr10}` and `prompts.{junk_rate, avg_injected, p95_s}`.

## After the run

Record the table and the decision next to the eval history. If a cap is adopted, set
`recallTopK` in the plugin config (it applies live, no restart) and watch
`openclaw_hindsight_recall_injected_memories` and the next weekly eval for a week.
