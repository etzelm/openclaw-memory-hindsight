#!/usr/bin/env bash
# Compatibility matrix: runs scripts/live-proof.sh for each OpenClaw host and runtime and writes
# MATRIX.md and matrix.json.
#
#   scripts/compat-matrix.sh --token-env-file ~/hindsight.env \
#     --anthropic-env-file ~/anthropic.env
#
# Hosts (default "floor latest main"):
#   floor    the package's openclaw.install.minHostVersion (2026.10.10 today), from npm
#   latest   the npm dist-tag latest, resolved to a version
#   beta     the npm dist-tag beta, resolved to a version
#   main     upstream main, resolved to a commit with git ls-remote so both runtimes test the
#            same commit, built from source
#   any other word is passed to live-proof.sh --openclaw as is
# Runtimes (default "embedded claude-cli").
#
# Expected cells: claude-cli cells FAIL on every host until the host passes the memory audience
# to CLI turn hooks (openclaw#194453). Such a cell counts as expected when A1 and B1 show no
# audience on the hooks and every failing check is an audience check (A*, B*, M*, C*). Set
# CLI_AUDIENCE_FIXED_IN=<version> once a release ships the fix: from that version on, claude-cli
# cells must pass. CLI_AUDIENCE_FIXED_IN=main while the fix is only on upstream main: main (any
# host built from source) must pass, every release still fails as expected. Every other FAIL is
# unexpected.
#
# Options:
#   --hosts "LIST"            hosts to test, separated by spaces or commas
#   --runtimes "LIST"         runtimes to test, separated by spaces or commas
#   --slots "LIST"            owner (default) and/or sidecar: each runtime runs once per slot
#                             role; a sidecar cell runs live-proof.sh --slot sidecar and shows
#                             as its own column "<runtime> sidecar"
#   --plugin SPEC             passed to live-proof.sh (default: this checkout)
#   --results-dest DEST       copy the run dir here with $RESULTS_PUT (default cp -R), then
#                             delete the local copy
#   --render DIR              only rebuild MATRIX.md and matrix.json from DIR/cells/*/results.json
#   --self-test               check the cell classifier against fixtures and exit
#   Other options (--token-file, --token-env-file, --token-key, --anthropic-env-file,
#   --anthropic-key, --setup-only, --keep) are passed to every live-proof.sh run.
# Environment: WORK_ROOT (default ~/work), OPENCLAW_REPO, CLI_AUDIENCE_FIXED_IN, plus everything
#   live-proof.sh reads.
# Partial cells (turn checks SKIP in an agent exec shell or with --setup-only) are shown as
# such. Exit: 0 every cell as expected, 1 an unexpected cell (failure, missing or incomplete
# results, harness crash), 2 bad usage, 3 only partial cells left and the matrix itself was
# not run with --setup-only.
set -u
umask 077

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
HARNESS=$SCRIPT_DIR/live-proof.sh
HOSTS="floor latest main"; RUNTIMES="embedded claude-cli"; SLOTS="owner"; PLUGIN=""; RESULTS_DEST=""
RENDER=""; SELF_TEST=0; PASS_ARGS=()
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
need() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "$1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hosts) need "$@"; HOSTS=$(printf '%s' "$2" | tr ',' ' '); shift 2 ;;
    --runtimes) need "$@"; RUNTIMES=$(printf '%s' "$2" | tr ',' ' '); shift 2 ;;
    --slots) need "$@"; SLOTS=$(printf '%s' "$2" | tr ',' ' '); shift 2 ;;
    --plugin) need "$@"; PLUGIN=$2; shift 2 ;;
    --results-dest) need "$@"; RESULTS_DEST=$2; shift 2 ;;
    --render) need "$@"; RENDER=$2; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    --token-file|--token-env-file|--token-key|--anthropic-env-file|--anthropic-key)
      need "$@"; PASS_ARGS+=("$1" "$2"); shift 2 ;;
    --setup-only|--keep) PASS_ARGS+=("$1"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
# No word splitting or globbing here: only test that each list holds a non-blank character.
case "$HOSTS" in *[![:space:]]*) ;; *) echo "--hosts needs at least one entry" >&2; exit 2 ;; esac
case "$RUNTIMES" in *[![:space:]]*) ;; *) echo "--runtimes needs at least one entry" >&2; exit 2 ;; esac
for sl in $SLOTS; do
  case "$sl" in owner|sidecar) ;; *) echo "--slots takes owner and sidecar, not $sl" >&2; exit 2 ;; esac
