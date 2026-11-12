#!/usr/bin/env bash
# Offline test of scripts/recall-ab.sh against a fake harness. No network, no Hindsight.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/recall-ab.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0
fail=0

ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1"; fi; }

# Fake harness: logs its argv, appends one history line with numbers derived from the arm, and
# fails on demand. FAKE_MIN_SCORE=1 makes --help advertise --min-score.
cat >"$WORK/harness.py" <<'PY'
import json, os, sys
argv = sys.argv[1:]
if "--help" in argv:
    print("usage: harness [--topk N] [--hit-k K]" + (" [--min-score X]" if os.environ.get("FAKE_MIN_SCORE") else ""))
    sys.exit(0)
with open(os.environ["FAKE_ARGV_LOG"], "a") as fh:
    fh.write(json.dumps(argv) + "\n")
def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
label = opt("--label")
if os.environ.get("FAKE_FAIL") and os.environ["FAKE_FAIL"] in label:
    sys.exit(3)
topk = int(opt("--topk", "0"))
hit_k = int(opt("--hit-k", "5"))
injected = topk or 10
rec = {
    "label": label,
    "settings": {"topk": topk, "hit_k": hit_k, "min_score": opt("--min-score")},
    "questions": {"n": 99, "hit5": 80 + hit_k, "hit_all": 91, "mrr10": 0.78},
    "prompts": {"junk_rate": round(0.3 - injected / 100, 3), "avg_injected": float(injected), "p95_s": 3.1},
}
with open(opt("--history"), "a") as fh:
    fh.write(json.dumps(rec) + "\n")
with open(opt("--textfile"), "w") as fh:
    fh.write("x 1\n")
PY

run() {
  rm -f "$WORK/argv.log"
  FAKE_ARGV_LOG="$WORK/argv.log" bash "$SCRIPT" --harness "$WORK/harness.py" "$@" \
    >"$WORK/stdout" 2>"$WORK/stderr"
  echo $? >"$WORK/rc"
}
rc() { cat "$WORK/rc"; }
argv_has() { grep -q -- "$1" "$WORK/argv.log"; }

# 1. Default arms: baseline plus topk 5, 6 and 8, isolated history and textfiles.
run --out "$WORK/o1"
check "default run exits 0" '[ "$(rc)" = 0 ]'
check "four arms ran" '[ "$(wc -l <"$WORK/argv.log" | tr -d " ")" = 4 ]'
check "history goes under --out" 'argv_has "\"--history\", \"$WORK/o1/results.jsonl\""'
check "textfile goes under --out" 'argv_has "\"--textfile\", \"$WORK/o1/baseline.prom\""'
check "never pushes a textfile" '! argv_has "push-textfile"'
check "baseline injects everything" 'argv_has "\"--label\", \"ab-baseline\", \"--history\", \"$WORK/o1/results.jsonl\", \"--textfile\", \"$WORK/o1/baseline.prom\", \"--topk\", \"0\"\]"'
check "a cap arm scores hit@N" 'argv_has "\"--topk\", \"6\", \"--hit-k\", \"6\""'
mode_of() { python3 -c 'import os, sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1"; }
check "out dir is private" '[ "$(mode_of "$WORK/o1")" = 700 ]'
check "summary has the baseline row" 'grep -q "^| baseline | 85/99 | 91/99 | 0.78 | 0.2 | 10.0 | 3.1 | 0 |$" "$WORK/o1/summary.md"'
check "summary has a cap row" 'grep -q "^| topk-5 | 85/99 | 85/99 | 0.78 | 0.25 | 5.0 | 3.1 | 0 |$" "$WORK/o1/summary.md"'
check "summary is printed too" 'grep -q "topk-8" "$WORK/stdout"'

# 2. Floor arms need a harness that has --min-score.
run --out "$WORK/o2" --topk "" --min-score "0.1 0.2"
check "floor without harness support still exits 0" '[ "$(rc)" = 0 ]'
check "floor arms skipped with a message" 'grep -q "no --min-score option" "$WORK/stderr"'
check "only the baseline ran" '[ "$(wc -l <"$WORK/argv.log" | tr -d " ")" = 1 ]'
FAKE_MIN_SCORE=1 run --out "$WORK/o3" --topk "" --min-score "0.1 0.2"
check "floor arms run when supported" '[ "$(wc -l <"$WORK/argv.log" | tr -d " ")" = 3 ]'
check "a floor arm passes the floor" 'argv_has "\"--min-score\", \"0.2\""'
check "floor rows in the summary" 'grep -q "^| min-score-0.1 |" "$WORK/o3/summary.md"'

# 3. Per-arm flags cannot be overridden through the extra args.
for flag in --history --textfile --push-textfile --label --topk --min-score --hit-k --push-textfile=x; do
  run --out "$WORK/o4" -- "$flag" x
  check "refuses extra $flag" '[ "$(rc)" = 2 ] && [ ! -e "$WORK/argv.log" ]'
done
run --out "$WORK/o5" --topk 5 -- --skip-prompts --bank other
check "passes other extra args through" 'argv_has "\"--skip-prompts\", \"--bank\", \"other\""'

# 4. A failing arm: the rest still run, exit 1, the row shows the exit code.
FAKE_FAIL=topk-6 run --out "$WORK/o6"
check "a failed arm exits 1" '[ "$(rc)" = 1 ]'
check "later arms still ran" 'argv_has "ab-topk-8"'
check "failed row shows the exit code" 'grep -q "^| topk-6 | - | - | - | - | - | - | 3 |$" "$WORK/o6/summary.md"'

# 5. Dry run, usage errors.
run --out "$WORK/o7" --dry-run
check "dry run exits 0" '[ "$(rc)" = 0 ]'
check "dry run runs nothing" '[ ! -e "$WORK/argv.log" ] && [ ! -e "$WORK/o7" ]'
check "dry run prints the commands" '[ "$(grep -c -- "--label" "$WORK/stdout")" = 4 ]'
FAKE_ARGV_LOG="$WORK/argv.log" bash "$SCRIPT" >/dev/null 2>&1
no_harness=$?
check "missing --harness is a usage error" '[ "$no_harness" = 2 ]'
for bad in 0 51 x 2.5; do
  run --topk "$bad"
  check "refuses --topk $bad" '[ "$(rc)" = 2 ]'
done
for bad in 1.5 -0.1 abc; do
  run --min-score "$bad"
  check "refuses --min-score $bad" '[ "$(rc)" = 2 ]'
done

echo "PASS $pass FAIL $fail"
[ "$fail" -eq 0 ]
