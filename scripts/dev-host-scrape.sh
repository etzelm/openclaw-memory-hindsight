#!/usr/bin/env bash
# Boots a dev OpenClaw host (a source build that has api.metrics, openclaw#198455) with this plugin
# and plugins.entries.hindsight-native.allowMetrics true, scrapes the Gateway's Prometheus route and
# asserts the hindsight families and the queue depth heartbeat. CI job `dev-host`; runs locally too.
#
#   scripts/dev-host-scrape.sh --host DIR [--port N] [--out DIR]
#   scripts/dev-host-scrape.sh --fetch SHA --work DIR [--port N] [--out DIR]
#   scripts/dev-host-scrape.sh --prebuilt URL --sha256 HEX --work DIR [--port N] [--out DIR]
#
# --host DIR      a built OpenClaw checkout (has openclaw.mjs and dist/).
# --fetch SHA     download github.com/openclaw/openclaw at SHA into --work, pnpm install and build
#                 it. The build needs about 4.7 GB; CI containers have less, so CI uses --prebuilt.
# --prebuilt URL  download a built tree packed by scripts/dev-host-pack.sh (no node_modules),
#                 check its sha256, and pnpm install it. Sends JOB-TOKEN when CI_JOB_TOKEN is set.
# The plugin is this checkout, packed and installed into a scratch dir; run `npm ci && npm run build`
# first. Hindsight points at a closed
# port and the retain queue is seeded with one item, so a replay is deferred without a server.
#
# Asserts on GET /api/diagnostics/prometheus (bearer token, random per run, never printed):
#   HTTP 200; `# TYPE` for retain_queue_depth and retain_queue_replays_total; the heartbeat
#   `retain_queue_depth{bank="main"} 0` (the seeded item is in bank dev-host-replay, so only the
#   heartbeat makes that series); the seeded depth and its deferred replay; and
#   that /plugins/hindsight-native/metrics is not served (one scrape path).
# Exit: 0 pass, 1 an assertion failed, 2 setup error (download, build, gateway did not start).
set -uo pipefail
# The host refuses plugin paths that are world-writable (GitLab's docker builds dir is).
umask 022

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
HOST=""
FETCH=""
WORK=""
PREBUILT=""
SHA256=""
PORT=19461
OUT="$REPO/dev-host-out"
WAIT_S=${DEV_HOST_WAIT_S:-45}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=${2:-}; shift 2 ;;
    --fetch) FETCH=${2:-}; shift 2 ;;
    --work) WORK=${2:-}; shift 2 ;;
    --prebuilt) PREBUILT=${2:-}; shift 2 ;;
    --sha256) SHA256=${2:-}; shift 2 ;;
    --port) PORT=${2:-}; shift 2 ;;
    --out) OUT=${2:-}; shift 2 ;;
    -h | --help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "dev-host: unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "dev-host: $*" >&2; exit 2; }
[ -f "$REPO/dist/index.js" ] || die "build the plugin first (npm ci && npm run build)"
mkdir -p "$OUT" || die "cannot create $OUT"
OUT=$(cd "$OUT" && pwd)