done

# render RUN_DIR: classify every cell and write MATRIX.md + matrix.json; exit 1 on an unexpected cell
render() {
  CLI_AUDIENCE_FIXED_IN="${CLI_AUDIENCE_FIXED_IN:-}" python3 - "$1" <<'PY'
import glob, json, os, re, sys

run = sys.argv[1]
fixed_in = os.environ.get("CLI_AUDIENCE_FIXED_IN", "")
AUDIENCE = ("A", "B", "M", "C")
# G2 (metrics change after turns) counts recalls and retains, so it fails whenever the hooks get
# no audience; G1 (the metrics route) does not depend on the audience.
AUDIENCE_IDS = ("G2",)

def vkey(v):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", v or "")
    return tuple(int(x) for x in m.groups()) if m else None

def expect_cli_fail(openclaw):
    if not fixed_in:
        return True
    # A host built from source (main) reports the version of its last release branch point, which
    # can be older than the first release with the fix; it is current upstream, so it has the fix.
    if openclaw.get("kind") in ("git", "checkout"):
        return False
    hv, fv = vkey(openclaw.get("version", "")), vkey(fixed_in)
    return hv is None or fv is None or hv < fv

ALL_IDS = ["H1", "H2", "H3", "S1", "S2", "R1", "A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4",
           "M1", "M2", "C1", "C2", "X1", "X2"]
# The only SKIP reasons the harness writes on purpose.
SKIP_OK = ("agent exec shell:", "--setup-only")
# Sidecar cells skip the host-provider checks on purpose: memory-core owns the provider.
SIDECAR_SKIP = "sidecar: "
lane = lambda r: r["runtime"] + (" sidecar" if r.get("slot") == "sidecar" else "")

def classify(r, driver_exit):
    checks = {c["id"]: c for c in r.get("checks", [])}
    failing = sorted(i for i, c in checks.items() if c["result"] == "FAIL")
    skipped = sorted(i for i, c in checks.items() if c["result"] == "SKIP"
                     and not (r.get("slot") == "sidecar" and c["observed"].startswith(SIDECAR_SKIP)))
    cli_known = r.get("runtime") == "claude-cli" and expect_cli_fail(r.get("openclaw", {}))
    # Only the judged session's part: B1 also lists other sessions' hooks after "; other sessions:",
    # and a heartbeat there with no audience must not make a real B1 failure look expected.
    own = lambda i: checks[i]["observed"].split("; other sessions:")[0]
    no_audience = lambda i: i in checks and checks[i]["result"] == "FAIL" and "None/absent" in own(i)
    ec = r.get("exitCode")
    if driver_exit is not None and driver_exit != ec:
        return "unexpected", f"harness exited {driver_exit}, results.json says {ec}"
    if ec not in (0, 1):
        return "unexpected", f"harness exit {ec}" + (f": {r['abort']}" if r.get("abort") else "")
    missing = [i for i in ALL_IDS if i not in checks]
    if missing:
        return "unexpected", "incomplete, missing " + ",".join(missing)
    if (r.get("verdict") == "FAIL") != bool(failing) or (ec == 1) != bool(failing):
        return "unexpected", f"verdict {r.get('verdict')} and exit {ec} disagree with {len(failing)} failing checks"
    if failing:
        if cli_known and no_audience("A1") and no_audience("B1") and all(i[0] in AUDIENCE or i in AUDIENCE_IDS for i in failing):
            return "expected", f"FAIL {len(failing)} audience checks (expected, openclaw#194453)"
        return "unexpected", "FAIL " + ",".join(failing)
    if skipped:
        if not all(checks[i]["observed"].startswith(SKIP_OK) for i in skipped):
            return "unexpected", "SKIP for an unknown reason: " + ",".join(skipped)
        return "partial", f"setup PASS, {len(skipped)} turn checks SKIP"
    if cli_known:
        return "unexpected", "PASS (claude-cli was expected to FAIL; update CLI_AUDIENCE_FIXED_IN)"
    passed = sum(c["result"] == "PASS" for c in checks.values())
    return "expected", f"PASS {passed}/{len(checks)}" + ("" if passed == len(checks) else f", {len(checks) - passed} provider checks n/a (sidecar)")

meta = {}
if os.path.exists(os.path.join(run, "run.json")):
    meta = json.load(open(os.path.join(run, "run.json")))
exits = {}
if os.path.exists(os.path.join(run, "exits.tsv")):
    for l in open(os.path.join(run, "exits.tsv")):
        if l.strip():
            k, v = l.split()
            exits[k] = int(v)
cells = []
for f in sorted(glob.glob(os.path.join(run, "cells", "*", "results.json"))):
    d = os.path.relpath(os.path.dirname(f), run)
    try:
        r = json.load(open(f))
        status, text = classify(r, exits.get(os.path.basename(d)))
    except Exception as error:
        print(f"unreadable {d}/results.json: {error}", file=sys.stderr)
        continue  # reported below as a missing cell
    cells.append({"dir": d, "status": status, "text": text, "results": r})
# Rows in the requested host order (run.json), then any host only the cells name.
hosts, runtimes = list(dict.fromkeys(meta.get("hostLabels", {}).values())), [r for r in meta.get("runtimes", [])]
for c in cells:
    r = c["results"]
    suffix = "-" + r["runtime"] + ("-sidecar" if r.get("slot") == "sidecar" else "")
    h = r["phase"][: -len(suffix)] if r["phase"].endswith(suffix) else r["phase"]
    c["host"] = meta.get("hostLabels", {}).get(h, h)
    if c["host"] not in hosts: hosts.append(c["host"])
    if lane(r) not in runtimes: runtimes.append(lane(r))
grid = {(c["host"], lane(c["results"])): c for c in cells}
unexpected = [c for c in cells if c["status"] == "unexpected"]
# A requested cell without results.json (the harness died before writing it) is unexpected too.
missing = [(h, rt) for h in hosts for rt in runtimes if (h, rt) not in grid] if meta else []
unexpected += [{"host": h, "runtime": rt} for h, rt in missing]
plugin = cells[0]["results"]["plugin"]["description"] if cells else ""
lines = [f"# Compatibility matrix {meta.get('startedAt', '')}".rstrip(), ""]
lines.append(f"Plugin: {plugin}. Hindsight: loopback, throwaway oc-proof-* banks.")
models = sorted({(c['results']['runtime'], c['results']['model']) for c in cells})
lines.append("Models: " + "; ".join(f"{rt} {m}" for rt, m in models) + ".")
lines.append("")
lines.append("| OpenClaw | " + " | ".join(runtimes) + " |")
lines.append("|---|" + "---|" * len(runtimes))
for h in hosts:
    cs = []
    for rt in runtimes:
        c = grid.get((h, rt))
        cs.append("**UNEXPECTED** no results.json" if c is None else
                  {"expected": "", "partial": "partial: "}.get(c["status"], "**UNEXPECTED** ") + c["text"])
    lines.append(f"| {h} | " + " | ".join(cs) + " |")
lines.append("")
lines.append("Expected: claude-cli cells FAIL on the audience checks until the host gives CLI turn")
lines.append("hooks a memory audience (openclaw#194453)" + (
    "; fixed on upstream main, in no release yet." if fixed_in == "main"
    else f"; fixed from {fixed_in} on, and on main." if fixed_in else "; no release has the fix yet."))
partial = [c for c in cells if c["status"] == "partial"]
lines.append(f"Unexpected cells: {len(unexpected)}. Partial cells (turn checks SKIP): {len(partial)}.")
lines.append("")
lines.append("## Cells")
for c in cells:
    r = c["results"]
    o = r["openclaw"]
    lines += ["", f"### {c['host']}, {lane(r)}: {c['text']}", "",
              f"Host {o['kind']} {o['version']}{(' ' + o['commit'][:10]) if o.get('commit') else ''}; "
              f"plugin {r['plugin']['description']}; model {r['model']}; results `{c['dir']}`.", "",
              "| id | check | result | observed |", "|---|---|---|---|"]
    for ch in r["checks"]:
        obs = ch["observed"].replace("|", "\\|")
        if len(obs) > 160: obs = obs[:157] + "..."
        lines.append(f"| {ch['id']} | {ch['check']} | {ch['result']} | {obs} |")
open(os.path.join(run, "MATRIX.md"), "w").write("\n".join(lines) + "\n")
json.dump({**meta, "unexpected": len(unexpected), "partial": len(partial), "missing": [f"{h} {rt}" for h, rt in missing],
           "cells": [{k: v for k, v in c.items() if k != "results"} | {"verdict": c["results"]["verdict"]} for c in cells]},
          open(os.path.join(run, "matrix.json"), "w"), indent=1)
sys.exit(1 if unexpected else 3 if partial and not meta.get("setupOnly") else 0)
PY
}

