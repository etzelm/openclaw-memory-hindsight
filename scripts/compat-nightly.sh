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
# Exit: the compat-matrix.sh exit code, or 2 when the checkout could not be fetched.
set -u
umask 077
: "${HS_COMPAT_REPO:?set HS_COMPAT_REPO}" "${HS_COMPAT_RESULTS:?set HS_COMPAT_RESULTS}"
REF=${HS_COMPAT_REF:-develop}
WORK_ROOT=${WORK_ROOT:-$HOME/work}
export WORK_ROOT
mkdir -p "$WORK_ROOT"
D=$(mktemp -d "$WORK_ROOT/hs-compat-nightly.XXXXXX") || exit 2
trap 'rm -rf "$D"' EXIT
echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) nightly ref=$REF"
if [ -n "${HS_COMPAT_PRE:-}" ]; then
  bash -c "$HS_COMPAT_PRE" || echo "warning: HS_COMPAT_PRE failed; testing the last fetched $REF"
fi
{ git init -q "$D/repo" && git -C "$D/repo" fetch -q --depth 1 "$HS_COMPAT_REPO" "$REF" \
  && git -C "$D/repo" -c advice.detachedHead=false checkout -q FETCH_HEAD; } || { echo "fetch of $REF failed"; exit 2; }
echo "package commit $(git -C "$D/repo" rev-parse --short=10 HEAD)"
# shellcheck disable=SC2086 # HS_COMPAT_ARGS is a space-separated argument list by design
"$D/repo/scripts/compat-matrix.sh" --plugin "$D/repo" --results-dest "$HS_COMPAT_RESULTS" ${HS_COMPAT_ARGS:-}
