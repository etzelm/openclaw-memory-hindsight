#!/usr/bin/env bash
# Live proof for the owner-turn checks that agent exec cannot drive: auto-retain at agent_end
# (P1-3), the pre-compaction tools-arm flush through hindsight_retain, Active Memory resolving
# recallToolNames without toolsAllow, and /learn.
#
# Run from an operator terminal on a host with OpenClaw, Node 24 and a reachable Hindsight API.
# It builds and packs this checkout (or a fresh clone of --ref), installs the tarball into a
# throwaway gateway (isolated OPENCLAW_HOME, loopback, Bonjour off), runs owner turns through
# chat.send on a direct session, prints a summary, then deletes the proof bank and the throwaway
# state.
#
#   scripts/live-proof.sh --ref develop --token-file ~/.openclaw/secrets/hindsight-api-token
#
#   scripts/live-proof.sh --token-file ~/.openclaw/secrets/hindsight-api-token
#
# Options / environment:
#   --token-file PATH   Hindsight API token file (required; never printed)
#   --ref REF           build a fresh clone of REF (branch, tag or commit) from SOURCE_REPO
#                       instead of this checkout
#   SOURCE_REPO         clone source for --ref, default this checkout's origin remote
#   --keep              keep the state dir, gateway log and bank for inspection
#   --setup-only        stop after install, doctor and memory.status (no agent turns)
#   HINDSIGHT_URL       default http://localhost:8888
#   PROOF_BANK          default oc-proof-$(date +%F); must start with oc-proof-
#   MODEL_BASE_URL      OpenAI-compatible endpoint, default http://127.0.0.1:1236/v1 (local oMLX)
#   MODEL_ID            default DeepSeek-V4.1-Flash-1017-oQ3e-mtp
#   PORT                default 18900
#   TURN_TIMEOUT_MS     default 2400000 (the local model can take 15+ minutes per turn)
set -euo pipefail

TOKEN_FILE=""
REF=""
KEEP=0
SETUP_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --setup-only) SETUP_ONLY=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$TOKEN_FILE" && -r "$TOKEN_FILE" ]] || { echo "--token-file is required and must be readable" >&2; exit 2; }
TOKEN_FILE="$(cd "$(dirname "$TOKEN_FILE")" && pwd)/$(basename "$TOKEN_FILE")"

HINDSIGHT_URL="${HINDSIGHT_URL:-http://localhost:8888}"
PROOF_BANK="${PROOF_BANK:-oc-proof-$(date +%F)}"
[[ "$PROOF_BANK" == oc-proof-* ]] || { echo "PROOF_BANK must start with oc-proof-" >&2; exit 2; }
MODEL_BASE_URL="${MODEL_BASE_URL:-http://127.0.0.1:1236/v1}"
MODEL_ID="${MODEL_ID:-DeepSeek-V4.1-Flash-1017-oQ3e-mtp}"
PORT="${PORT:-18900}"
TURN_TIMEOUT_MS="${TURN_TIMEOUT_MS:-2400000}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/work"
WORK="$(mktemp -d "$HOME/work/hs-native-proof.XXXXXX")"
chmod 700 "$WORK"
export OPENCLAW_HOME="$WORK/home" OPENCLAW_DISABLE_BONJOUR=1
unset OPENCLAW_PROFILE OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH
CONF="$OPENCLAW_HOME/.openclaw/openclaw.json"
LOG="$WORK/gateway.log"
GW_PID=""

auth_header() { printf 'Authorization: Bearer %s' "$(cat "$TOKEN_FILE")"; }
hs() { curl -fsS -m 30 -H "$(auth_header)" -H 'Content-Type: application/json' "$@"; }
oc() { openclaw "$@" 2> >(grep -v '^\[plugins\]' >&2); }
call() { oc gateway call "$1" --json --timeout "${3:-60000}" --params "$2"; }
uuid() { node -e 'console.log(crypto.randomUUID())'; }

