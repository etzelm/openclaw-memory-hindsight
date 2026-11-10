#!/usr/bin/env bash
# Live proof harness: one throwaway OpenClaw Gateway, one runtime, one plugin build, real turns.
#
# Run from a normal terminal as the account that can read the Hindsight token. In an agent exec
# shell OpenClaw refuses `openclaw agent` and `gateway call chat.send` by design; the harness
# detects that, runs setup, install and the provider self-test, and marks the turn checks SKIP.
#
#   scripts/live-proof.sh --openclaw 2026.10.10 --runtime embedded \
#     --token-env-file ~/hindsight.env --anthropic-env-file ~/anthropic.env
#   scripts/live-proof.sh --openclaw main --runtime claude-cli --token-file ~/.hindsight-token
#
# Steps:
#   1. Host (--openclaw): an npm version or dist-tag is installed into a scratch prefix, a git
#      ref (branch, tag, sha) is shallow-fetched from OPENCLAW_REPO and built with pnpm, a path
#      (built checkout or npm prefix) is used as is. Default: `openclaw` on PATH.
#   2. Plugin (--plugin): a checkout dir or git+URL#REF is built and packed with npm and
#      installed as npm-pack:, a .tgz is installed as npm-pack:, anything else (clawhub:...,
#      an npm spec) goes to `openclaw plugins install` as is. Default: this checkout.
#   3. An isolated Gateway (own OPENCLAW_HOME, STATE_DIR and CONFIG_PATH, loopback bind,
#      channels and Bonjour off) with the plugin in the memory slot, a throwaway bank
#      oc-proof-*, and a probe plugin that records each hook's memory audience and calls the
#      host memory provider with own, mismatched, forged and released audiences.
#   4. Two owner turns (`openclaw agent --session-key` on an operator-created session) and one
#      conversation turn (`gateway call chat.send` on a fresh dashboard session).
#   5. A PASS/FAIL/SKIP table and results.json; the oc-proof-* banks and scratch state are
#      deleted; results are copied to --results-dest if given.
#
# Options:
#   --openclaw SPEC          npm version or dist-tag, git ref, or path (default: PATH)
#   --runtime NAME           embedded (default) or claude-cli
#   --plugin SPEC            checkout dir, git+URL#REF, .tgz, or install spec (default: this
#                            checkout)
#   --phase LABEL            label for the bank, results dir and table (default: runtime)
#   --model REF              default anthropic/claude-haiku-5-5 (embedded) or
#                            claude-cli/claude-sonnet-4-6 (claude-cli; a model id the claude
#                            CLI accepts, so a host that cannot resolve it fails R1)
#   --token-file PATH        file that holds only the Hindsight API token
#   --token-env-file PATH    dotenv file with the token under --token-key
#                            (default HINDSIGHT_API_TENANT_API_KEY)
#   --anthropic-env-file P   dotenv file with the Anthropic key for anthropic/* models under
#                            --anthropic-key (default ANTHROPIC_API_KEY); ANTHROPIC_API_KEY in
#                            the environment also works
#   --host-dir DIR           resolve the host into DIR and keep it; reused when the spec matches
#   --results-root DIR       parent of the results dir (default $WORK_ROOT/hs-live-proof-results)
#   --results-dest DEST      copy the results dir to DEST with $RESULTS_PUT (default cp -R),
#                            then delete the local copy
#   --setup-only             stop after the provider self-test; turn checks are SKIP
#   --keep                   keep scratch state and banks for inspection
# Environment: HINDSIGHT_URL (loopback with a port, default http://localhost:8888), PORT
#   (default 19438), OPENCLAW_REPO (default https://github.com/openclaw/openclaw.git), WORK_ROOT
#   (default ~/work), BANK_WAIT seconds (default 240), RESULTS_PUT.
# Secrets are copied into mode-600 files, never printed and never put on a command line. For
# claude-cli, ANTHROPIC_API_KEY is removed so the CLI uses its own login.
# Exit: 0 no check failed, 1 a check failed, 2 bad usage or preflight, 3 setup failed.
set -u
umask 077

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

OC_SPEC=""; RUNTIME=embedded; PLUGIN_SPEC=""; PHASE=""; MODEL=""
TOKEN_FILE=""; TOKEN_ENV_FILE=""; TOKEN_KEY=HINDSIGHT_API_TENANT_API_KEY
ANTH_ENV_FILE=""; ANTH_KEY=ANTHROPIC_API_KEY
HOST_DIR=""; RESULTS_ROOT=""; RESULTS_DEST=""; SETUP_ONLY=0; KEEP=0
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
need() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "$1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --openclaw) need "$@"; OC_SPEC=$2; shift 2 ;;
    --runtime) need "$@"; RUNTIME=$2; shift 2 ;;
    --plugin) need "$@"; PLUGIN_SPEC=$2; shift 2 ;;
    --phase) need "$@"; PHASE=$2; shift 2 ;;
    --model) need "$@"; MODEL=$2; shift 2 ;;
    --token-file) need "$@"; TOKEN_FILE=$2; shift 2 ;;
    --token-env-file) need "$@"; TOKEN_ENV_FILE=$2; shift 2 ;;
    --token-key) need "$@"; TOKEN_KEY=$2; shift 2 ;;
    --anthropic-env-file) need "$@"; ANTH_ENV_FILE=$2; shift 2 ;;
    --anthropic-key) need "$@"; ANTH_KEY=$2; shift 2 ;;
    --host-dir) need "$@"; HOST_DIR=$2; shift 2 ;;
    --results-root) need "$@"; RESULTS_ROOT=$2; shift 2 ;;
    --results-dest) need "$@"; RESULTS_DEST=$2; shift 2 ;;
    --setup-only) SETUP_ONLY=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
case "$RUNTIME" in
  embedded) MODEL=${MODEL:-anthropic/claude-haiku-5-5} ;;
  claude-cli) MODEL=${MODEL:-claude-cli/claude-sonnet-4-6} ;;
  *) echo "--runtime must be embedded or claude-cli" >&2; exit 2 ;;
esac
PHASE=${PHASE:-$RUNTIME}
SLUG=$(printf '%s' "$PHASE" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | cut -c1-24 | sed 's/-*$//')
[ -n "$SLUG" ] || { echo "--phase needs at least one letter or digit" >&2; exit 2; }

HS=${HINDSIGHT_URL:-http://localhost:8888}
HS=${HS%/}
case "$HS" in
  http://localhost:[0-9]*|http://127.0.0.1:[0-9]*|http://\[::1\]:[0-9]*) ;;
  *) echo "HINDSIGHT_URL must be a loopback http URL with a port (the probe traces that port)" >&2; exit 2 ;;
esac
PORT=${PORT:-19438}
WORK_ROOT=${WORK_ROOT:-$HOME/work}
RESULTS_ROOT=${RESULTS_ROOT:-$WORK_ROOT/hs-live-proof-results}
BANK_WAIT=${BANK_WAIT:-240}
OPENCLAW_REPO=${OPENCLAW_REPO:-https://github.com/openclaw/openclaw.git}
DELAY_MS=15000
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_ID=$(date +%Y%m%d-%H%M%S)
BANK=oc-proof-$SLUG-$(openssl rand -hex 3)
CODE=PERIWINKLE-$(openssl rand -hex 2 | tr a-f A-F)
case "$BANK" in oc-proof-*) ;; *) echo "bank id must start with oc-proof-" >&2; exit 2 ;; esac