self_test() {
  local d st=0
  d=$(mktemp -d "${TMPDIR:-/tmp}/hs-compat-selftest.XXXXXX")
  python3 - "$d" <<'PY'
import json, os, sys
d = sys.argv[1]
IDS = ["H1", "H2", "H3", "S1", "S2", "R1", "A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "M1", "M2", "C1", "C2", "X1", "X2"]
def checks(fail=(), none_audience=False, skip=None, ids=IDS):
    out = []
    for i in ids:
        res = "SKIP" if skip and i[0] in "RABMC" else ("FAIL" if i in fail else "PASS")
        obs = skip if res == "SKIP" else ("3 hooks ['agent_end=None/absent']" if none_audience and i in ("A1", "B1") else "ok")
        out.append({"id": i, "check": i, "want": "", "observed": obs, "result": res})
    return out
AUD = ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "M1", "M2", "C1", "C2"]
EXEC = "agent exec shell: OpenClaw refuses openclaw agent and chat.send here by design"
cases = {
    "floor-embedded": ("embedded", "2026.10.1", checks(), None),
    "floor-claude-cli": ("claude-cli", "2026.10.1", checks(AUD, none_audience=True), None),
    "latest-embedded": ("embedded", "2026.11.1", checks(["A2", "A3"]), None),
    "latest-claude-cli": ("claude-cli", "2026.11.1", checks(AUD + ["H3"], none_audience=True), None),
    "main-embedded": ("embedded", "2026.11.6", checks(skip=EXEC), None),
    "main-claude-cli": ("claude-cli", "2026.11.6", checks(), None),
    "trunc-embedded": ("embedded", "2026.11.1", checks(ids=IDS[:3]), 137),
    "short-embedded": ("embedded", "2026.11.1", checks(ids=IDS[:5] + IDS[-2:]), 0),
    "oddskip-embedded": ("embedded", "2026.11.1", checks(skip="model offline"), None),
    "lie-embedded": ("embedded", "2026.11.1", checks(), None),
    "src-claude-cli": ("claude-cli", "2026.11.2", checks(), None),
    "gmet-claude-cli": ("claude-cli", "2026.10.1", checks(AUD + ["G2"], none_audience=True, ids=IDS + ["G1", "G2"]), None),
    "gone-claude-cli": ("claude-cli", "2026.10.1", checks(AUD + ["G1"], none_audience=True, ids=IDS + ["G1", "G2"]), None),
    "xsess-claude-cli": ("claude-cli", "2026.10.1", checks(AUD, none_audience=True), None),
}
# B1 fails for the chat.send session itself (it had an audience); only another session shows None/absent.
for c in cases["xsess-claude-cli"][2]:
    if c["id"] == "B1":
        c["observed"] = "['agent_end=conversation/stale']; other sessions: 1 hooks ['agent_end=None/absent']"
exits = []
for phase, (rt, v, ch, ec) in cases.items():
    p = os.path.join(d, "cells", phase); os.makedirs(p)
    fail = sum(c["result"] == "FAIL" for c in ch)
    code = ec if ec is not None else (1 if fail else 0)
    kind = "git" if phase.startswith("src-") else "npm"
    json.dump({"phase": phase, "runtime": rt, "slot": "sidecar" if phase.endswith("-sidecar") else "owner", "model": "m", "openclaw": {"kind": kind, "version": f"OpenClaw {v} (abc)", "commit": ""},
               "plugin": {"description": "test"}, "abort": None, "exitCode": code,
               "verdict": "FAIL" if fail or code else "PASS", "checks": ch},
              open(os.path.join(p, "results.json"), "w"))
    # lie-embedded: the harness process exited 1 but its results.json says 0
    exits.append(f"{phase}\t{1 if phase == 'lie-embedded' else code}")
open(os.path.join(d, "exits.tsv"), "w").write("\n".join(exits) + "\n")
PY
  render "$d"; [ $? = 1 ] || { echo "self-test: render should report unexpected cells"; st=1; }
  python3 - "$d/matrix.json" <<'PY' || st=1
import json, sys
cells = {c["dir"].split("/")[-1]: c for c in json.load(open(sys.argv[1]))["cells"]}
want = {
    "floor-embedded": ("expected", "PASS 20/20"),
    "floor-claude-cli": ("expected", "FAIL 12 audience checks (expected"),
    "latest-embedded": ("unexpected", "FAIL A2,A3"),
    "latest-claude-cli": ("unexpected", "FAIL A1,"),
    "main-embedded": ("partial", "setup PASS, 13 turn checks SKIP"),
    "main-claude-cli": ("unexpected", "PASS (claude-cli was expected"),
    "trunc-embedded": ("unexpected", "harness exit 137"),
    "short-embedded": ("unexpected", "incomplete, missing R1,A1"),
    "oddskip-embedded": ("unexpected", "SKIP for an unknown reason"),
    "lie-embedded": ("unexpected", "harness exited 1, results.json says 0"),
    "src-claude-cli": ("unexpected", "PASS (claude-cli was expected"),
    "gmet-claude-cli": ("expected", "FAIL 13 audience checks (expected"),
    "gone-claude-cli": ("unexpected", "FAIL A1,"),
    "xsess-claude-cli": ("unexpected", "FAIL A1,"),
}
bad = [(k, cells.get(k, {}).get("status"), cells.get(k, {}).get("text")) for k, (s, t) in want.items()
       if cells.get(k, {}).get("status") != s or not cells[k]["text"].startswith(t)
       or cells[k]["host"] != k.split("-")[0]]
for b in bad: print("self-test mismatch:", b)
print("self-test:", "FAIL" if bad else f"PASS ({len(want)} cells classified as expected)")
sys.exit(1 if bad else 0)
PY
  CLI_AUDIENCE_FIXED_IN=2026.11.5 render "$d"
  python3 -c '
import json, sys
c = {x["dir"].split("/")[-1]: x for x in json.load(open(sys.argv[1]))["cells"]}
ok = (c["main-claude-cli"]["status"] == "expected" and c["floor-claude-cli"]["status"] == "expected"
      and c["src-claude-cli"]["status"] == "expected" and c["latest-claude-cli"]["status"] == "unexpected")
print("self-test CLI_AUDIENCE_FIXED_IN:", "PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)' "$d/matrix.json" || st=1
  CLI_AUDIENCE_FIXED_IN=main render "$d"
  python3 -c '
import json, sys
c = {x["dir"].split("/")[-1]: x for x in json.load(open(sys.argv[1]))["cells"]}
# main: the source-built cell passes as expected; the npm cells keep their expected failure, and
# an npm claude-cli PASS (main-claude-cli is an npm fixture) is still unexpected.
ok = (c["src-claude-cli"]["status"] == "expected" and c["floor-claude-cli"]["status"] == "expected"
      and c["main-claude-cli"]["status"] == "unexpected")
print("self-test CLI_AUDIENCE_FIXED_IN=main:", "PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)' "$d/matrix.json" || st=1
  grep -q "fixed on upstream main, in no release yet" "$d/MATRIX.md" || { echo "self-test FIXED_IN=main text: FAIL"; st=1; }
  python3 -c 'import json,sys; json.dump({"runtimes": ["embedded", "claude-cli"], "hostLabels": {k: k for k in ("floor", "latest", "main", "ghost")}}, open(sys.argv[1], "w"))' "$d/run.json"
  render "$d"; [ $? = 1 ] || st=1
  python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))
ok = {"ghost embedded", "ghost claude-cli"} <= set(m["missing"]) and not any(x.startswith(("floor ", "latest ", "main ")) for x in m["missing"])
print("self-test missing cells:", "PASS" if ok else "FAIL " + str(m["missing"])); sys.exit(0 if ok else 1)' "$d/matrix.json" || st=1
  # Rows follow the requested host order, then hosts only the cells name.
  python3 -c '
import re, sys
top = open(sys.argv[1]).read().split("## Cells")[0].splitlines()
rows = [l.split(" | ")[0][2:] for l in top if re.match(r"\| [a-z]+ \| ", l)]
want = ["floor", "latest", "main", "ghost", "gmet", "gone", "lie", "oddskip", "short", "src", "trunc", "xsess"]
print("self-test host order:", "PASS" if rows == want else "FAIL " + str(rows)); sys.exit(0 if rows == want else 1)' "$d/MATRIX.md" || st=1
  # Only partial cells left: exit 3, or 0 when the matrix itself ran with --setup-only.
  rm -rf "$d/cells" "$d/exits.tsv"; mkdir -p "$d/cells/main-embedded"
  python3 -c '
import json, sys
ch = [{"id": i, "check": i, "want": "", "observed": "agent exec shell: x" if i[0] in "RABMC" else "ok", "result": "SKIP" if i[0] in "RABMC" else "PASS"}
      for i in ["H1","H2","H3","S1","S2","R1","A1","A2","A3","A4","B1","B2","B3","B4","M1","M2","C1","C2","X1","X2"]]
json.dump({"phase": "main-embedded", "runtime": "embedded", "model": "m", "openclaw": {"kind": "npm", "version": "OpenClaw 2026.11.6", "commit": ""},
           "plugin": {"description": "t"}, "abort": None, "exitCode": 0, "verdict": "PASS", "checks": ch}, open(sys.argv[1], "w"))
json.dump({"runtimes": ["embedded"], "hostLabels": {"main": "main"}}, open(sys.argv[2], "w"))' "$d/cells/main-embedded/results.json" "$d/run.json"
  local p1 p2
  render "$d"; p1=$?
  python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); m["setupOnly"]=True; json.dump(m, open(sys.argv[1], "w"))' "$d/run.json"
  render "$d"; p2=$?
  if [ "$p1" = 3 ] && [ "$p2" = 0 ]; then echo "self-test partial exit: PASS"; else echo "self-test partial exit: FAIL ($p1, $p2)"; st=1; fi
  # Sidecar lane: its own column, provider checks SKIP by design, an extra SKIP still unexpected.
  rm -rf "$d/cells" "$d/exits.tsv"
  python3 -c '