if [ -n "$FETCH" ]; then
  [ -n "$WORK" ] || die "--fetch needs --work"
  mkdir -p "$WORK" && WORK=$(cd "$WORK" && pwd) || die "cannot create $WORK"
  case "$FETCH" in *[!0-9a-f]* | "") die "--fetch needs a full commit sha" ;; esac
  [ ${#FETCH} -eq 40 ] || die "--fetch needs a full 40 character commit sha"
  HOST="$WORK/openclaw-$FETCH"
  if [ ! -f "$HOST/.dev-host-built" ]; then
    rm -rf "$HOST" && mkdir -p "$HOST" || die "cannot create $HOST"
    echo "dev-host: downloading openclaw $FETCH"
    curl -fsSL --retry 3 "https://codeload.github.com/openclaw/openclaw/tar.gz/$FETCH" \
      | tar xz -C "$HOST" --strip-components=1 || die "download of $FETCH failed"
    (
      cd "$HOST" || exit 1
      corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null 2>&1
      corepack enable || exit 1
      export CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
      pnpm install --frozen-lockfile >"$OUT/host-install.log" 2>&1 || { tail -40 "$OUT/host-install.log"; exit 1; }
      pnpm build >"$OUT/host-build.log" 2>&1 || { tail -40 "$OUT/host-build.log"; exit 1; }
    ) || die "install or build of openclaw $FETCH failed (logs in $OUT)"
    touch "$HOST/.dev-host-built"
  fi
fi
if [ -n "$PREBUILT" ]; then
  [ -n "$WORK" ] || die "--prebuilt needs --work"
  case "$SHA256" in *[!0-9a-f]* | "") die "--prebuilt needs --sha256 (64 hex characters)" ;; esac
  [ ${#SHA256} -eq 64 ] || die "--prebuilt needs --sha256 (64 hex characters)"
  mkdir -p "$WORK" && WORK=$(cd "$WORK" && pwd) || die "cannot create $WORK"
  HOST="$WORK/openclaw-prebuilt"
  rm -rf "$HOST" && mkdir -p "$HOST" || die "cannot create $HOST"
  echo "dev-host: downloading the prebuilt host"
  if [ -n "${CI_JOB_TOKEN:-}" ]; then
    curl -fsSL --retry 3 -H "JOB-TOKEN: $CI_JOB_TOKEN" -o "$WORK/host.tgz" "$PREBUILT" || die "download failed"
  else
    curl -fsSL --retry 3 -o "$WORK/host.tgz" "$PREBUILT" || die "download failed"
  fi
  got=$(node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$WORK/host.tgz")
  [ "$got" = "$SHA256" ] || die "prebuilt sha256 mismatch: got $got"
  tar xzf "$WORK/host.tgz" -C "$HOST" || die "cannot unpack the prebuilt host"
  rm -f "$WORK/host.tgz"
  echo "dev-host: prebuilt host $(cat "$HOST/.dev-host-commit" 2>/dev/null || echo unknown)"
  (
    cd "$HOST" || exit 1
    corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null 2>&1
    corepack enable || exit 1
    export CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    pnpm install --frozen-lockfile >"$OUT/host-install.log" 2>&1 || { tail -40 "$OUT/host-install.log"; exit 1; }
  ) || die "pnpm install of the prebuilt host failed (logs in $OUT)"
fi
[ -n "$HOST" ] || die "--host, --fetch or --prebuilt is required"
[ -f "$HOST/openclaw.mjs" ] || die "$HOST has no openclaw.mjs"

STATE=$(mktemp -d "${TMPDIR:-/tmp}/dev-host-state.XXXXXX") || die "mktemp failed"
GW=""
cleanup() {
  [ -n "$GW" ] && kill "$GW" 2>/dev/null && wait "$GW" 2>/dev/null
  rm -rf "$STATE"
}
trap cleanup EXIT

# Stage the plugin the way an install does: the packed files plus production dependencies, in a
# private dir, so the host's path checks see a normal install, not the CI checkout.
PLUGIN="$STATE/plugin"
mkdir -p "$PLUGIN" || die "cannot create $PLUGIN"
(cd "$REPO" && npm pack --ignore-scripts --silent --pack-destination "$STATE" >"$STATE/pack.txt") \
  || die "npm pack failed"
tar xzf "$STATE/$(tail -1 "$STATE/pack.txt")" -C "$PLUGIN" --strip-components=1 || die "unpack failed"
(cd "$PLUGIN" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent) \
  || die "npm install of the packed plugin failed"
chmod -R go-w "$STATE"

TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
mkdir -p "$STATE/hindsight-native"
cat >"$STATE/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "port": $PORT, "bind": "loopback", "auth": { "mode": "token", "token": "$TOKEN" } },
  "plugins": {
    "load": { "paths": ["$PLUGIN"] },
    "slots": { "memory": "hindsight-native" },
    "entries": {
      "diagnostics-prometheus": { "enabled": true },
      "hindsight-native": {
        "enabled": true,
        "allowMetrics": true,
        "config": { "hindsightApiUrl": "http://127.0.0.1:9", "allowInsecureHttp": true }
      }
    }
  }
}
JSON
NOW=$(($(date +%s) * 1000))
# The seeded item goes to another bank, so bank main has a depth series only through the heartbeat.
echo "{\"bankId\":\"dev-host-replay\",\"documentId\":\"dev-host-1\",\"item\":{\"content\":\"dev host\"},\"queuedAt\":$NOW}" \
  >"$STATE/hindsight-native/retain-queue.jsonl"

export OPENCLAW_STATE_DIR="$STATE" OPENCLAW_CONFIG_PATH="$STATE/openclaw.json"
(cd "$HOST" && exec node openclaw.mjs gateway run --port "$PORT" --bind loopback --auth token \
  --token "$TOKEN" >"$STATE/gateway.log" 2>&1) &
GW=$!
up=0
for _ in $(seq 1 120); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz"; then up=1; break; fi
  kill -0 "$GW" 2>/dev/null || break
  sleep 1
done
redact() { sed "s/$TOKEN/<token>/g"; }
if [ "$up" -ne 1 ]; then
  redact <"$STATE/gateway.log" >"$OUT/gateway.log"
  tail -40 "$OUT/gateway.log"
  die "gateway did not start on port $PORT"
fi
# The exporter and the plugin service start after the health route; the depth timer runs every 15 s
# and the seeded replay can take up to the 30 s retain timeout to be deferred.
sleep "$WAIT_S"

scrape() {
  curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT$1"
}
scrape /api/diagnostics/prometheus >"$OUT/scrape.txt"
scrape /plugins/hindsight-native/metrics >"$OUT/route.txt"
redact <"$STATE/gateway.log" >"$OUT/gateway.log"
grep -E '^openclaw_plugin_hindsight_native_|^# (HELP|TYPE) openclaw_plugin_hindsight_native_' \
  "$OUT/scrape.txt" >"$OUT/scrape-hindsight.txt"

fail=0
check() { # check NAME FILE REGEX
  if grep -Eq "$3" "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi
}
P=openclaw_plugin_hindsight_native_
check "scrape HTTP 200" "$OUT/scrape.txt" '^HTTP 200$'
check "TYPE retain_queue_depth gauge" "$OUT/scrape.txt" "^# TYPE ${P}retain_queue_depth gauge$"
check "TYPE retain_queue_replays_total counter" "$OUT/scrape.txt" \
  "^# TYPE ${P}retain_queue_replays_total counter$"
check "heartbeat retain_queue_depth{bank=main} 0" "$OUT/scrape.txt" \
  "^${P}retain_queue_depth\\{bank=\"main\"\\} 0$"
check "seeded queue depth{bank=dev-host-replay}" "$OUT/scrape.txt" \
  "^${P}retain_queue_depth\\{bank=\"dev-host-replay\"\\} 1$"
check "seeded replay deferred" "$OUT/scrape.txt" \
  "^${P}retain_queue_replays_total\\{bank=\"dev-host-replay\",outcome=\"deferred\"\\} [1-9]"
if grep -q '^openclaw_hindsight_' "$OUT/route.txt"; then
  echo "FAIL route not served (both paths active)"
  fail=1
else
  echo "PASS route not served"
fi
if grep -q 'api.metrics register failed' "$OUT/gateway.log"; then
  echo "FAIL plugin fell back to the route (register failed)"
  fail=1
fi
echo "dev-host: $(wc -l <"$OUT/scrape-hindsight.txt" | tr -d ' ') hindsight lines in the scrape:"
cat "$OUT/scrape-hindsight.txt"
exit "$fail"
