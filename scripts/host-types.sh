#!/usr/bin/env bash
# Type-checks (and optionally unit-tests) the plugin against OpenClaw hosts other than the one in
# devDependencies, the hosts of the compat matrix: the floor of the peer range, the latest
# release and upstream main. Each host runs in a scratch copy of this checkout whose node_modules
# is this checkout's with only `openclaw` swapped, so every other tool and type stays the same.
#
#   scripts/host-types.sh [--host SPEC]... [--tests] [--keep]
#   scripts/host-types.sh --self-test
#
# SPEC: `floor` (the >= version in peerDependencies), `latest` (npm dist-tag), any npm version or
# dist-tag, or a path to an OpenClaw package dir (a built checkout of main, or an npm prefix's
# node_modules/openclaw). Default: --host floor --host latest. npm hosts are installed into the
# scratch dir with --ignore-scripts. `main` types break often, so check it advisory, by path.
#
# Exit: 0 when every host passed, 1 when one failed, 2 on a usage or install error.
# Needs: bash, node, npm (for npm hosts), and `npm ci` done in this checkout.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
HOSTS=()
TESTS=0
KEEP=0
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) [ -n "${2:-}" ] || { echo "host-types: --host needs a value" >&2; exit 2; }; HOSTS+=("$2"); shift 2 ;;
    --tests) TESTS=1; shift ;;
    --keep) KEEP=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "host-types: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$REPO/node_modules/typescript" ]; then
  echo "host-types: run npm ci in $REPO first" >&2
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/hs-host-types.XXXXXX")
cleanup() { [ "$KEEP" = 1 ] && echo "host-types: kept $WORK" >&2 || rm -rf "$WORK"; }
trap cleanup EXIT

# link_farm SRC DEST [SKIP...]: DEST gets a symlink to every entry of SRC except the SKIP names.
# One node process instead of a fork per entry (OpenClaw's dist has thousands of files).
link_farm() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [src, dest, ...skip] = process.argv.slice(1);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (!skip.includes(name)) fs.symlinkSync(path.join(src, name), path.join(dest, name));
    }
  ' "$@"
}

floor_version() {
  node -e 'const r=require(process.argv[1]).peerDependencies?.openclaw ?? "";const m=/>=\s*([0-9][^\s]*)/.exec(r);if(!m){process.exit(1)}console.log(m[1])' "$REPO/package.json"
}

# resolve_host SPEC DIR -> prints the OpenClaw package dir for SPEC (installing it under DIR).
resolve_host() {
  local spec=$1 dir=$2 version
  if [ -d "$spec" ]; then
    if [ "$(node -p 'require(process.argv[1]).name' "$spec/package.json" 2>/dev/null)" != openclaw ]; then
      echo "host-types: $spec is not an openclaw package dir" >&2
      return 2
    fi
    (cd "$spec" && pwd)
    return 0
  fi
  version=$spec
  if [ "$spec" = floor ]; then
    version=$(floor_version) || { echo "host-types: no >= floor in peerDependencies" >&2; return 2; }
  fi
  mkdir -p "$dir/prefix"
  if ! npm install --prefix "$dir/prefix" --no-save --no-package-lock --ignore-scripts --no-audit \
    --no-fund --loglevel=error "openclaw@$version" >"$dir/install.log" 2>&1; then
    echo "host-types: npm install openclaw@$version failed (log: $dir/install.log)" >&2
    tail -5 "$dir/install.log" >&2
    return 2
  fi
  echo "$dir/prefix/node_modules/openclaw"
}

# prepare DIR HOST_PKG: a copy of the checkout (no node_modules, dist, coverage or .git) whose
# node_modules links every package of this checkout except openclaw, which links HOST_PKG.
prepare() {
  local dir=$1 host=$2
  mkdir -p "$dir/tree"
  tar -C "$REPO" --exclude=./node_modules --exclude=./dist --exclude=./coverage --exclude=./.git \
    -cf - . | tar -C "$dir/tree" -xf -
  link_farm "$REPO/node_modules" "$dir/tree/node_modules" openclaw
  ln -s "$host" "$dir/tree/node_modules/openclaw"
}