import json, os, sys
d = sys.argv[1]
IDS = ["H1","H2","H3","S1","S2","R1","A1","A2","A3","A4","B1","B2","B3","B4","M1","M2","C1","C2","X1","X2"]
PROVIDER = ("S1", "S2", "A4", "M1", "M2", "C2")
def cell(phase, slot, odd=False):
    ch = []
    for i in IDS:
        side = slot == "sidecar" and (i in PROVIDER or (odd and i == "A1"))
        ch.append({"id": i, "check": i, "want": "", "result": "SKIP" if side else "PASS",
                   "observed": ("sidecar: memory-core owns the host memory provider" if i in PROVIDER else "odd") if side else "ok"})
    os.makedirs(os.path.join(d, "cells", phase))
    json.dump({"phase": phase, "runtime": "embedded", "slot": slot, "model": "m",
               "openclaw": {"kind": "npm", "version": "OpenClaw 2026.11.3", "commit": ""},
               "plugin": {"description": "t"}, "abort": None, "exitCode": 0, "verdict": "PASS", "checks": ch},
              open(os.path.join(d, "cells", phase, "results.json"), "w"))
cell("main-embedded", "owner"); cell("main-embedded-sidecar", "sidecar"); cell("odd-embedded-sidecar", "sidecar", odd=True)
json.dump({"runtimes": ["embedded", "embedded sidecar"], "hostLabels": {"main": "main", "odd": "odd"}}, open(os.path.join(d, "run.json"), "w"))' "$d"
  render "$d"
  python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))
