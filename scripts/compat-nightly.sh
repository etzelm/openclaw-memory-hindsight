#!/usr/bin/env bash
# Nightly compatibility run, meant for launchd (see docs/compat-matrix.md). Fetches this package
# at HS_COMPAT_REF from HS_COMPAT_REPO into a fresh scratch dir, runs scripts/compat-matrix.sh
# from that checkout (so the harness and the plugin are the tested ref), copies the run dir to
# HS_COMPAT_RESULTS and deletes the scratch dir.
#
# Environment:
#   HS_COMPAT_REPO     git URL or path of this package (required)
#   HS_COMPAT_REF      ref to fetch (default develop). latest-release fetches the highest
#                      vX.Y.Z tag in HS_COMPAT_REPO, so the run tests the latest release. The
#                      harness then runs from that tag with the run's credentials, so anyone who
#                      can push a vX.Y.Z tag there can run code with them: keep a tag ruleset on
#                      (RELEASING.md, one-time setup step 4) or use a mirror only you can write.
#   HS_COMPAT_RESULTS  results destination, passed to --results-dest (required)
#   HS_COMPAT_ARGS     extra compat-matrix.sh arguments, split on spaces (token and key files)
#   HS_COMPAT_PRE      optional command run first, for example one that refreshes a mirror
#   HS_COMPAT_STATUS_FILE  optional Prometheus textfile (*.prom): last attempt, last run, last
#                      success, exit code. Rewritten by every start except one that finds another
#                      run holding the lock (that start leaves it alone); a start that cannot
#                      write WORK_ROOT writes it with exit code 4 before it reaches the lock.
#   WORK_ROOT          scratch parent (default ~/work)
#   RESULTS_PUT        copy command for the results (default cp -R)
# One run at a time per WORK_ROOT: a second start while one runs (the agent loaded in two launchd
# domains, or a manual kickstart) logs that and exits 0. The lock is stale, and replaced with a
# log line, when its pid is not running this same script (command line ending in this script's
# path) or when it is older than HS_COMPAT_LOCK_MAX_MIN minutes (default 720, 12 h).
#   HS_COMPAT_LOCK_MAX_MIN  lock age after which it counts as stale
# Exit: the compat-matrix.sh exit code, 2 when the checkout could not be fetched, 4 when
# WORK_ROOT cannot be written (on macOS often a privacy denial, see docs/compat-matrix.md).
set -u
umask 077
: "${HS_COMPAT_REPO:?set HS_COMPAT_REPO}" "${HS_COMPAT_RESULTS:?set HS_COMPAT_RESULTS}"
REF=${HS_COMPAT_REF:-develop}
WORK_ROOT=${WORK_ROOT:-$HOME/work}
export WORK_ROOT
STATUS=${HS_COMPAT_STATUS_FILE:-}
LOCK=$WORK_ROOT/.hs-compat-nightly.lock
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
LOCK_MAX_MIN=${HS_COMPAT_LOCK_MAX_MIN:-720}
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# write_status EXIT: rewrites STATUS atomically. The run and success times carry over from the
# previous file unless this start ran the matrix (exit 0, 1 or 3) or passed (exit 0).
write_status() {
  [ -n "$STATUS" ] || return 0
  local st=$1 now prev_run prev_ok tmp
  now=$(date +%s)
  prev_run=$(sed -n 's/^hs_compat_nightly_last_run_timestamp_seconds \([0-9][0-9]*\)$/\1/p' "$STATUS" 2>/dev/null)
  prev_ok=$(sed -n 's/^hs_compat_nightly_last_success_timestamp_seconds \([0-9][0-9]*\)$/\1/p' "$STATUS" 2>/dev/null)
  case "$st" in 0|1|3) prev_run=$now ;; esac
  [ "$st" = 0 ] && prev_ok=$now
  tmp="$STATUS.tmp"
  mkdir -p "$(dirname "$STATUS")" 2>/dev/null
  if {
    echo "# HELP hs_compat_nightly_last_attempt_timestamp_seconds Unix time compat-nightly.sh last started without finding another run holding its lock."
    echo "# TYPE hs_compat_nightly_last_attempt_timestamp_seconds gauge"
    echo "hs_compat_nightly_last_attempt_timestamp_seconds $now"
    echo "# HELP hs_compat_nightly_last_run_timestamp_seconds Unix time the compat matrix last ran to the end (exit 0, 1 or 3)."
    echo "# TYPE hs_compat_nightly_last_run_timestamp_seconds gauge"
    echo "hs_compat_nightly_last_run_timestamp_seconds ${prev_run:-0}"
    echo "# HELP hs_compat_nightly_last_success_timestamp_seconds Unix time the compat matrix last had every cell as expected (exit 0)."
    echo "# TYPE hs_compat_nightly_last_success_timestamp_seconds gauge"
    echo "hs_compat_nightly_last_success_timestamp_seconds ${prev_ok:-0}"
    echo "# HELP hs_compat_nightly_last_exit_code Exit code of the last compat-nightly.sh start (0 ok, 1 unexpected cell, 2 fetch or usage, 3 partial, 4 WORK_ROOT not writable)."
    echo "# TYPE hs_compat_nightly_last_exit_code gauge"
    echo "hs_compat_nightly_last_exit_code $st"
  } > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$STATUS" 2>/dev/null || echo "warning: could not write $STATUS"
  else
    rm -f "$tmp" 2>/dev/null
    echo "warning: could not write $STATUS"
  fi
}

