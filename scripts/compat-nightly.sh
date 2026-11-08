#!/usr/bin/env bash
# Nightly compatibility run, meant for launchd (see docs/compat-matrix.md). Fetches this package
# at HS_COMPAT_REF from HS_COMPAT_REPO into a fresh scratch dir, runs scripts/compat-matrix.sh
# from that checkout (so the harness and the plugin are the tested ref), copies the run dir to
# HS_COMPAT_RESULTS and deletes the scratch dir.
#
# Environment:
#   HS_COMPAT_REPO     git URL or path of this package (required)
#   HS_COMPAT_REF      ref to fetch (default develop)
#   HS_COMPAT_RESULTS  results destination, passed to --results-dest (required)
#   HS_COMPAT_ARGS     extra compat-matrix.sh arguments, split on spaces (token and key files)
#   HS_COMPAT_PRE      optional command run first, for example one that refreshes a mirror
#   WORK_ROOT          scratch parent (default ~/work)
#   RESULTS_PUT        copy command for the results (default cp -R)
# One run at a time per WORK_ROOT: a second start while one runs (the agent loaded in two launchd
# domains, or a manual kickstart) logs that and exits 0. The lock is stale, and replaced with a
# log line, when its pid is not running this same script (command line ending in this script's
# path) or when it is older than HS_COMPAT_LOCK_MAX_MIN minutes (default 720, 12 h).
#   HS_COMPAT_LOCK_MAX_MIN  lock age after which it counts as stale
# Exit: the compat-matrix.sh exit code, or 2 when the checkout could not be fetched.
set -u
umask 077
: "${HS_COMPAT_REPO:?set HS_COMPAT_REPO}" "${HS_COMPAT_RESULTS:?set HS_COMPAT_RESULTS}"
REF=${HS_COMPAT_REF:-develop}
WORK_ROOT=${WORK_ROOT:-$HOME/work}
export WORK_ROOT
mkdir -p "$WORK_ROOT"
LOCK=$WORK_ROOT/.hs-compat-nightly.lock
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
LOCK_MAX_MIN=${HS_COMPAT_LOCK_MAX_MIN:-720}
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
    echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) another nightly run (pid $pid) holds $LOCK; not starting"
    exit 0
  else
    echo "removing a stale lock (pid ${pid:-unknown} is not running $SELF)"
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) another nightly run took $LOCK; not starting"; exit 0; }
fi
echo "$$" > "$LOCK/pid"
D=$(mktemp -d "$WORK_ROOT/hs-compat-nightly.XXXXXX") || { rm -rf "$LOCK"; exit 2; }
trap 'rm -rf "$D" "$LOCK"' EXIT
echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) nightly ref=$REF"
if [ -n "${HS_COMPAT_PRE:-}" ]; then
  bash -c "$HS_COMPAT_PRE" || echo "warning: HS_COMPAT_PRE failed; testing the last fetched $REF"
fi
{ git init -q "$D/repo" && git -C "$D/repo" fetch -q --depth 1 "$HS_COMPAT_REPO" "$REF" \
  && git -C "$D/repo" -c advice.detachedHead=false checkout -q FETCH_HEAD; } || { echo "fetch of $REF failed"; exit 2; }
echo "package commit $(git -C "$D/repo" rev-parse --short=10 HEAD)"
# shellcheck disable=SC2086 # HS_COMPAT_ARGS is a space-separated argument list by design
"$D/repo/scripts/compat-matrix.sh" --plugin "$D/repo" --results-dest "$HS_COMPAT_RESULTS" ${HS_COMPAT_ARGS:-}