c = {x["dir"].split("/")[-1]: x for x in m["cells"]}
ok = (c["main-embedded-sidecar"]["status"] == "expected"
      and c["main-embedded-sidecar"]["text"] == "PASS 14/20, 6 provider checks n/a (sidecar)"
      and c["main-embedded-sidecar"]["host"] == "main" and c["main-embedded"]["status"] == "expected"
      and c["odd-embedded-sidecar"]["status"] == "unexpected"
      and m["missing"] == ["odd embedded"] and "| OpenClaw | embedded | embedded sidecar |" in open(sys.argv[2]).read())
print("self-test sidecar lane:", "PASS" if ok else "FAIL " + json.dumps({k: (v["status"], v["text"], v["host"]) for k, v in c.items()}) + str(m["missing"]))
sys.exit(0 if ok else 1)' "$d/matrix.json" "$d/MATRIX.md" || st=1
  rm -rf "$d"
  return "$st"
}

if [ "$SELF_TEST" = 1 ]; then self_test; exit $?; fi
if [ -n "$RENDER" ]; then
  [ -d "$RENDER" ] || { echo "--render: no such directory: $RENDER" >&2; exit 2; }
  render "$RENDER"; st=$?
  if [ -f "$RENDER/MATRIX.md" ]; then sed -n '1,20p' "$RENDER/MATRIX.md"; else echo "no MATRIX.md written in $RENDER" >&2; fi
  exit "$st"