# check_host SPEC -> prints one table row, returns 0 (pass), 1 (fail) or 2 (could not run)
check_host() {
  local spec=$1 dir host version tsc_rc=0 test_rc=0 tests="-"
  dir=$(mktemp -d "$WORK/host.XXXXXX")
  host=$(resolve_host "$spec" "$dir") || { printf '| %s | - | could not install | - |\n' "$spec"; return 2; }
  version=$(node -p 'require(process.argv[1]).version' "$host/package.json")
  prepare "$dir" "$host"
  (cd "$dir/tree" && node "$REPO/node_modules/typescript/bin/tsc" -p tsconfig.json --noEmit) \
    >"$dir/tsc.log" 2>&1 || tsc_rc=1
  if [ "$TESTS" = 1 ]; then
    if (cd "$dir/tree" && node "$REPO/node_modules/vitest/vitest.mjs" run) >"$dir/test.log" 2>&1; then
      tests=pass
    else
      tests=FAIL
      test_rc=1
    fi
  fi
  printf '| %s | %s | %s | %s |\n' "$spec" "$version" "$([ $tsc_rc = 0 ] && echo pass || echo FAIL)" "$tests"
  if [ $tsc_rc != 0 ]; then
    sed 's/^/    /' "$dir/tsc.log" | head -20 >&2
  fi
  if [ $test_rc != 0 ]; then
    grep -E "FAIL|Error" "$dir/test.log" | head -20 | sed 's/^/    /' >&2
  fi
  [ $tsc_rc = 0 ] && [ $test_rc = 0 ]
}

run_table() {
  local rc=0 spec st
  echo "| host | version | typecheck | tests |"
  echo "| --- | --- | --- | --- |"
  for spec in "$@"; do
    check_host "$spec"
    st=$?
    if [ $st -gt $rc ]; then
      rc=$st
    fi
  done
  return $rc
}

if [ "$SELF_TEST" = 1 ]; then
  # Offline: the installed dev host must pass, and a copy of it with a broken SDK subpath
  # (plugin-sdk/routing exports nothing) must fail typecheck and be reported.
  real="$REPO/node_modules/openclaw"
  fake="$WORK/broken-openclaw"
  link_farm "$real" "$fake" dist
  link_farm "$real/dist" "$fake/dist" plugin-sdk
  link_farm "$real/dist/plugin-sdk" "$fake/dist/plugin-sdk" routing.d.ts
  echo "export {};" >"$fake/dist/plugin-sdk/routing.d.ts"
  fails=0
  out=$(run_table "$real" 2>/dev/null); st=$?
  if [ $st = 0 ] && grep -q '| pass | - |' <<<"$out"; then echo "ok   dev host passes"; else echo "FAIL dev host: $st $out"; fails=$((fails + 1)); fi
  out=$(run_table "$fake" 2>"$WORK/err"); st=$?
  if [ $st = 1 ] && grep -q '| FAIL | - |' <<<"$out"; then echo "ok   broken host fails"; else echo "FAIL broken host: $st $out"; fails=$((fails + 1)); fi
  if grep -q "routing" "$WORK/err"; then echo "ok   failure names the missing export"; else echo "FAIL no tsc output"; fails=$((fails + 1)); fi
  mkdir -p "$WORK/not-a-host"
  out=$(run_table "$WORK/not-a-host" 2>/dev/null); st=$?
  if [ $st = 2 ] && grep -q 'could not install' <<<"$out"; then echo "ok   bad host path is exit 2"; else echo "FAIL bad path: $st $out"; fails=$((fails + 1)); fi
  echo "host-types self-test: $([ $fails = 0 ] && echo PASS || echo "FAIL ($fails)")"
  [ $fails = 0 ]
  exit $?
fi

[ ${#HOSTS[@]} -gt 0 ] || HOSTS=(floor latest)
run_table "${HOSTS[@]}"
