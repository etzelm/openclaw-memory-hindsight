#!/usr/bin/env bash
# Packs a built OpenClaw checkout for `dev-host-scrape.sh --prebuilt`: the tree without
# node_modules and .git, plus .dev-host-commit. Run where the build fits (about 4.7 GB), for
# example the Studio, then upload the tgz to this project's generic package registry
# (package openclaw-dev-host, version = the commit) and set OPENCLAW_DEV_* in .gitlab-ci.yml.
#
#   scripts/dev-host-pack.sh HOST_DIR OUT.tgz
set -euo pipefail
[ $# -eq 2 ] || { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
HOST=$(cd "$1" && pwd)
[ -f "$HOST/openclaw.mjs" ] && [ -d "$HOST/dist" ] || { echo "dev-host-pack: $HOST is not a built checkout" >&2; exit 2; }
commit=$(git -C "$HOST" rev-parse HEAD 2>/dev/null || cat "$HOST/.dev-host-commit")
printf '%s\n' "$commit" >"$HOST/.dev-host-commit"
COPYFILE_DISABLE=1 tar czf "$2" -C "$HOST" --exclude=node_modules --exclude=.git --exclude=.crabbox \
  --exclude=cap-out --exclude='*.log' .
node -e 'const c=require("node:crypto");const f=process.argv[1];console.log(c.createHash("sha256").update(require("node:fs").readFileSync(f)).digest("hex"), f)' "$2"