mkdir -p "$WORK_ROOT" "$RESULTS_ROOT" || exit 2
L=$(mktemp -d "$WORK_ROOT/hs-live-proof.XXXXXX") || exit 2
OUT=$RESULTS_ROOT/$SLUG-$RUN_ID
mkdir -p "$OUT" "$L/home/.openclaw" "$L/workspace" "$L/probe" || exit 2
chmod 700 "$L" "$OUT"
L_REAL=$(cd "$L" && pwd -P) || exit 2
# claude-cli turns run the real `claude` CLI, which keeps a per-project dir (transcripts and
# its own memory, so the code word) under <config dir>/projects/. Claude Code 2.1.296 names it
# after the turn's cwd: every UTF-16 unit that is not [A-Za-z0-9] becomes "-"; a name over 200
# characters keeps the first 200 plus "-" and a base-36 32-bit string hash of the cwd. With
# CLAUDE_CONFIG_DIR set, CLAUDE_CODE_PROJECT_DIR_NAME replaces the name, so it is unset here.
# CLAUDE_CONFIG_DIR cannot move the dir into $L: the CLI then no longer finds the operator's
# login. Cleanup removes exactly this run's dir, never one that existed before the gateway
# started, and X2 checks it is gone.
unset CLAUDE_CODE_PROJECT_DIR_NAME
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  case "$CLAUDE_CONFIG_DIR" in /*) ;; *) CLAUDE_CONFIG_DIR=$PWD/$CLAUDE_CONFIG_DIR ;; esac
  export CLAUDE_CONFIG_DIR
fi
CLAUDE_PROJ_ROOT=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
CLAUDE_SNAP=0; CLAUDE_PRE=""
# claude_ls: names of the entries directly under the projects dir, one per line, sorted.
claude_ls() {
  [ -d "$CLAUDE_PROJ_ROOT" ] || return 0
  (cd "$CLAUDE_PROJ_ROOT" && for n in * .[!.]* ..?*; do
    if [ -e "$n" ] || [ -L "$n" ]; then printf '%s\n' "$n"; fi
  done) | LC_ALL=C sort
}
# Start-of-run listing of the projects dir, kept in memory only, and a marker file for its
# time. Cleanup searches every entry that appears during the run, and every file modified after
# the marker in an entry that was already there, for this run's code word, whatever its name.
CLAUDE_ALL_PRE=$(claude_ls)
CLAUDE_MARK=$OUT/.claude-start
: > "$CLAUDE_MARK"
CHECKS=$OUT/checks.tsv
: > "$CHECKS"
TOKF=$L/hs-token; HDR=$L/hs-auth.hdr; ANTHF=$L/anthropic-key
GW=""; GW_TOKEN=""; OC=(); HOST_KIND=""; HOST_VERSION=""; HOST_COMMIT=""
PLUGIN_INSTALL=""; PLUGIN_DESC=""; PLUGIN_VERSION=""; PLUGIN_COMMIT=""; ABORT_MSG=""
TURNS=1; SKIP_REASON=""
if [ "${OPENCLAW_SHELL:-}" = exec ] || [ "${OPENCLAW_SUBAGENT_EXEC:-}" = 1 ]; then
  TURNS=0
  SKIP_REASON="agent exec shell: OpenClaw refuses openclaw agent and chat.send here by design"
fi
[ "$SETUP_ONLY" = 1 ] && { TURNS=0; SKIP_REASON="--setup-only"; }

# row ID CHECK WANT OBSERVED RESULT
row() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(printf '%s' "$4" | tr '\t\n' '  ')" "$5" >> "$CHECKS"; }
# abort EXIT ID CHECK MESSAGE: records a FAIL row (when ID is set) and stops
abort() {
  ABORT_MSG=$4
  echo "ABORT: $4" >&2
  [ -n "$2" ] && row "$2" "$3" "ok" "$4" FAIL
  exit "$1"
}
oc() { "${OC[@]}" "$@"; }
hs() { curl -sS -m 30 -H @"$HDR" -H 'Content-Type: application/json' "$@"; }
enc() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
read_key() {  # read_key FILE KEY OUTFILE
  grep -E "^(export )?$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- \
    | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' | tr -d '\r\n' > "$3"
  chmod 600 "$3"
  [ -s "$3" ]
}
redact() {  # secrets come from the mode-600 files, never from argv
  python3 -c '
import os, re, socket, sys
s = sys.stdin.read()
for f in sys.argv[1:4]:
    try: t = open(f).read().strip()
    except OSError: t = ""
    if t: s = s.replace(t, "<redacted>")
s = re.sub(r"([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", r"\1", s)
s = re.sub(r"\b(?!127\.)(\d{1,3}\.){3}\d{1,3}\b", "<ip>", s)
# Streamed claude-cli deltas split paths across chunks ("/Users/" | "name/.claude/..."), so no
# path rule can see them; the assembled tool input is logged again in full and redacted below.
# Plain JSON only (compact or with spaces); a delta logged inside an escaped JSON string is not matched.
# Only for log files (REDACT_DELTAS=1); turn outputs and transcripts keep their text for the checks.
if os.environ.get("REDACT_DELTAS") == "1":
    s = re.sub(r"(\x22type\x22\s*:\s*\x22(?:input_json|text|thinking)_delta\x22\s*,\s*\x22(?:partial_json|text|thinking)\x22\s*:\s*\x22)(?:[^\x22\\]|\\.)*(\x22)", r"\1<delta>\2", s)
home = os.environ["HOME"]
s = s.replace(home, "~")
s = s.replace(re.sub(r"[^A-Za-z0-9]", "-", home), "-~")  # Claude Code project dir names
# Only at a path start, so the scratch state dir ($L/home/.openclaw) is left alone.
s = re.sub(r"(?<![A-Za-z0-9._~/-])/(Users|home)/(?!\.)[A-Za-z0-9._-]+", r"/\1/<user>", s)
s = re.sub(r"(file://)/(Users|home)/(?!\.)[A-Za-z0-9._-]+", r"\1/\2/<user>", s)
# The dashed home of another account: dots, underscores and dashes in the name are all "-", so
# the name cannot be told from the path after it; the whole dashed path is replaced.
s = re.sub(r"-Users-[A-Za-z0-9._-]+", "-Users-<user>", s)
# Bare host and account names, as whole words. Names of 4 characters or less, and words the
# logs and checks use themselves (product, runtime and check terms), are kept.
KEEP = {"openclaw", "claude", "cli", "memory", "hindsight", "audience", "agent", "localhost",
        "gateway", "plugin", "plugins", "probe", "embedded", "anthropic", "session", "conversation",
        "owner", "turn", "retain", "recall", "bank", "main", "node", "admin", "user", "root"}
def word(name, tag):
    global s
    if len(name) > 4 and name.lower() not in KEEP:
        s = re.sub(r"(?<![A-Za-z0-9_-])" + re.escape(name) + r"(?![A-Za-z0-9_-])", tag, s)
host = socket.gethostname()
for h in sorted({host, host.split(".")[0]}, key=len, reverse=True): word(h, "<host>")
word(os.path.basename(home), "<user>")
sys.stdout.write(s)' "$TOKF" "$ANTHF" "$L/gw-token"
}
with_timeout() {  # with_timeout SECONDS CMD...
  local s=$1; shift
  if command -v timeout >/dev/null; then timeout "$s" "$@"; else perl -e 'alarm shift; exec @ARGV' "$s" "$@"; fi
}

stop_gateway() {
  [ -n "$GW" ] || return 0
  kill "$GW" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$GW" 2>/dev/null || break; sleep 1; done
  # Leftover gateway processes: only those whose stdout is this run's gateway.log.
  local p
  command -v lsof >/dev/null || { echo "note: no lsof, leftover gateway processes on port $PORT are not checked" >&2; GW=""; return 0; }
  for p in $(pgrep -f "gateway run --port $PORT --bind loopback" 2>/dev/null); do
    lsof -a -p "$p" -d 1 -Fn 2>/dev/null | grep -qxF "n$L_REAL/gateway.log" && kill "$p" 2>/dev/null
  done
  GW=""
}

proof_banks() {
  [ -s "$HDR" ] || return 0
  hs "$HS/v1/default/banks?limit=1000" 2>/dev/null | python3 -c '
import json, sys
try: j = json.load(sys.stdin)
except Exception: sys.exit(0)
items = j.get("banks", j if isinstance(j, list) else [])
for b in items:
    bid = (b.get("bank_id") or b.get("id")) if isinstance(b, dict) else b
    if isinstance(bid, str) and bid.startswith(sys.argv[1]): print(bid)' "$BANK"
}

# claude_proj_dirs: the Claude Code project dirs this run's workspace maps to (logical and real
# path), one per line, with the CLI's naming rule (see CLAUDE_PROJ_ROOT above). Listed are names
# that hold "-hs-live-proof-", and shortened names (over 200 characters, where that part can be
# cut off), whose hash suffix comes from this run's random scratch path.
claude_proj_dirs() {
  python3 -c '
import sys
def enc(p):
    u = p.encode("utf-16-le")
    units = [u[i] | (u[i + 1] << 8) for i in range(0, len(u), 2)]
    n = "".join(chr(c) if (48 <= c <= 57 or 65 <= c <= 90 or 97 <= c <= 122) else "-" for c in units)
    if len(n) <= 200: return n
    h = 0
    for c in units: h = ((h << 5) - h + c) & 0xffffffff
    if h >= 1 << 31: h -= 1 << 32
    h, d, s = abs(h), "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while True:
        s = d[h % 36] + s; h //= 36
        if not h: break
    return n[:200] + "-" + s
for n in sorted({enc(p) for p in sys.argv[2:]}):
    if "-hs-live-proof-" in n or len(n) > 200: print(sys.argv[1] + "/" + n)' "$CLAUDE_PROJ_ROOT" "$L/workspace" "$L_REAL/workspace"
}
# claude_snapshot: record which candidates exist before the gateway (and so the CLI) starts.
claude_snapshot() {
  local d
  CLAUDE_PRE=""
  while IFS= read -r d; do
    [ -n "$d" ] && { [ -e "$d" ] || [ -L "$d" ]; } && CLAUDE_PRE="$CLAUDE_PRE$d
"
  done <<EOF
$(claude_proj_dirs)
EOF
  CLAUDE_SNAP=1
}
# claude_new: entries under the projects dir that were not there at the start of the run, as
# paths, one per line. Includes this run's candidates when they are still there.
claude_new() {
  claude_ls | LC_ALL=C comm -13 <(printf '%s\n' "$CLAUDE_ALL_PRE") - | while IFS= read -r n; do
    [ -n "$n" ] && printf '%s\n' "$CLAUDE_PROJ_ROOT/$n"
  done
}
# claude_unpredicted: new entries that are not one of this run's candidates. Report only: they
# may belong to another Claude Code session on the machine, so they are never deleted.
claude_unpredicted() {
  claude_new | LC_ALL=C comm -23 - <(claude_proj_dirs | LC_ALL=C sort)
}
# claude_traces: report only, never deletes. Files that hold the code word or this run's
# workspace path (the CLI writes the cwd into every transcript line): any file under an
# hs-live-proof project dir, this run's candidates or an entry new since the start of the run,
# and any file under the projects dir modified after the start marker. Symlinks are never
# followed (one could point outside projects/). Catches a dir the CLI named some other way, new
# or not.
claude_traces() {
  local d
  {
    {
      for d in "$CLAUDE_PROJ_ROOT"/*hs-live-proof*; do [ -e "$d" ] && printf '%s\n' "$d"; done
      claude_proj_dirs
      claude_new
    } | sort -u | while IFS= read -r d; do
      # A symlink could point outside projects/: never follow it.
      { [ -e "$d" ] && [ ! -L "$d" ]; } || continue
      grep -r -l -F -e "$CODE" -e "$L_REAL/workspace" -e "$L/workspace" -- "$d" 2>/dev/null
    done
    if [ -f "$CLAUDE_MARK" ] && [ -d "$CLAUDE_PROJ_ROOT" ]; then
      find "$CLAUDE_PROJ_ROOT" -type f -newer "$CLAUDE_MARK" \
        -exec grep -l -F -e "$CODE" -e "$L_REAL/workspace" -e "$L/workspace" -- {} + 2>/dev/null
    fi
  } | sort -u
}
cleanup() {
  local st=$?
  trap - EXIT INT TERM
  stop_gateway
  local f d banks_left=kept state_left=kept claude_left=kept claude_pre=none traces
  for f in host.log plugin-build.log; do
    [ -f "$OUT/$f" ] && REDACT_DELTAS=1 redact < "$OUT/$f" > "$OUT/$f.tmp" && mv "$OUT/$f.tmp" "$OUT/$f"
  done
  if [ "$KEEP" = 0 ]; then
    if [ -s "$HDR" ]; then
      for b in $(proof_banks); do hs -o /dev/null -X DELETE "$HS/v1/default/banks/$(enc "$b")"; done
      sleep 2
      local n code
      n=$(proof_banks | wc -l | tr -d ' ')
      code=$(hs -o /dev/null -w '%{http_code}' "$HS/v1/default/banks/$(enc "$BANK")/documents")
      { [ "$n" = 0 ] && [ "$code" = 404 ]; } && banks_left=deleted || banks_left="left:$n (http $code)"
    else
      banks_left=deleted
    fi
    rm -rf "$L" 2>/dev/null || { sleep 3; rm -rf "$L"; }
    [ -e "$L" ] && state_left=present || state_left=removed
    # One path per line (the root may hold spaces); "present" sticks once any candidate is left.
    # A candidate that existed before the gateway started (or any candidate when cleanup runs
    # before that point) is not this run's and is never removed.
    claude_left=absent
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      { [ -e "$d" ] || [ -L "$d" ]; } || continue
      if [ "$CLAUDE_SNAP" != 1 ] || printf '%s' "$CLAUDE_PRE" | grep -qxF -- "$d"; then
        claude_pre=$d; [ "$claude_left" = present ] || claude_left=preexisting; continue
      fi
      if [ -d "$d" ] && [ ! -L "$d" ] && [ "$(cd "$d/.." && pwd -P)" = "$(cd "$CLAUDE_PROJ_ROOT" && pwd -P)" ]; then
        rm -rf "$d" 2>/dev/null
      fi
      if [ -e "$d" ] || [ -L "$d" ]; then claude_left=present
      elif [ "$claude_left" = absent ]; then claude_left=removed; fi
    done <<EOF
$(claude_proj_dirs)
EOF
  else
    while IFS= read -r d; do
      [ -n "$d" ] && { [ -e "$d" ] || [ -L "$d" ]; } && claude_left=present
    done <<EOF
$(claude_proj_dirs)
EOF
  fi
  row X1 "proof banks $BANK* deleted" deleted "$banks_left" "$([ "$banks_left" = deleted ] && echo PASS || echo FAIL)"
  traces=$(claude_traces)
  local x2obs x2ok=1 unpred
  unpred=$(claude_unpredicted)
  rm -f "$CLAUDE_MARK"
  x2obs="$state_left; claude project dir $claude_left"
  [ "$state_left" = removed ] || x2ok=0
  case "$claude_left" in present|kept) x2ok=0 ;; esac
  if [ "$claude_pre" != none ]; then
    x2ok=0; x2obs="$x2obs; preexisting claude project dir left alone: $claude_pre"
  fi
  if [ -n "$traces" ]; then
    x2ok=0; x2obs="$x2obs; run traces under the claude projects dir: $(printf '%s\n' "$traces" | head -3 | tr '\n' ' ')"
  fi
  if [ -n "$unpred" ]; then
    x2obs="$x2obs; new claude project dirs this run did not predict, left alone: $(printf '%s\n' "$unpred" | wc -l | tr -d ' ')"
  fi
  [ -n "$HOST_DIR" ] && x2obs="$x2obs; host dir kept for the caller"
  row X2 "scratch state removed" removed "$(printf '%s' "$x2obs" | redact)" "$([ "$x2ok" = 1 ] && echo PASS || echo FAIL)"
  local fails
  fails=$(awk -F'\t' '$5 == "FAIL"' "$CHECKS" | wc -l | tr -d ' ')
  if [ "$st" = 0 ] && [ "$fails" != 0 ]; then st=1; fi
  if [ "$st" = 130 ] && [ -z "$ABORT_MSG" ]; then ABORT_MSG="interrupted"; fi
  echo
  echo "== phase=$PHASE runtime=$RUNTIME model=$MODEL host=${HOST_VERSION:-unresolved} plugin=${PLUGIN_DESC:-unresolved}"
  [ "$TURNS" = 0 ] && echo "   turn checks SKIP: $SKIP_REASON"
  python3 - "$CHECKS" <<'PY' | tee "$OUT/table.txt"
import sys
order = "HSRABMCX"
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip()]
rows.sort(key=lambda r: (order.index(r[0][0]) if r[0][0] in order else 99, r[0]))
w = [max([len(r[i]) for r in rows] + [5]) for i in range(2)]
print(f"{'id':<{w[0]}}  {'check':<{w[1]}}  {'result':<6}  observed")
for r in rows:
    print(f"{r[0]:<{w[0]}}  {r[1]:<{w[1]}}  {r[4]:<6}  {r[3]}")
PY
  EXIT_CODE=$st STARTED="$STARTED" PHASE="$PHASE" RUNTIME="$RUNTIME" MODEL="$MODEL" OC_SPEC="$OC_SPEC" \
  HOST_KIND="$HOST_KIND" HOST_VERSION="$HOST_VERSION" HOST_COMMIT="$HOST_COMMIT" \
  PLUGIN_SPEC="${PLUGIN_SPEC:-$REPO_DIR}" PLUGIN_DESC="$PLUGIN_DESC" PLUGIN_VERSION="$PLUGIN_VERSION" \
  PLUGIN_COMMIT="$PLUGIN_COMMIT" BANK="$BANK" TURNS="$TURNS" SKIP_REASON="$SKIP_REASON" \
  ABORT_MSG="$ABORT_MSG" python3 - "$CHECKS" "$OUT/results.json" <<'PY'
import datetime, json, os, sys
e = os.environ
home = e["HOME"]
h = lambda s: (s or "").replace(home, "~")
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip()]
checks = [dict(id=r[0], check=r[1], want=r[2], observed=r[3], result=r[4]) for r in rows]
count = lambda k: sum(c["result"] == k for c in checks)
res = {
    "schema": 1,
    "phase": e["PHASE"],
    "runtime": e["RUNTIME"],
    "model": e["MODEL"],
    "openclaw": {"spec": h(e["OC_SPEC"]) or "PATH", "kind": e["HOST_KIND"],
                 "version": e["HOST_VERSION"], "commit": e["HOST_COMMIT"]},
    "plugin": {"spec": h(e["PLUGIN_SPEC"]), "description": h(e["PLUGIN_DESC"]),
               "version": e["PLUGIN_VERSION"], "commit": e["PLUGIN_COMMIT"]},
    "bank": e["BANK"],
    "turns": e["TURNS"] == "1",
    "skipReason": e["SKIP_REASON"] or None,
    "abort": e["ABORT_MSG"] or None,
    "startedAt": e["STARTED"],
    "finishedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "exitCode": int(e["EXIT_CODE"]),
    "summary": {"pass": count("PASS"), "fail": count("FAIL"), "skip": count("SKIP")},
    "checks": checks,
}
res["verdict"] = "FAIL" if res["summary"]["fail"] or res["exitCode"] else "PASS"
json.dump(res, open(sys.argv[2], "w"), indent=1)
PY
  if [ -n "$RESULTS_DEST" ]; then
    local put_ok=1
    if [ -n "${RESULTS_PUT:-}" ]; then
      $RESULTS_PUT "$OUT" "$RESULTS_DEST/" >/dev/null 2>&1 || put_ok=0
    else
      { mkdir -p "$RESULTS_DEST" && cp -R "$OUT" "$RESULTS_DEST/"; } || put_ok=0
    fi
    if [ "$put_ok" = 1 ]; then
      rm -rf "$OUT"; echo "results: $RESULTS_DEST/$(basename "$OUT")" | redact
    else
      echo "results: $OUT (copy to $RESULTS_DEST failed; copy it and delete it)" | redact
    fi
  else
    echo "results: $OUT" | redact
  fi
  exit "$st"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- preflight ------------------------------------------------------------------------------
echo "== preflight phase=$PHASE runtime=$RUNTIME model=$MODEL"
for c in node python3 curl openssl nc git npm; do
  command -v "$c" >/dev/null || abort 2 "" "" "$c not on PATH"
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || abort 2 "" "" "node 24 or newer required"
NPM_SPEC_RE='^(latest|beta|extended-stable|[0-9]{4}\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?)$'
if [ -n "$OC_SPEC" ] && [ ! -d "$OC_SPEC" ] && ! [[ "$OC_SPEC" =~ $NPM_SPEC_RE ]]; then
  command -v pnpm >/dev/null || abort 2 "" "" "pnpm not on PATH (needed to build git ref $OC_SPEC)"
fi
if [ -n "$TOKEN_FILE" ]; then
  tr -d '\r\n' < "$TOKEN_FILE" > "$TOKF" 2>/dev/null; chmod 600 "$TOKF"
  [ -s "$TOKF" ] || abort 2 "" "" "--token-file is empty or unreadable"
elif [ -n "$TOKEN_ENV_FILE" ]; then
  read_key "$TOKEN_ENV_FILE" "$TOKEN_KEY" "$TOKF" || abort 2 "" "" "no $TOKEN_KEY in --token-env-file"
else
  abort 2 "" "" "pass --token-file or --token-env-file"
fi
{ printf 'Authorization: Bearer '; cat "$TOKF"; printf '\n'; } > "$HDR"; chmod 600 "$HDR"
case "$MODEL" in
  anthropic/*)
    if [ -n "$ANTH_ENV_FILE" ]; then
      read_key "$ANTH_ENV_FILE" "$ANTH_KEY" "$ANTHF" || abort 2 "" "" "no $ANTH_KEY in --anthropic-env-file"
    elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      printf '%s' "$ANTHROPIC_API_KEY" > "$ANTHF"; chmod 600 "$ANTHF"
    else
      abort 2 "" "" "$MODEL needs --anthropic-env-file or ANTHROPIC_API_KEY"
    fi
    unset ANTHROPIC_API_KEY ;;
esac
if [ "$RUNTIME" = claude-cli ]; then
  unset ANTHROPIC_API_KEY
  command -v claude >/dev/null || abort 2 "" "" "claude CLI not on PATH"
fi
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$HS/health")" = 200 ] || abort 2 "" "" "Hindsight not healthy at $HS"
[ "$(hs -o /dev/null -w '%{http_code}' "$HS/v1/default/banks?limit=1")" = 200 ] || abort 2 "" "" "Hindsight token rejected"
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then abort 2 "" "" "port $PORT is in use"; fi
echo "hindsight=ok bank=$BANK turns=$([ "$TURNS" = 1 ] && echo yes || echo "skip ($SKIP_REASON)")"

# ---- isolated gateway config ----------------------------------------------------------------
unset OPENCLAW_PROFILE OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PASSWORD
export OPENCLAW_HOME="$L/home" OPENCLAW_STATE_DIR="$L/home/.openclaw"
export OPENCLAW_CONFIG_PATH="$L/home/.openclaw/openclaw.json" OPENCLAW_GATEWAY_PORT="$PORT"
export OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_DISABLE_BONJOUR=1
GW_TOKEN=$(openssl rand -hex 24)
( umask 077; printf '%s' "$GW_TOKEN" > "$L/gw-token"; printf 'Authorization: Bearer %s\n' "$GW_TOKEN" > "$L/gw-auth.hdr" )
export OPENCLAW_GATEWAY_TOKEN="$GW_TOKEN"
export AUDIENCE_PROBE_LOG="$L/probe/probe.jsonl" AUDIENCE_PROBE_HS="$HS" AUDIENCE_PROBE_CODE="$CODE"
export AUDIENCE_PROBE_QUERY="launch code word" AUDIENCE_PROBE_DELAY_MS="$DELAY_MS"
CONF=$OPENCLAW_CONFIG_PATH

L="$L" PORT="$PORT" TOKEN="$GW_TOKEN" MODEL="$MODEL" TOKF="$TOKF" python3 - <<'PY'
import json, os
e = os.environ
cfg = {
  "gateway": {"mode": "local", "port": int(e["PORT"]), "bind": "loopback",
              "auth": {"mode": "token", "token": e["TOKEN"]}},
  "discovery": {"mdns": {"mode": "off"}},
  # Keep the file log out of the shared default (/tmp/openclaw) that a real Gateway uses.
  "logging": {"file": e["L"] + "/openclaw.log"},
  "agents": {"defaults": {"model": {"primary": e["MODEL"]}, "workspace": e["L"] + "/workspace"}},
  # Hindsight must be the only path from the owner session to the conversation session.
  # With file and shell tools the model writes "remember this" facts to the shared
  # workspace daily note (memory/YYYY-MM-DD.md) and a later session reads them back;
  # session tools (sessions_history, sessions_search) read the owner transcript; the
  # computer/nodes tools and the openclaw delegate tool reach the same files another way.
  # All of them bypass the plugin. B2 checks that none of them was offered or used.
  "tools": {"deny": ["group:fs", "group:runtime", "group:sessions", "group:nodes", "openclaw"]},
  "secrets": {"providers": {"hindsight": {"source": "file", "path": e["TOKF"], "mode": "singleValue"}}},
  "plugins": {"enabled": True, "load": {"paths": [e["L"] + "/probe"]}},
}
json.dump(cfg, open(e["L"] + "/home/.openclaw/openclaw.json", "w"), indent=2)
PY
chmod 600 "$CONF"

# ---- host -----------------------------------------------------------------------------------
host_from_kind() {  # host_from_kind KIND DIR
  case "$1" in
    npm|npm-prefix) OC=(node "$2/node_modules/openclaw/openclaw.mjs") ;;
    git|checkout) OC=(node "$2/openclaw.mjs"); HOST_COMMIT=$(git -C "$2" rev-parse HEAD 2>/dev/null || true) ;;
  esac
}
resolve_host() {
  local spec=$OC_SPEC hd marker
  if [ -z "$spec" ]; then
    command -v openclaw >/dev/null || { echo "openclaw not on PATH"; return 1; }
    HOST_KIND=path; OC=(openclaw); return 0
  fi
  if [ -d "$spec" ]; then
    hd=$(cd "$spec" && pwd)
    if [ -f "$hd/openclaw.mjs" ]; then HOST_KIND=checkout
    elif [ -f "$hd/node_modules/openclaw/openclaw.mjs" ]; then HOST_KIND=npm-prefix
    else echo "$spec is not an OpenClaw checkout or npm prefix"; return 1; fi
    host_from_kind "$HOST_KIND" "$hd"; return 0
  fi
  hd=${HOST_DIR:-$L/host}
  marker="spec=$spec"
  if [ -f "$hd/.hs-proof-host" ] && [ "$(sed -n 1p "$hd/.hs-proof-host")" = "$marker" ]; then
    HOST_KIND=$(sed -n 2p "$hd/.hs-proof-host"); host_from_kind "$HOST_KIND" "$hd"
    echo "reusing host in $hd" | redact; return 0
  fi
  if [ -e "$hd" ] && [ -n "$(ls -A "$hd" 2>/dev/null)" ]; then echo "$hd is not empty and was not prepared for $spec"; return 1; fi
  mkdir -p "$hd"
  if [[ "$spec" =~ $NPM_SPEC_RE ]]; then
    HOST_KIND=npm
    echo "npm install openclaw@$spec"
    npm install --prefix "$hd" --no-audit --no-fund --loglevel=error "openclaw@$spec" >> "$OUT/host.log" 2>&1 || return 1
  else
    HOST_KIND=git
    echo "fetch $spec from $OPENCLAW_REPO, then pnpm install + pnpm build (log: host.log)"
    { git init -q "$hd" && git -C "$hd" fetch -q --depth 1 "$OPENCLAW_REPO" "$spec" \
      && git -C "$hd" -c advice.detachedHead=false checkout -q FETCH_HEAD; } >> "$OUT/host.log" 2>&1 || return 1
    ( cd "$hd" && pnpm install --frozen-lockfile && pnpm build ) >> "$OUT/host.log" 2>&1 || return 1
  fi
  host_from_kind "$HOST_KIND" "$hd"
  printf '%s\n%s\n' "$marker" "$HOST_KIND" > "$hd/.hs-proof-host"
}
echo "== host ${OC_SPEC:-PATH}" | redact
resolve_host || { tail -20 "$OUT/host.log" 2>/dev/null | REDACT_DELTAS=1 redact; abort 3 H1 "host resolved and runs" "could not resolve host ${OC_SPEC:-PATH}"; }
HOST_VERSION=$(oc --version 2>/dev/null | tail -1)
[ -n "$HOST_VERSION" ] || abort 3 H1 "host resolved and runs" "openclaw --version printed nothing"
row H1 "host resolved and runs" "openclaw --version" "$HOST_KIND: $HOST_VERSION${HOST_COMMIT:+ (${HOST_COMMIT:0:10})}" PASS
echo "host=$HOST_VERSION kind=$HOST_KIND"

# ---- plugin ---------------------------------------------------------------------------------
resolve_plugin() {
  local spec=${PLUGIN_SPEC:-$REPO_DIR} src="" url ref
  case "$spec" in
    git+*)
      url=${spec#git+}; ref=develop
      case "$url" in *#*) ref=${url##*#}; url=${url%#*} ;; esac
      src=$L/plugin-src
      { git init -q "$src" && git -C "$src" fetch -q --depth 1 "$url" "$ref" \
        && git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD; } >> "$OUT/plugin-build.log" 2>&1 || return 1
      PLUGIN_COMMIT=$(git -C "$src" rev-parse HEAD) ;;
  esac
  if [ -z "$src" ] && [ -d "$spec" ]; then
    src=$(cd "$spec" && pwd)
    PLUGIN_COMMIT=$(git -C "$src" rev-parse HEAD 2>/dev/null || true)
    [ -n "$PLUGIN_COMMIT" ] && [ -n "$(git -C "$src" status --porcelain 2>/dev/null)" ] && PLUGIN_COMMIT="$PLUGIN_COMMIT+dirty"
  fi
  if [ -n "$src" ]; then
    mkdir -p "$L/pack"
    echo "npm ci + npm pack in $src (log: plugin-build.log)" | redact
    ( cd "$src" && npm ci --no-audit --no-fund && npm pack --pack-destination "$L/pack" ) >> "$OUT/plugin-build.log" 2>&1 || return 1
    spec=$(ls "$L"/pack/*.tgz 2>/dev/null | head -1)
    [ -n "$spec" ] || return 1
  fi
  case "$spec" in
    *.tgz)
      [ -f "$spec" ] || { echo "no such tarball: $spec"; return 1; }
      spec=$(cd "$(dirname "$spec")" && pwd)/$(basename "$spec")
      PLUGIN_VERSION=$(tar -xOzf "$spec" package/package.json 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null)
      PLUGIN_INSTALL="npm-pack:$spec"
      if [ -n "$PLUGIN_COMMIT" ]; then PLUGIN_DESC="${PLUGIN_COMMIT:0:10}${PLUGIN_COMMIT#"${PLUGIN_COMMIT%+dirty}"} packed $PLUGIN_VERSION"
      else PLUGIN_DESC="tarball $(basename "$spec")"; fi ;;
    *) PLUGIN_INSTALL=$spec; PLUGIN_DESC=$spec ;;
  esac
}
echo "== plugin"
resolve_plugin || { tail -20 "$OUT/plugin-build.log" 2>/dev/null | redact; abort 3 H2 "plugin installed in the memory slot" "could not build or find the plugin"; }

# ---- probe plugin ---------------------------------------------------------------------------
cat > "$L/probe/index.js" <<'EOF'
// Throwaway proof plugin. Records the memory audience each turn hook receives, traces every
// Hindsight request by bank, and calls the host memory provider the way bundled consumers do
// (getActiveMemoryProvider) with own, mismatched and released audiences.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

const LOG = process.env.AUDIENCE_PROBE_LOG;
const HS = new URL(process.env.AUDIENCE_PROBE_HS || "http://localhost:8888");
const CODE = process.env.AUDIENCE_PROBE_CODE || "";
const QUERY = process.env.AUDIENCE_PROBE_QUERY || "launch code word";
const DELAY = Number(process.env.AUDIENCE_PROBE_DELAY_MS || 15000);
const als = new AsyncLocalStorage();
const msg = (e) => (e instanceof Error ? e.message : String(e));
const short = (k) =>
  typeof k === "string"
    ? k.replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "$1")
    : null;
const log = (rec) => appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`);

let traced = false;
function traceHindsightIo() {
  if (traced || typeof globalThis.fetch !== "function") return;
  traced = true;
  const real = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (url.port === HS.port && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        const m = /\/banks\/([^/]+)/.exec(url.pathname);
        log({
          kind: "hindsight_io",
          op: als.getStore()?.op ?? null,
          method: init?.method ?? input?.method ?? "GET",
          bank: m ? decodeURIComponent(m[1]) : null,
          path: url.pathname.replace(/\/banks\/[^/]+/, "/banks/<bank>"),
        });
      }
    } catch {}
    return real.apply(this, arguments);
  };
}

function guardState(fn) {
  if (typeof fn !== "function") return "absent";
  try {
    fn();
    return "current";
  } catch (error) {
    return `threw: ${msg(error)}`;
  }
}

async function providerOp(api, op, p) {
  await als.run({ op }, async () => {
    const rec = {
      kind: "provider_op",
      op,
      presentedSession: short(p.sessionKey),
      audienceKind: p.audience?.kind ?? null,
    };
    const authority = p.authority ?? {
      kind: "session",
      sessionKey: p.sessionKey,
      sandboxed: false,
      audience: p.audience,
    };
    let sdk;
    try {
      sdk = await import("openclaw/plugin-sdk/memory-host-search");
    } catch (error) {
      log({ ...rec, outcome: "sdk-import-failed", error: msg(error) });
      return;
    }
    let provider = null;
    try {
      const res = await sdk.getActiveMemoryProvider({
        cfg: api.runtime.config.current(),
        agentId: p.agentId,
        context: {
          authority,
          // The most permissive caller: any rejection comes from the audience checks.
          assertCurrent: () => {},
        },
      });
      provider = res.provider;
      if (!provider) {
        log({ ...rec, outcome: "no-provider", error: res.error ?? null });
        return;
      }
      const out = await provider.search({ query: QUERY, maxResults: 5 });
      const hits = out?.hits ?? [];
      log({
        ...rec,
        outcome: "searched",
        hits: hits.length,
        hitsContainCode: CODE ? hits.some((h) => String(h.excerpt ?? "").includes(CODE)) : null,
        warning: out?.warning ?? null,
      });
    } catch (error) {
      log({ ...rec, outcome: "rejected", error: msg(error) });
    } finally {
      try {
        await provider?.close?.();
      } catch {}
    }
  });
}

let ownerStash = null;

export default {
  id: "audience-probe",
  name: "Audience probe",
  description: "Records memory audiences and provider effects for a live proof.",
  configSchema: {
    safeParse: (value) => ({ success: true, data: value }),
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  register(api) {
    traceHindsightIo();
    api.registerService({
      id: "audience-probe",
      start: () => {
        // Startup self-test of the provider path: an operator read (allowed) and an audience
        // object the host did not mint (must be rejected before the provider opens).
        setTimeout(() => {
          void (async () => {
            await providerOp(api, "startup:operator", {
              agentId: "main",
              authority: { kind: "operator", scopes: ["operator.admin"] },
            });
            await providerOp(api, "startup:forged-owner-audience", {
              agentId: "main",
              sessionKey: "agent:main:main",
              audience: Object.freeze({ kind: "owner-private", agentId: "main" }),
            });
          })();
        }, 3000).unref?.();
      },
    });
    api.on("before_prompt_build", async (_event, ctx) => {
      traceHindsightIo();
      const audience = ctx?.memoryAudience;
      log({
        kind: "hook",
        hook: "before_prompt_build",
        session: short(ctx?.sessionKey),
        audienceKind: audience?.kind ?? null,
        audienceAgentId: audience?.agentId ?? null,
        guard: guardState(ctx?.assertMemoryAudienceCurrent),
      });
      if (!audience) return;
      const self = { agentId: ctx.agentId, sessionKey: ctx.sessionKey, audience };
      await providerOp(api, `self-search:${audience.kind}`, self);
      if (audience.kind === "owner-private") {
        ownerStash = self;
      } else if (ownerStash && ownerStash.sessionKey !== ctx.sessionKey) {
        await providerOp(api, "mismatch:conversation-audience-as-owner-session", {
          ...self,
          sessionKey: ownerStash.sessionKey,
        });
        await providerOp(api, "mismatch:owner-audience-in-conversation-session", {
          ...ownerStash,
          sessionKey: ctx.sessionKey,
        });
      }
    });
    api.on("agent_end", async (event, ctx) => {
      const audience = ctx?.memoryAudience;
      log({
        kind: "hook",
        hook: "agent_end",
        session: short(ctx?.sessionKey),
        audienceKind: audience?.kind ?? null,
        audienceAgentId: audience?.agentId ?? null,
        success: event?.success ?? null,
        guard: guardState(ctx?.assertMemoryAudienceCurrent),
      });
      if (!audience) return;
      // Keep the hook ctx past the run, like a plugin that defers work, and use it later.
      const kept = { agentId: ctx.agentId, sessionKey: ctx.sessionKey, audience };
      const keptGuard = ctx.assertMemoryAudienceCurrent;
      const timer = setTimeout(() => {
        als.run({ op: "released-check" }, async () => {
          log({
            kind: "released_check",
            session: short(kept.sessionKey),
            audienceKind: audience.kind,
            delayMs: DELAY,
            guard: guardState(keptGuard),
          });
          await providerOp(api, `released:provider-open:${audience.kind}`, kept);
        });
      }, DELAY);
      timer.unref?.();
    });
  },
};
EOF
cat > "$L/probe/openclaw.plugin.json" <<'EOF'
{
  "id": "audience-probe",
  "name": "Audience probe",
  "description": "Records memory audiences and provider effects for a live proof.",
  "activation": { "onStartup": true },
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
EOF
cat > "$L/probe/package.json" <<'EOF'
{ "name": "audience-probe", "version": "0.0.0", "private": true, "type": "module",
  "main": "./index.js", "openclaw": { "extensions": ["./index.js"] } }
EOF

port_seen=$(oc config get gateway.port 2>/dev/null | tail -1)
log_seen=$(oc config get logging.file 2>/dev/null | tail -1)
echo "isolation_check gateway.port=$port_seen (want $PORT) logging.file=$(echo "$log_seen" | redact)"
{ [ "$port_seen" = "$PORT" ] && [ "$log_seen" = "$L/openclaw.log" ]; } \
  || abort 3 H2 "plugin installed in the memory slot" "isolated config not in effect (gateway.port=$port_seen, logging.file=$(echo "$log_seen" | redact))"

echo "== install $PLUGIN_DESC" | redact
oc plugins install "$PLUGIN_INSTALL" --force --accept-capabilities > "$L/install.log" 2>&1 \
  || { tail -20 "$L/install.log" | redact; abort 3 H2 "plugin installed in the memory slot" "plugins install failed: $(tail -1 "$L/install.log" | redact)"; }
grep -iE "installed plugin|hindsight" "$L/install.log" | redact | tail -3
CONF="$CONF" BANK="$BANK" HS="$HS" python3 - <<'PY'
import json, os
e = os.environ
c = json.load(open(e["CONF"]))
p = c.setdefault("plugins", {})
p["allow"] = sorted(set(p.get("allow") or []) | {"audience-probe", "hindsight-native", "anthropic"})
p.setdefault("slots", {})["memory"] = "hindsight-native"
ent = p.setdefault("entries", {})
ent["audience-probe"] = {"enabled": True, "hooks": {"allowConversationAccess": True}}
h = ent.setdefault("hindsight-native", {})
h["enabled"] = True
h["hooks"] = {"allowConversationAccess": True}
h["config"] = {
  "hindsightApiUrl": e["HS"],
  "hindsightApiToken": {"source": "file", "provider": "hindsight", "id": "value"},
  "agentBankMap": {"main": e["BANK"]},
  "memoryMode": "context",
  "retainMission": "Extract durable facts the user states about themselves.",
}
json.dump(c, open(e["CONF"], "w"), indent=2)
PY
oc config validate > "$L/validate.log" 2>&1 \
  || { redact < "$L/validate.log" | tail -20; abort 3 H2 "plugin installed in the memory slot" "config validate failed"; }
slot=$(oc config get plugins.slots.memory 2>/dev/null | tail -1)
[ "$slot" = hindsight-native ] || abort 3 H2 "plugin installed in the memory slot" "memory slot is '$slot'"
[ -n "$PLUGIN_VERSION" ] || PLUGIN_VERSION=$(python3 - "$OPENCLAW_STATE_DIR" <<'PY'
import json, os, sys
for root, dirs, files in os.walk(sys.argv[1]):
    dirs[:] = [d for d in dirs if d not in (".git", "workspace")]
    if "openclaw.plugin.json" in files and "package.json" in files:
        try:
            if json.load(open(os.path.join(root, "openclaw.plugin.json"))).get("id") == "hindsight-native":
                print(json.load(open(os.path.join(root, "package.json"))).get("version", "")); break
        except Exception:
            pass
PY
)
row H2 "plugin installed in the memory slot" "hindsight-native in plugins.slots.memory" \
  "${PLUGIN_VERSION:-unknown version}, slot=$slot" PASS

# ---- gateway --------------------------------------------------------------------------------
call() { oc gateway call "$1" --json --timeout "${3:-60000}" --params "$2" 2>>"$L/calls.err"; }
echo "== gateway 127.0.0.1:$PORT"
claude_snapshot
if [ -s "$ANTHF" ]; then
  ( export ANTHROPIC_API_KEY; ANTHROPIC_API_KEY=$(cat "$ANTHF"); exec "${OC[@]}" gateway run --port "$PORT" --bind loopback --verbose ) > "$L/gateway.log" 2>&1 &
else
  ( exec "${OC[@]}" gateway run --port "$PORT" --bind loopback --verbose ) > "$L/gateway.log" 2>&1 &
fi
GW=$!
ready=0; i=0
for i in $(seq 1 180); do
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then ready=1; break; fi
  kill -0 "$GW" 2>/dev/null || break
  sleep 2
done
echo "gateway_ready=$ready after ~$((i * 2))s"
[ "$ready" = 1 ] || { tail -30 "$L/gateway.log" | REDACT_DELTAS=1 redact; abort 3 H3 "gateway up, memory.status from the plugin" "gateway did not start"; }
sleep 5
echo "== memory.status"
call memory.status '{"agentId":"main"}' > "$L/memory-status.json"
redact < "$L/memory-status.json" > "$OUT/memory-status.json"
head -c 600 "$OUT/memory-status.json"; echo
ms=$(python3 - "$L/memory-status.json" <<'PY'
import json, sys
try: j = json.load(open(sys.argv[1]))
except Exception: print("unparsable"); sys.exit()
s = json.dumps(j)
keys = [k for k in ("provider", "backend", "status", "state", "ready") if isinstance(j, dict) and k in j]
print(("hindsight " if "hindsight" in s.lower() else "no-hindsight ") + ",".join(f"{k}={j[k]}" for k in keys))
PY
)
case "$ms" in hindsight*) ms_ok=PASS ;; *) ms_ok=FAIL ;; esac
row H3 "gateway up, memory.status from the plugin" "status names hindsight" "$ms" "$ms_ok"
grep -a -E "memory-hindsight|audience-probe" "$L/gateway.log" | REDACT_DELTAS=1 redact | cut -c1-220 | tail -4
sleep 5
echo "== probe startup self-test"
grep -E '"op":"startup' "$L/probe/probe.jsonl" 2>/dev/null | sed "s/$BANK/<bank>/g" | cut -c1-300

# ---- gateway metrics (plugin route on the gateway port, gateway auth) ------------------------
METRICS_PATH=/plugins/hindsight-native/metrics
metrics() {  # metrics OUTFILE [noauth]: prints the HTTP status; the token stays in a header file
  if [ "${2:-}" = noauth ]; then
    curl -s -m 15 -o "$1" -w '%{http_code}' "http://127.0.0.1:$PORT$METRICS_PATH"
  else
    curl -s -m 15 -o "$1" -w '%{http_code}' -H @"$L/gw-auth.hdr" "http://127.0.0.1:$PORT$METRICS_PATH"
  fi
}
msum() {  # msum FILE FAMILY: sum of the family's samples, 0 when it has none
  python3 - "$1" "$2" <<'PY'
import sys
total = 0.0
try:
    for line in open(sys.argv[1]):
        if line.startswith(sys.argv[2] + "{") or line.startswith(sys.argv[2] + " "):
            total += float(line.rsplit(" ", 1)[1])
except OSError:
    pass
print(int(total))
PY
}
echo "== gateway metrics before turns"
m0=$(metrics "$L/metrics-0.prom"); mu=$(metrics /dev/null noauth)
fams=$(cat "$L/metrics-0.prom" 2>/dev/null | grep -c -E '^# TYPE openclaw_hindsight_')
mok=FAIL; [ "$m0" = 200 ] && [ "$fams" = 7 ] && case "$mu" in 401|403) mok=PASS ;; esac
row G1 "metrics route on the gateway port" "200 with 7 families; 401/403 without auth" "status=$m0 families=$fams noauth=$mu" "$mok"
sed "s/$BANK/<bank>/g" "$L/metrics-0.prom" > "$OUT/metrics-before.prom" 2>/dev/null

# ---- turns ----------------------------------------------------------------------------------
: > "$OUT/marks.tsv"
mark() { printf '%s\t%s\n' "$1" "$(python3 -c 'import datetime as d; print(d.datetime.now(d.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")')" >> "$OUT/marks.tsv"; }
skipped() { grep -a -c "auto-retain skipped" "$L/gateway.log" 2>/dev/null || true; }
wait_bank() {  # wait_bank BANK SECONDS SKIPS_BEFORE: documents >= 1 and nothing pending
  local b n=0; b=$(enc "$1")
  for _ in $(seq 1 $(( $2 / 5 ))); do
    if hs "$HS/v1/default/banks/$b/stats" 2>/dev/null | python3 -c '
import json, sys
j = json.load(sys.stdin)
sys.exit(0 if j.get("total_documents", 0) >= 1 and j.get("pending_operations", 1) == 0 else 1)' 2>/dev/null
    then echo "bank_ready=$1"; return 0; fi
    # The plugin logged a skipped retain for this turn: nothing will land, stop waiting soon.
    [ "$(skipped)" -gt "${3:-999999}" ] && n=$((n + 1)) && [ "$n" -ge 3 ] && break
    sleep 5
  done
  echo "bank_not_ready=$1"; return 1
}
QUESTION="What is my launch code word? Answer with just the code word, or say you do not know."

if [ "$TURNS" = 1 ]; then
  KEY_A=$(call sessions.create '{"agentId":"main"}' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("key",""))' 2>/dev/null)
  [ -n "$KEY_A" ] || abort 3 R1 "turns ran on the requested runtime" "sessions.create returned no key"
  echo "owner session=$(echo "$KEY_A" | redact)"
  echo "== owner turn 1 (states the fact)"
  s0=$(skipped)
  mark turn1_start
  with_timeout 600 "${OC[@]}" agent --session-key "$KEY_A" --json \
    --message "Please remember this for later: my launch city is Lisbon and my launch code word is $CODE. Reply with one short sentence." \
    > "$L/turn1.out" 2>&1
  e1=$?; echo "agent_exit=$e1"
  mark turn1_end
  wait_bank "$BANK" "$BANK_WAIT" "$s0"
  echo "== owner turn 2 (same session, asks for it)"
  mark turn2_start
  with_timeout 600 "${OC[@]}" agent --session-key "$KEY_A" --json --message "$QUESTION" > "$L/turn2.out" 2>&1
  e2=$?; echo "agent_exit=$e2"
  mark turn2_end
  printf 'turn1\t%s\nturn2\t%s\n' "$e1" "$e2" > "$OUT/exits.tsv"
  sleep $(( DELAY_MS / 1000 + 10 ))

  KEY_B=agent:main:dashboard:$(node -e 'console.log(crypto.randomUUID())')
  echo "== conversation turn via chat.send, session=$(echo "$KEY_B" | redact)"
  s1=$(skipped)
  mark conv_start
  res=$(call chat.send "$(node -e 'console.log(JSON.stringify({sessionKey:process.argv[1],message:process.argv[2],idempotencyKey:crypto.randomUUID()}))' "$KEY_B" "$QUESTION")")
  run=$(node -e 'try{const j=JSON.parse(process.argv[1]);console.log(j.runId??j.result?.runId??"")}catch{console.log("")}' "$res")
  echo "chat.send run=${run:0:8}"
  [ -n "$run" ] && call agent.wait "{\"runId\":\"$run\",\"timeoutMs\":600000}" 660000 > "$L/conv.wait" 2>&1
  # Also wait on the transcript, in case the send result carries no run id.
  for _ in $(seq 1 120); do
    call chat.history "{\"sessionKey\":\"$KEY_B\",\"limit\":20}" > "$L/conv.history" 2>&1
    python3 -c '
import json, sys
def walk(o):
    if isinstance(o, dict):
        if o.get("role") == "assistant": return True
        return any(walk(v) for v in o.values())
    if isinstance(o, list): return any(walk(v) for v in o)
    return False
try: sys.exit(0 if walk(json.load(open(sys.argv[1]))) else 1)
except Exception: sys.exit(1)' "$L/conv.history" && break
    sleep 5
  done
  echo "conversation reply present=$(grep -c '"assistant"' "$L/conv.history" 2>/dev/null)"
  mark conv_end
  n=0
  for _ in $(seq 1 $(( BANK_WAIT / 5 ))); do
    CB=$(proof_banks | grep -F "$BANK::conv::" | head -1)
    if [ -n "$CB" ]; then wait_bank "$CB" "$BANK_WAIT" "$s1"; break; fi
    [ "$(skipped)" -gt "$s1" ] && n=$((n + 1)) && [ "$n" -ge 3 ] && break
    sleep 5
  done
  sleep $(( DELAY_MS / 1000 + 10 ))
else
  echo "== turns skipped: $SKIP_REASON"
fi

echo "== gateway metrics after turns"
m1=$(metrics "$L/metrics-1.prom")
if [ "$TURNS" = 1 ]; then
  # agent_end runs unawaited: give the last of the 3 turns' retains up to 30 s to show up.
  tw=$(( $(msum "$L/metrics-0.prom" openclaw_hindsight_retain_total) + 3 ))
  for _ in $(seq 1 15); do
    [ "$(msum "$L/metrics-1.prom" openclaw_hindsight_retain_total)" -ge "$tw" ] && break
    sleep 2; m1=$(metrics "$L/metrics-1.prom")
  done
fi
sed "s/$BANK/<bank>/g" "$L/metrics-1.prom" > "$OUT/metrics-after.prom" 2>/dev/null
r0=$(msum "$L/metrics-0.prom" openclaw_hindsight_recall_total); r1=$(msum "$L/metrics-1.prom" openclaw_hindsight_recall_total)
t0=$(msum "$L/metrics-0.prom" openclaw_hindsight_retain_total); t1=$(msum "$L/metrics-1.prom" openclaw_hindsight_retain_total)
mgot="status=$m1 recall $r0->$r1 retain $t0->$t1"
if [ "$TURNS" = 1 ]; then
  m2=FAIL; [ "$m1" = 200 ] && [ "$r1" -gt "$r0" ] && [ "$t1" -gt "$t0" ] && m2=PASS
  row G2 "metrics change after turns" "recall_total and retain_total grow" "$mgot" "$m2"
else
  row G2 "metrics change after turns" "recall_total and retain_total grow" "$SKIP_REASON; $mgot" SKIP
fi

# ---- collect --------------------------------------------------------------------------------
echo "== collect"
stop_gateway
for b in $(proof_banks); do
  hs "$HS/v1/default/banks/$(enc "$b")/documents?limit=100" > "$L/docs.list" 2>/dev/null
  python3 -c 'import json,sys; [print(d["id"]) for d in json.load(open(sys.argv[1])).get("items",[])]' "$L/docs.list" 2>/dev/null \
  | while read -r id; do
      hs "$HS/v1/default/banks/$(enc "$b")/documents/$(enc "$id")" \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); d["_bank"]=sys.argv[1]; print(json.dumps(d))' "$b"
    done
done > "$L/documents.jsonl"
if [ -f "$L/probe/probe.jsonl" ]; then redact < "$L/probe/probe.jsonl" > "$OUT/probe.jsonl"; else : > "$OUT/probe.jsonl"; fi
grep -a -E "memory-hindsight|cli turn|audience" "$L/gateway.log" | REDACT_DELTAS=1 redact | cut -c1-400 > "$OUT/gateway-memory.log"
if [ -n "$CODE" ]; then
  ( cd "$L/workspace" 2>/dev/null && grep -a -r -l -F -- "$CODE" . 2>/dev/null | grep -v '^\./\.git/' | sort ) > "$OUT/workspace-code.txt" || true
else
  : > "$OUT/workspace-code.txt"
fi
REDACT_DELTAS=1 redact < "$L/gateway.log" > "$OUT/gateway.log"
[ -f "$L/openclaw.log" ] && REDACT_DELTAS=1 redact < "$L/openclaw.log" > "$OUT/openclaw.log"
for f in turn1.out turn2.out conv.wait conv.history install.log; do [ -f "$L/$f" ] && redact < "$L/$f" > "$OUT/$f"; done

OUT="$OUT" L="$L" BANK="$BANK" CODE="$CODE" python3 - <<'PY' > "$OUT/documents.md"
import json, os, re
e = os.environ
uuid = re.compile(r"([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
docs = [json.loads(l) for l in open(e["L"] + "/documents.jsonl") if l.strip()]
json.dump(docs, open(e["OUT"] + "/documents.json", "w"), indent=1)
print(f"documents in banks {e['BANK']}* ({len(docs)}):")
red = lambda s: uuid.sub(r"\1", s or "").replace(e["BANK"], "<bank>")
for d in docs:
    md = d.get("document_metadata") or {}
    raw = d.get("original_text") or ""
    print("- bank=%s id=%s audience=%s session=%s messages=%s units=%s contains_code=%s" % (
        red(d["_bank"]), red(d["id"]), md.get("audience"), red(md.get("session_key")),
        md.get("message_count"), d.get("memory_unit_count"), e["CODE"] in raw))
    print("    text: " + red(raw).replace("\n", " | ")[:300])
PY
redact < "$OUT/documents.md" > "$OUT/documents.md.tmp" && mv "$OUT/documents.md.tmp" "$OUT/documents.md"
redact < "$OUT/documents.json" > "$OUT/documents.json.tmp" && mv "$OUT/documents.json.tmp" "$OUT/documents.json"
cat "$OUT/documents.md"

# ---- checks ---------------------------------------------------------------------------------
OWNER_KEY="$(printf '%s' "${KEY_A:-}" | redact)" OUT="$OUT" BANK="$BANK" CODE="$CODE" TURNS="$TURNS" SKIP_REASON="$SKIP_REASON" MODEL="$MODEL" \
RUNTIME="$RUNTIME" python3 - <<'PY' >> "$CHECKS"
import json, os, re
e = os.environ
OUT, BANK, CODE = e["OUT"], e["BANK"], e["CODE"]
turns = e["TURNS"] == "1"
probe = [json.loads(l) for l in open(OUT + "/probe.jsonl") if l.strip()]
glog = open(OUT + "/gateway-memory.log").read()
docs = json.load(open(OUT + "/documents.json"))
marks = dict(l.rstrip("\n").split("\t") for l in open(OUT + "/marks.tsv") if l.strip())
read = lambda f: open(OUT + "/" + f).read() if os.path.exists(OUT + "/" + f) else ""
rows = []
def row(i, check, want, observed, ok):
    rows.append((i, check, want, str(observed), "PASS" if ok else "FAIL"))
def skip(i, check, want):
    rows.append((i, check, want, e["SKIP_REASON"], "SKIP"))

hooks = [p for p in probe if p.get("kind") == "hook"]
ops = [p for p in probe if p.get("kind") == "provider_op"]
io = [p for p in probe if p.get("kind") == "hindsight_io"]
rel = [p for p in probe if p.get("kind") == "released_check"]
def win(a, b):
    lo, hi = marks.get(a), marks.get(b)
    return lambda p: lo is not None and p["at"] >= lo and (hi is None or p["at"] <= hi)
owner_docs = [d for d in docs if d["_bank"] == BANK]
conv_docs = [d for d in docs if d["_bank"].startswith(BANK + "::conv::")]
meta = lambda d: d.get("document_metadata") or {}
red = lambda s: str(s).replace(BANK, "<bank>")

so = [o for o in ops if o["op"] == "startup:operator"]
sio = [x for x in io if x["op"] == "startup:operator"]
row("S1", "probe path works: operator read via host provider", "searched, I/O owner bank",
    f"{[(o['outcome'], o.get('hits') if o['outcome'] == 'searched' else o.get('error')) for o in so]}; io banks={sorted({red(x['bank']) for x in sio})}",
    bool(so) and all(o["outcome"] == "searched" for o in so) and bool(sio) and all(x["bank"] == BANK for x in sio))
sf = [o for o in ops if o["op"] == "startup:forged-owner-audience"]
sfio = [x for x in io if x["op"] == "startup:forged-owner-audience"]
row("S2", "audience object not minted by the host", "rejected, 0 Hindsight I/O",
    f"{[(o['outcome'], o.get('error')) for o in sf]}; io={len(sfio)}",
    bool(sf) and all(o["outcome"] == "rejected" and "host-minted" in (o.get("error") or "") for o in sf) and not sfio)

TURN_ROWS = [
    ("R1", "turns ran on the requested runtime", "exit 0, provider " + e["MODEL"].split("/")[0]),
    ("A1", "owner turns: hooks get owner-private audience, guard current", "4 hooks"),
    ("A2", "turn 1 agent_end retained to owner bank", ">=1 log + doc with code"),
    ("A3", "turn 2 before_prompt_build recalled; reply has the code", "inject>=1, reply has code"),
    ("A4", "host provider, owner audience in its own session", "searched, hits have code, I/O owner bank only"),
    ("B1", "chat.send turn: hooks get conversation audience", "conversation"),
    ("B2", "conversation turn cannot see the owner fact", "reply and searches without code"),
    ("B3", "Hindsight I/O after conversation start never touches owner bank", "only <bank>::conv::*"),
    ("B4", "conversation retain lands in its own bank", "doc audience=conversation, no code"),
    ("M1", "mismatched session: conversation audience as owner session", "rejected, 0 Hindsight I/O"),
    ("M2", "mismatched session: owner audience in conversation session", "rejected, 0 Hindsight I/O"),
    ("C1", "agent_end ctx kept, guard called ~15 s after run end", "throws released"),
    ("C2", "host provider open with the kept audience after run end", "rejected, 0 Hindsight I/O"),
]
if not turns:
    for r in TURN_ROWS:
        skip(*r)
else:
    T = {r[0]: r for r in TURN_ROWS}
    exits = dict(l.rstrip("\n").split("\t") for l in open(OUT + "/exits.tsv") if l.strip())
    want_provider = e["MODEL"].split("/")[0]
    def provider_of(text):
        try: j = json.loads(text)
        except Exception: return None
        stack = [j]
        while stack:
            o = stack.pop()
            if isinstance(o, dict):
                spr = o.get("systemPromptReport")
                if isinstance(spr, dict) and spr.get("provider"): return spr["provider"]
                stack.extend(o.values())
            elif isinstance(o, list): stack.extend(o)
        return None
    seen = provider_of(read("turn1.out"))
    if seen is None:
        m = re.search(r"cli turn: provider=(\S+)", glog)
        seen = m.group(1) if m else ("no cli turn line" if e["RUNTIME"] == "embedded" else None)
    prov_ok = seen == want_provider or (e["RUNTIME"] == "embedded" and seen == "no cli turn line")
    row(*T["R1"][:3], f"exits={exits.get('turn1')},{exits.get('turn2')}; provider={seen}",
        exits.get("turn1") == "0" and exits.get("turn2") == "0" and prov_ok)

    # agent_end can fire after the CLI command returns, so the owner window runs to conv_start.
    # Only the owner session's hooks: other sessions (main-session or heartbeat turns) can run
    # in the same window and are not owner turns.
    oh = [h for h in hooks if win("turn1_start", "conv_start")(h) and h.get("session") == e["OWNER_KEY"]]
    kinds = sorted({f"{h['hook']}={h['audienceKind']}/{h['guard'].split(':')[0]}" for h in oh})
    row(*T["A1"][:3], f"{len(oh)} hooks {kinds}",
        len(oh) >= 4 and all(h["audienceKind"] == "owner-private" and h["guard"] == "current" for h in oh))
    m = re.findall(r"retained (\d+) messages \(owner-private\)", glog)
    row(*T["A2"][:3],
        f"log lines={len(m)}; owner docs={len(owner_docs)}, with code={sum(CODE in (d.get('original_text') or '') for d in owner_docs)}",
        len(m) >= 1 and any(CODE in (d.get("original_text") or "") and meta(d).get("audience") == "owner-private" for d in owner_docs))
    inj = re.findall(r"injecting (\d+) memories", glog)
    t2 = read("turn2.out")
    row(*T["A3"][:3], f"inject lines={inj}; reply_has_code={CODE in t2}", len(inj) >= 1 and CODE in t2)
    s2 = [o for o in ops if o["op"] == "self-search:owner-private" and win("turn2_start", "turn2_end")(o)]
    s2io = [x for x in io if x["op"] == "self-search:owner-private" and win("turn2_start", "turn2_end")(x)]
    row(*T["A4"][:3],
        f"{[(o['outcome'], o.get('hits'), o.get('hitsContainCode')) for o in s2]}; io banks={sorted({red(x['bank']) for x in s2io})}",
        bool(s2) and all(o["outcome"] == "searched" and o.get("hitsContainCode") for o in s2)
        and bool(s2io) and all(x["bank"] == BANK for x in s2io))

    ch = [h for h in hooks if win("conv_start", None)(h)]
    row(*T["B1"][:3], sorted({f"{h['hook']}={h['audienceKind']}/{h['guard'].split(':')[0]}" for h in ch}),
        bool(ch) and all(h["audienceKind"] == "conversation" and h["guard"] == "current" for h in ch))
    hist = read("conv.history")
    cs = [o for o in ops if o["op"] == "self-search:conversation"]
    wsc = [l for l in read("workspace-code.txt").splitlines() if l.strip()]
    # Paths around Hindsight that tools.deny removes. If a host renames a tool group they come
    # back, and B2 must say so instead of reading like a plugin leak.
    BYPASS = {"ls", "read", "write", "edit", "apply_patch", "exec", "bash", "process", "code_execution",
              "sessions_history", "sessions_search", "sessions_list", "sessions_send", "sessions_spawn",
              "conversations_list", "conversations_send", "conversations_turn", "computer", "nodes", "openclaw"}
    def offered(text):
        # None when no tool report is found: B2 must not read that as "deny took effect".
        dec, found, names = json.JSONDecoder(), False, set()
        i = text.find("{")
        while i != -1:
            try: j, end = dec.raw_decode(text, i)
            except ValueError: i = text.find("{", i + 1); continue
            stack = [j]
            while stack:
                o = stack.pop()
                if isinstance(o, dict):
                    spr = o.get("systemPromptReport")
                    if isinstance(spr, dict) and isinstance(spr.get("tools"), dict):
                        found, t = True, spr["tools"]
                        for grp in (t.get("entries") or [], (t.get("deferred") or {}).get("entries") or []):
                            names |= {x.get("name") for x in grp if isinstance(x, dict)}
                    stack.extend(o.values())
                elif isinstance(o, list): stack.extend(o)
            i = text.find("{", end)
        # An empty list (renamed or missing entries) is as unknown as no report.
        return names if found and names else None
    on = offered(read("turn1.out"))
    off = sorted(on & BYPASS) if on is not None else "unknown (no systemPromptReport tools)"
    # Embedded histories record toolCall parts; claude-cli histories hold text only, so used=[]
    # on a claude-cli cell does not mean no tool ran.
    used = sorted(set(re.findall(r'"type":\s*"toolCall"[^{}]*?"name":\s*"([^"]+)"', hist)) & BYPASS)
    row(*T["B2"][:3],
        f"history_has_code={CODE in hist}; self-search={[(o['outcome'], o.get('hits'), o.get('hitsContainCode')) for o in cs]}; "
        f"workspace files with code={wsc}; bypass tools offered={off}, used in conversation={used}",
        bool(hist) and CODE not in hist and bool(cs) and all(o["outcome"] == "searched" and not o.get("hitsContainCode") for o in cs)
        and not wsc and on is not None and not off and not used)
    cio = [x for x in io if win("conv_start", None)(x) and x["bank"]
           and x["op"] != "released-check" and not str(x["op"]).startswith("released:")]
    row(*T["B3"][:3], f"{len(cio)} requests, banks={sorted({red(x['bank']) for x in cio})}",
        bool(cio) and all(x["bank"].startswith(BANK + "::conv::") for x in cio))
    row(*T["B4"][:3],
        f"conv docs={[(meta(d).get('audience'), CODE in (d.get('original_text') or '')) for d in conv_docs]}; owner docs={len(owner_docs)}",
        bool(conv_docs) and all(meta(d).get("audience") == "conversation" and CODE not in (d.get("original_text") or "") for d in conv_docs)
        and not any(meta(d).get("audience") == "conversation" for d in owner_docs))

    for i, op in (("M1", "mismatch:conversation-audience-as-owner-session"), ("M2", "mismatch:owner-audience-in-conversation-session")):
        o = [x for x in ops if x["op"] == op]
        oio = [x for x in io if x["op"] == op]
        row(*T[i][:3], f"{[(x['outcome'], x.get('error')) for x in o]}; io={len(oio)}",
            bool(o) and all(x["outcome"] == "rejected" and "different session" in (x.get("error") or "") for x in o) and not oio)

    row(*T["C1"][:3], f"{len(rel)} checks: {sorted({(r['audienceKind'], r['guard']) for r in rel})}",
        bool(rel) and all(r["guard"].startswith("threw:") and "released" in r["guard"] for r in rel))
    ro = [o for o in ops if o["op"].startswith("released:")]
    rio = [x for x in io if str(x["op"]).startswith("released")]
    row(*T["C2"][:3], f"{sorted({(o['audienceKind'], o['outcome'], o.get('error')) for o in ro})}; io={len(rio)}",
        bool(ro) and all(o["outcome"] == "rejected" and "released" in (o.get("error") or "") for o in ro) and not rio)
for r in rows:
    print("\t".join(x.replace("\t", " ").replace("\n", " ") for x in r))
PY
[ "${PIPESTATUS[0]}" = 0 ] || abort 3 R0 "checks evaluated" "the check script failed"
echo "== plugin log lines"
grep -a -E "memory-hindsight: (retained|injecting|auto-recall|auto-retain)" "$OUT/gateway-memory.log" | sed "s/$BANK/<bank>/g" | tail -12
exit 0