cleanup() {
  local status=$?
  if [[ -n "$GW_PID" ]]; then
    kill "$GW_PID" 2>/dev/null || true
    # The gateway keeps writing state while it shuts down; remove the dir only after it exits.
    for _ in $(seq 1 30); do kill -0 "$GW_PID" 2>/dev/null || break; sleep 1; done
  fi
  if [[ "$KEEP" == 0 ]]; then
    curl -s -m 30 -o /dev/null -X DELETE -H "$(auth_header)" "$HINDSIGHT_URL/v1/default/banks/$PROOF_BANK" || true
    rm -rf "$WORK" 2>/dev/null || { sleep 3; rm -rf "$WORK"; }
    echo "cleanup: deleted bank $PROOF_BANK and $WORK"
  else
    echo "kept: $WORK (bank $PROOF_BANK); delete both when done"
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -n "$REF" ]]; then
  SRC="${SOURCE_REPO:-$(git -C "$REPO" remote get-url origin)}"
  git clone -q "$SRC" "$WORK/src"
  COMMIT="$(git -C "$WORK/src" rev-parse -q --verify "origin/$REF^{commit}" || git -C "$WORK/src" rev-parse -q --verify "$REF^{commit}")" \
    || { echo "--ref $REF not found in the clone source" >&2; exit 2; }
  git -C "$WORK/src" checkout -q --detach "$COMMIT"
  REPO="$WORK/src"
  echo "== source: --ref $REF at $COMMIT"
fi

echo "== openclaw $(openclaw --version 2>/dev/null | tail -1)"
echo "== build + pack"
(cd "$REPO" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null && npm pack --pack-destination "$WORK" >/dev/null 2>&1)
TGZ="$(ls "$WORK"/*.tgz)"

mkdir -p "$OPENCLAW_HOME/.openclaw" "$OPENCLAW_HOME/workspace"
GW_TOKEN="$(openssl rand -hex 24)"
node - "$CONF" <<EOF
const fs = require("fs");
fs.writeFileSync(process.argv[2], JSON.stringify({
  gateway: { mode: "local", port: ${PORT}, bind: "loopback", auth: { mode: "token", token: "${GW_TOKEN}" } },
  discovery: { mdns: { mode: "off" } },
  models: { providers: { proof: { baseUrl: "${MODEL_BASE_URL}", api: "openai-completions", apiKey: "local-no-auth",
    models: [{ id: "${MODEL_ID}", name: "proof model", contextWindow: 65536, maxTokens: 4096 }] } } },
  agents: { defaults: { model: { primary: "proof/${MODEL_ID}" }, workspace: "${OPENCLAW_HOME}/workspace",
    compaction: { memoryFlush: { enabled: true, forceFlushTranscriptBytes: "2kb" } } } },
  secrets: { providers: { hindsight: { source: "file", path: "${TOKEN_FILE}", mode: "singleValue" } } },
  plugins: { entries: {
    bonjour: { enabled: false },
    "memory-core": { enabled: true, config: { dreaming: { enabled: true } } },
    "active-memory": { enabled: true, config: { enabled: true, agents: ["main"], allowedChatTypes: ["direct"],
      queryMode: "recent", timeoutMs: 120000, logging: true, persistTranscripts: false } },
  } },
}, null, 2), { mode: 0o600 });
EOF

echo "== install from tarball"
oc plugins install "npm-pack:$TGZ" --force --accept-capabilities
node - "$CONF" "$HINDSIGHT_URL" "$PROOF_BANK" <<'EOF'
const fs = require("fs");
const [file, url, bank] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(file, "utf8"));
c.plugins.slots = { memory: "hindsight-native" };
c.plugins.entries["hindsight-native"] = { ...(c.plugins.entries["hindsight-native"] ?? {}), enabled: true,
  hooks: { allowConversationAccess: true },
  config: { hindsightApiUrl: url, hindsightApiToken: { source: "file", provider: "hindsight", id: "value" },
    agentBankMap: { main: bank }, retainMission: "Extract durable facts from this proof conversation.",
    excludeProviders: ["heartbeat"] } };
