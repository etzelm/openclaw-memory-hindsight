#!/usr/bin/env bash
# Tests for scripts/compat-nightly.sh against a throwaway git repo whose compat-matrix.sh is a
# stub: latest-release tag choice, the status textfile, and the exit when WORK_ROOT cannot be
# written. No network, no OpenClaw, no Hindsight. Run: bash scripts/compat-nightly.test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
NIGHTLY=$HERE/compat-nightly.sh
T=$(mktemp -d "${TMPDIR:-/tmp}/hs-nightly-test.XXXXXX")
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$3] got [$2]"; fails=$((fails + 1)); fi; }
metric() { sed -n "s/^$1 \\(.*\\)\$/\\1/p" "$2" 2>/dev/null; }

# A package repo with tags v0.9.0, v0.10.0 (highest by version, not by text) and v0.11.0-rc.1
# (not a release). The stub matrix records the package version it ran and exits STUB_EXIT.
R=$T/pkg
git init -q "$R"
git -C "$R" config user.email t@t; git -C "$R" config user.name t
mkdir -p "$R/scripts"
cat > "$R/scripts/compat-matrix.sh" <<'EOF'
#!/usr/bin/env bash
sed -n 's/^  "version": "\(.*\)",$/\1/p' "$2/package.json" > "$STUB_OUT"
exit "${STUB_EXIT:-0}"
EOF
chmod +x "$R/scripts/compat-matrix.sh"
for v in 0.9.0 0.10.0 0.11.0-rc.1; do
  printf '{\n  "version": "%s",\n  "name": "x"\n}\n' "$v" > "$R/package.json"
  git -C "$R" add -A; git -C "$R" commit -q -m "$v"; git -C "$R" tag "v$v"
done
printf '{\n  "version": "0.12.0-dev",\n  "name": "x"\n}\n' > "$R/package.json"
# Only develop has the API contract check; its stub records the URL and exits STUB_DRIFT.
cat > "$R/scripts/api-contract.mjs" <<'EOF'
import { writeFileSync } from "node:fs";
writeFileSync(process.env.STUB_DRIFT_OUT, process.argv.slice(2).join(" "));
process.exit(Number(process.env.STUB_DRIFT ?? 0));
EOF
git -C "$R" add -A
git -C "$R" commit -q -am dev
git -C "$R" branch -q -M develop

run() { # REF STUB_EXIT WORK_ROOT -> exit code
  HS_COMPAT_REPO=$R HS_COMPAT_REF=$1 HS_COMPAT_RESULTS=$T/results HS_COMPAT_STATUS_FILE=$T/state/nightly.prom \
    STUB_EXIT=$2 STUB_OUT=$T/ran WORK_ROOT=$3 bash "$NIGHTLY" > "$T/log" 2>&1
}

mkdir -p "$T/work"
run latest-release 0 "$T/work"; st=$?
check "latest-release exit" "$st" 0
check "latest-release picks v0.10.0" "$(cat "$T/ran")" "0.10.0"
check "status exit code" "$(metric hs_compat_nightly_last_exit_code "$T/state/nightly.prom")" 0
ok1=$(metric hs_compat_nightly_last_success_timestamp_seconds "$T/state/nightly.prom")
check "success time set" "$([ "${ok1:-0}" -gt 0 ] && echo yes)" yes
check "scratch and lock removed" "$(ls -A "$T/work")" ""

run develop 1 "$T/work"; st=$?
check "develop exit (unexpected cell)" "$st" 1
check "develop tests the branch" "$(cat "$T/ran")" "0.12.0-dev"
check "status exit code 1" "$(metric hs_compat_nightly_last_exit_code "$T/state/nightly.prom")" 1
check "success time kept" "$(metric hs_compat_nightly_last_success_timestamp_seconds "$T/state/nightly.prom")" "$ok1"
run1=$(metric hs_compat_nightly_last_run_timestamp_seconds "$T/state/nightly.prom")
check "run time set on exit 1" "$([ "${run1:-0}" -gt 0 ] && echo yes)" yes

