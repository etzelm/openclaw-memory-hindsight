#!/usr/bin/env bash
# Runs a recall eval harness once per arm (a baseline, each recallTopK value, each recallMinScore
# value), each into this run's own history and textfile, then prints one comparison table.
#
# The harness is the operator's own script that replays the plugin's auto-recall request against a
# bank and grades the result (see docs/recall-ab.md for the contract). Nothing here talks to
# Hindsight directly, and the weekly history, textfile and alert are never written: every run gets
# --history and --textfile under --out, and --push-textfile is refused.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/recall-ab.sh --harness PATH [options] [-- extra harness args]

  --harness PATH     recall eval harness (a Python script; run as python3 -I PATH)
  --topk "LIST"      recallTopK values to try, space separated (default "5 6 8"; "" for none)
  --min-score "LIST" recallMinScore values to try (default none; needs a harness with --min-score)
  --out DIR          where history, logs and summary.md go (default ./recall-ab-<timestamp>)
  --label PREFIX     label prefix for the history lines (default ab)
  --python BIN       Python interpreter (default python3)
  --dry-run          print the harness commands, run nothing
  -h, --help         this text

Exit: 0 when every arm ran, 1 when an arm failed (the others still run), 2 on a usage error.
EOF
}

HARNESS=""
TOPKS="5 6 8"
FLOORS=""
OUT=""
LABEL="ab"
PY="python3"
DRY=0
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --harness) HARNESS="${2:-}"; shift 2 ;;
    --topk) TOPKS="${2-}"; shift 2 ;;
    --min-score) FLOORS="${2-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --python) PY="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "recall-ab: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$HARNESS" ] || [ ! -f "$HARNESS" ]; then
  echo "recall-ab: --harness must name an existing file" >&2
  exit 2
fi
for value in $TOPKS; do
  case "$value" in
    '' | *[!0-9]*) echo "recall-ab: --topk values must be integers from 1 to 50: $value" >&2; exit 2 ;;
  esac
  if [ "$value" -lt 1 ] || [ "$value" -gt 50 ]; then
    echo "recall-ab: --topk values must be integers from 1 to 50: $value" >&2
    exit 2
  fi
done
for value in $FLOORS; do
  if ! [[ "$value" =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]]; then
    echo "recall-ab: --min-score values must be numbers from 0 to 1: $value" >&2
    exit 2
  fi
done
if [ ${#EXTRA[@]} -gt 0 ]; then
  for arg in "${EXTRA[@]}"; do
    case "$arg" in
      --history | --history=* | --textfile | --textfile=* | --push-textfile | --push-textfile=* | --label | --label=* | --topk | --topk=* | --min-score | --min-score=* | --hit-k | --hit-k=*)
        echo "recall-ab: $arg is set per arm by this script; drop it from the extra args" >&2
        exit 2
        ;;
    esac
  done
fi

if [ -n "$FLOORS" ] && ! "$PY" -I "$HARNESS" --help 2>/dev/null | grep -q -- '--min-score'; then
  echo "recall-ab: the harness has no --min-score option; skipping the recallMinScore arms" >&2
  FLOORS=""
fi

OUT="${OUT:-$PWD/recall-ab-$(date +%Y%m%d-%H%M%S)}"
ARMS=("baseline")
for value in $TOPKS; do ARMS+=("topk-$value"); done
for value in $FLOORS; do ARMS+=("min-score-$value"); done

arm_args() {
  case "$1" in
    baseline) echo "--topk 0" ;;
    topk-*) echo "--topk ${1#topk-} --hit-k ${1#topk-}" ;;
    min-score-*) echo "--topk 0 --min-score ${1#min-score-}" ;;
  esac
}

if [ "$DRY" -eq 0 ]; then
  mkdir -p "$OUT"
  chmod 700 "$OUT"
fi

failed=0
for arm in "${ARMS[@]}"; do
  # shellcheck disable=SC2207 # arm_args prints flags and plain values, no spaces inside
  args=($(arm_args "$arm"))
  cmd=("$PY" -I "$HARNESS" --label "$LABEL-$arm" --history "$OUT/results.jsonl"
    --textfile "$OUT/$arm.prom" "${args[@]}")
  if [ ${#EXTRA[@]} -gt 0 ]; then
    cmd+=("${EXTRA[@]}")
  fi
  if [ "$DRY" -eq 1 ]; then
    printf '%q ' "${cmd[@]}"
    echo
    continue
  fi
  echo "recall-ab: running $arm" >&2
  if "${cmd[@]}" >"$OUT/$arm.log" 2>&1; then
    echo "$arm 0" >>"$OUT/exit-codes"
  else
    status=$?
    echo "$arm $status" >>"$OUT/exit-codes"
    echo "recall-ab: $arm failed with exit $status (log: $OUT/$arm.log)" >&2
    failed=1
  fi
done

if [ "$DRY" -eq 1 ]; then
  exit 0
fi

"$PY" -I - "$OUT" "$LABEL" "${ARMS[@]}" <<'PY' | tee "$OUT/summary.md"
import json, os, sys

out, prefix, arms = sys.argv[1], sys.argv[2], sys.argv[3:]
rows = {}
path = os.path.join(out, "results.jsonl")
if os.path.exists(path):
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            rows[rec.get("label")] = rec
codes = {}
with open(os.path.join(out, "exit-codes")) as fh:
    for line in fh:
        arm, code = line.split()
        codes[arm] = code


def cell(value):
    return "-" if value is None else str(value)


print("| arm | hit@5 | answer injected | MRR@10 | junk rate | avg injected | prompts p95 s | exit |")
print("| --- | --- | --- | --- | --- | --- | --- | --- |")
base = rows.get(prefix + "-baseline", {})
hit5 = (base.get("questions") or {}).get("hit5")
for arm in arms:
    rec = rows.get(prefix + "-" + arm)
    if rec is None:
        print("| %s | - | - | - | - | - | - | %s |" % (arm, codes.get(arm, "-")))
        continue
    q = rec.get("questions") or {}
    p = rec.get("prompts") or {}
    n = q.get("n")
    # Cap arms run with --hit-k N, so their hit5 field is "answer inside the injected N". Other
    # arms inject every result, so hit_all is that number for them.
    injected = q.get("hit5") if arm.startswith("topk-") else q.get("hit_all")
    shown_hit5 = hit5 if arm.startswith("topk-") else q.get("hit5")
    print("| %s | %s | %s | %s | %s | %s | %s | %s |" % (
        arm,
        cell(shown_hit5 if n is None else "%s/%s" % (cell(shown_hit5), n)),
        cell(injected if n is None else "%s/%s" % (cell(injected), n)),
        cell(q.get("mrr10")),
        cell(p.get("junk_rate")),
        cell(p.get("avg_injected")),
        cell(p.get("p95_s")),
        codes.get(arm, "-"),
    ))
PY

exit "$failed"