fs.writeFileSync(file, JSON.stringify(c, null, 2));
EOF
oc config validate
echo "== plugins doctor"; oc plugins doctor || true

echo "== gateway on 127.0.0.1:$PORT"
openclaw gateway run --port "$PORT" --bind loopback --verbose >"$LOG" 2>&1 &
GW_PID=$!
for _ in $(seq 1 60); do grep -q "http server listening" "$LOG" 2>/dev/null && break; sleep 2; done
echo "== memory.status"; call memory.status '{"agentId":"main"}'
[[ "$SETUP_ONLY" == 1 ]] && { echo "setup-only: stopping before agent turns"; exit 0; }

SK="agent:main:dashboard:$(uuid)"
turn() {
  local msg="$1" res run
  res="$(call chat.send "$(node -e 'console.log(JSON.stringify({sessionKey:process.argv[1],message:process.argv[2],idempotencyKey:crypto.randomUUID()}))' "$SK" "$msg")")"
  run="$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.runId??j.result?.runId??"")' "$res")"
  echo "chat.send runId=$run"
  [[ -n "$run" ]] && call agent.wait "{\"runId\":\"$run\",\"timeoutMs\":$TURN_TIMEOUT_MS}" "$((TURN_TIMEOUT_MS + 60000))" | head -c 400; echo
}
echo "== turn 1 (owner direct session $SK)"
turn "Durable fact for later: the hs-native proof marker is TEAL-OTTER-4471, chosen on 2026-11-03 for the Studio proof gateway. Acknowledge in one short sentence."
sleep 20
echo "== turn 2 (pushes the transcript past forceFlushTranscriptBytes)"
turn "Second durable fact: the proof gateway's backup marker is FLUSH-HERON-2208 and it belongs to the same proof. Explain in about 150 words why pre-compaction memory flushes matter, then stop."
sleep 20
echo "== turn 3 (recall; Active Memory should use hindsight_recall/hindsight_reflect)"
turn "What was the hs-native proof marker? Use your memory tools if you need to."
sleep 20
echo "== turn 4 (/learn routes to hindsight_retain on hosts with the learn seam)"
turn "/learn Always state the proof marker before answering questions about the proof gateway."
sleep 30

echo "== documents in $PROOF_BANK"
hs "$HINDSIGHT_URL/v1/default/banks/$PROOF_BANK/documents" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
for (const d of j.items) console.log(`${d.id}  scope=${d.document_metadata?.retention_scope ?? "-"}  units=${d.memory_unit_count}`);
const ids=j.items.map(d=>d.id);
console.log("auto-retain (agent_end) documents:", ids.filter(i=>i.startsWith("openclaw:")).length);
console.log("flush documents (openclaw-flush:):", ids.filter(i=>i.startsWith("openclaw-flush:")).length);})'
echo "== memory.search v2"
call memory.search '{"version":2,"agentId":"main","query":"hs-native proof marker","maxResults":5}' | head -c 1500; echo
echo "== gateway log (plugin + memory lines)"
grep -E "memory-hindsight|hindsight-native|memory flush|memory-flush|active-memory|audience|learn" "$LOG" \
  | grep -v "startup trace\|loading " | sed "s#$HOME#~#g" | tail -60
echo "== verdict hints"
echo "P1-3 auto-retain at agent_end: PASS if 'auto-retain (agent_end) documents' >= 1 and no 'auto-retain failed' above"
echo "tools-arm flush: PASS if 'flush documents' >= 1 (scope=pre_compaction_flush) and a 'memory flush' line names hindsight_retain"
echo "Active Memory: PASS if an active-memory line shows hindsight_recall/hindsight_reflect and no toolsAllow is configured"