# WORK_ROOT that cannot be written (stands in for a macOS privacy denial): exit 4, not "another run".
mkdir -p "$T/ro"; chmod 500 "$T/ro"
rm -f "$T/ran"
run develop 0 "$T/ro/work"; st=$?
check "unwritable WORK_ROOT exit" "$st" 4
check "unwritable WORK_ROOT message" "$(grep -c 'cannot write' "$T/log")" 1
check "no 'another nightly run' message" "$(grep -c 'another nightly run' "$T/log")" 0
check "matrix not run" "$([ -e "$T/ran" ] && echo ran || echo no)" no
check "status exit code 4" "$(metric hs_compat_nightly_last_exit_code "$T/state/nightly.prom")" 4
check "run time kept" "$(metric hs_compat_nightly_last_run_timestamp_seconds "$T/state/nightly.prom")" "$run1"
check "no tmp file left" "$(ls "$T/state")" "nightly.prom"

# latest-release when the tags cannot be listed (repo missing or unreachable): exit 2 and say so,
# not "no vX.Y.Z tag found". A reachable repo with no release tag still says that.
rm -f "$T/ran"
HS_COMPAT_REPO=$T/no-such-repo HS_COMPAT_REF=latest-release HS_COMPAT_RESULTS=$T/results \
  STUB_EXIT=0 STUB_OUT=$T/ran WORK_ROOT=$T/work bash "$NIGHTLY" > "$T/log" 2>&1; st=$?
check "unlistable repo exit" "$st" 2
check "unlistable repo message" "$(grep -c 'could not list tags' "$T/log")" 1
check "unlistable repo is not 'no tag found'" "$(grep -c 'no vX.Y.Z tag found' "$T/log")" 0
git init -q "$T/notags"
HS_COMPAT_REPO=$T/notags HS_COMPAT_REF=latest-release HS_COMPAT_RESULTS=$T/results \
  STUB_EXIT=0 STUB_OUT=$T/ran WORK_ROOT=$T/work bash "$NIGHTLY" > "$T/log" 2>&1; st=$?
check "no-tag repo exit" "$st" 2
check "no-tag repo message" "$(grep -c 'no vX.Y.Z tag found' "$T/log")" 1
check "matrix not run without a tag" "$([ -e "$T/ran" ] && echo ran || echo no)" no

# Optional API contract check after the matrix (HS_COMPAT_API_URL).
drift_run() { # REF STUB_EXIT STUB_DRIFT -> exit code
  rm -f "$T/drift-arg"
  HS_COMPAT_REPO=$R HS_COMPAT_REF=$1 HS_COMPAT_RESULTS=$T/results HS_COMPAT_STATUS_FILE=$T/state/nightly.prom \
    HS_COMPAT_API_URL=http://hindsight.test:8888/ STUB_EXIT=$2 STUB_DRIFT=$3 STUB_DRIFT_OUT=$T/drift-arg \
    STUB_OUT=$T/ran WORK_ROOT=$T/work bash "$NIGHTLY" > "$T/log" 2>&1
}
drift_run develop 0 0; st=$?
check "contract clean exit" "$st" 0
check "contract checks the openapi URL" "$(cat "$T/drift-arg")" "check http://hindsight.test:8888/openapi.json"
drift_run develop 0 1; st=$?
check "contract drift exit" "$st" 5
check "status exit code 5" "$(metric hs_compat_nightly_last_exit_code "$T/state/nightly.prom")" 5
run5=$(metric hs_compat_nightly_last_run_timestamp_seconds "$T/state/nightly.prom")
check "run time set on exit 5" "$([ "${run5:-0}" -gt 0 ] && echo yes)" yes
drift_run develop 1 1; st=$?
check "matrix failure wins over drift" "$st" 1
drift_run develop 0 2; st=$?
check "unreachable API only warns" "$st" 0
check "unreachable API warning" "$(grep -c 'contract check could not run' "$T/log")" 1
drift_run latest-release 0 1; st=$?
check "ref without the script still passes" "$st" 0
check "ref without the script says so" "$(grep -c 'API contract check skipped' "$T/log")" 1
check "no contract check without the script" "$([ -e "$T/drift-arg" ] && echo ran || echo no)" no

echo "compat-nightly tests: $([ "$fails" = 0 ] && echo PASS || echo "FAIL ($fails)")"
[ "$fails" = 0 ]