fi

WORK_ROOT=${WORK_ROOT:-$HOME/work}
OPENCLAW_REPO=${OPENCLAW_REPO:-https://github.com/openclaw/openclaw.git}
export WORK_ROOT OPENCLAW_REPO
mkdir -p "$WORK_ROOT"
RUN=$WORK_ROOT/hs-compat-$(date +%Y%m%d-%H%M%S)
mkdir -p "$RUN/cells" "$RUN/hosts"; chmod 700 "$RUN"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cleanup() {
  local st=$?
  trap - EXIT INT TERM
  rm -rf "$RUN/hosts"
  [ -f "$RUN/MATRIX.md" ] || echo "note: no MATRIX.md (the run stopped early); cell logs and results are kept"
  if [ -n "$RESULTS_DEST" ]; then
    local ok=1
    if [ -n "${RESULTS_PUT:-}" ]; then $RESULTS_PUT "$RUN" "$RESULTS_DEST/" >/dev/null 2>&1 || ok=0
    else { mkdir -p "$RESULTS_DEST" && cp -R "$RUN" "$RESULTS_DEST/"; } || ok=0; fi
    if [ "$ok" = 1 ]; then rm -rf "$RUN"; echo "matrix: $RESULTS_DEST/$(basename "$RUN")"
    else echo "matrix: $RUN (copy to $RESULTS_DEST failed; copy it and delete it)"; fi
  else
    echo "matrix: $RUN"
  fi
  exit "$st"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

SETUP_ONLY=false
for a in "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"; do [ "$a" = --setup-only ] && SETUP_ONLY=true; done
FLOOR=$(node -e 'const p=require(process.argv[1]); console.log(String(p.openclaw?.install?.minHostVersion ?? "").replace(/^>=\s*/, ""))' "$REPO_DIR/package.json")
LABELS="{}"
declare -a SPECS=() SLUGS=()
for h in $HOSTS; do
  case "$h" in
    floor) [ -n "$FLOOR" ] || { echo "no openclaw.install.minHostVersion in package.json" >&2; exit 2; }
           spec=$FLOOR; label="$FLOOR (floor)" ;;
    latest|beta) spec=$(npm view openclaw "dist-tags.$h" 2>/dev/null); [ -n "$spec" ] || { echo "no npm dist-tag $h for openclaw (or npm view failed)" >&2; exit 2; }
            label="$spec ($h)" ;;
    main) spec=$(git ls-remote "$OPENCLAW_REPO" refs/heads/main 2>/dev/null | cut -f1); [ -n "$spec" ] || { echo "git ls-remote main failed" >&2; exit 2; }
          label="main@${spec:0:10}" ;;
    *) spec=$h; label=$h ;;
  esac
  slug=$(printf '%s' "$h" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '-' | cut -c1-12 | sed 's/-*$//')
  for s0 in "${SLUGS[@]+"${SLUGS[@]}"}"; do
    [ "$s0" = "$slug" ] && { echo "hosts '$h' and an earlier host share the label '$slug'; rename one" >&2; exit 2; }
  done
  SPECS+=("$spec"); SLUGS+=("$slug")
  LABELS=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d[sys.argv[2]]=sys.argv[3]; print(json.dumps(d))' "$LABELS" "$slug" "$label")