# A LaunchAgent started by a process without access to WORK_ROOT's volume (on macOS a job
# bootstrapped from cron after a reboot has no access to an external disk) cannot create the
# lock. Say so instead of reporting it as another run holding the lock.
probe=""
if ! mkdir -p "$WORK_ROOT" 2>/dev/null || ! probe=$(mktemp -d "$WORK_ROOT/.hs-compat-probe.XXXXXX" 2>/dev/null); then
  echo "== $(now_utc) cannot write $WORK_ROOT; not starting. On macOS this is usually a privacy"
  echo "   denial: start the job through a binary with Full Disk Access (docs/compat-matrix.md)."
  write_status 4
  exit 4
fi
rmdir "$probe"

# holds_lock PID: PID is another process running this script (its command line ends in SELF).
# After a reboot an old pid can belong to anything, so a substring match is not enough.
holds_lock() {
  local cmd
  [ -n "$1" ] && [ "$1" != "$$" ] || return 1
  cmd=$(ps -p "$1" -o command= 2>/dev/null) || return 1
  case "$cmd" in "$SELF"|*" $SELF") return 0 ;; esac
  return 1
}
if ! mkdir "$LOCK" 2>/dev/null; then
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  # The other copy may not have written its pid yet.
  [ -n "$pid" ] || { sleep 2; pid=$(cat "$LOCK/pid" 2>/dev/null); }
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +"$LOCK_MAX_MIN" 2>/dev/null)" ]; then
    echo "removing a stale lock (older than $LOCK_MAX_MIN min, pid ${pid:-unknown})"
  elif holds_lock "$pid"; then
    echo "== $(now_utc) another nightly run (pid $pid) holds $LOCK; not starting"
    exit 0
  else
    echo "removing a stale lock (pid ${pid:-unknown} is not running $SELF)"
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "== $(now_utc) another nightly run took $LOCK; not starting"; exit 0; }
fi
echo "$$" > "$LOCK/pid"
D=$(mktemp -d "$WORK_ROOT/hs-compat-nightly.XXXXXX") || { rm -rf "$LOCK"; write_status 4; exit 4; }
trap 'st=$?; rm -rf "$D" "$LOCK"; write_status "$st"; exit "$st"' EXIT
echo "== $(now_utc) nightly ref=$REF"
if [ -n "${HS_COMPAT_PRE:-}" ]; then
  bash -c "$HS_COMPAT_PRE" || echo "warning: HS_COMPAT_PRE failed; testing the last fetched $REF"
fi
if [ "$REF" = latest-release ]; then
  # A failed listing is not "no tags": say which one it was.
  tags=$(git ls-remote --tags --refs "$HS_COMPAT_REPO" 'v*' 2>/dev/null) \
    || { echo "could not list tags in $HS_COMPAT_REPO"; exit 2; }
  tag=$(printf '%s\n' "$tags" | sed 's#^.*refs/tags/##' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1)
  [ -n "$tag" ] || { echo "no vX.Y.Z tag found in $HS_COMPAT_REPO"; exit 2; }
  echo "latest release $tag"
  REF=refs/tags/$tag
fi
{ git init -q "$D/repo" && git -C "$D/repo" fetch -q --depth 1 "$HS_COMPAT_REPO" "$REF" \
  && git -C "$D/repo" -c advice.detachedHead=false checkout -q FETCH_HEAD; } || { echo "fetch of $REF failed"; exit 2; }
echo "package commit $(git -C "$D/repo" rev-parse --short=10 HEAD) version $(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$D/repo/package.json")"
# shellcheck disable=SC2086 # HS_COMPAT_ARGS is a space-separated argument list by design
"$D/repo/scripts/compat-matrix.sh" --plugin "$D/repo" --results-dest "$HS_COMPAT_RESULTS" ${HS_COMPAT_ARGS:-}