done
# Columns: each runtime once per slot role, "<runtime> sidecar" for the sidecar role.
LANES=""
for rt in $RUNTIMES; do for sl in $SLOTS; do
  if [ "$sl" = sidecar ]; then LANES="$LANES|$rt sidecar"; else LANES="$LANES|$rt"; fi
done; done
LANES=${LANES#|}
python3 -c 'import json,sys; json.dump({"startedAt": sys.argv[1], "hosts": sys.argv[2].split(), "runtimes": sys.argv[3].split("|"), "hostLabels": json.loads(sys.argv[4]), "setupOnly": sys.argv[6] == "true"}, open(sys.argv[5], "w"), indent=1)' \
  "$STARTED" "$HOSTS" "$LANES" "$LABELS" "$RUN/run.json" "$SETUP_ONLY"
: > "$RUN/exits.tsv"

for idx in "${!SPECS[@]}"; do
  spec=${SPECS[$idx]}; slug=${SLUGS[$idx]}
  for rt in $RUNTIMES; do for sl in $SLOTS; do
    cell=$slug-$rt; [ "$sl" = sidecar ] && cell=$cell-sidecar
    echo "== cell host=$spec runtime=$rt slot=$sl"
    "$HARNESS" --openclaw "$spec" --runtime "$rt" --slot "$sl" --phase "$cell" ${PLUGIN:+--plugin "$PLUGIN"} \
      --host-dir "$RUN/hosts/$slug" --results-root "$RUN/cells.tmp" "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}" > "$RUN/cell-$cell.log" 2>&1
    ec=$?
    echo "exit=$ec"
    printf '%s\t%s\n' "$cell" "$ec" >> "$RUN/exits.tsv"
    for d in "$RUN"/cells.tmp/*; do [ -d "$d" ] && mv "$d" "$RUN/cells/$cell"; done
    rmdir "$RUN/cells.tmp" 2>/dev/null
    sed -n '/^== phase=/,$p' "$RUN/cell-$cell.log" | grep -v '^results: ' | head -30
    echo "results: $RUN/cells/$cell"
  done; done
  rm -rf "$RUN/hosts/$slug"
done
render "$RUN"; st=$?
sed -n '1,/^## Cells/p' "$RUN/MATRIX.md"
exit "$st"
