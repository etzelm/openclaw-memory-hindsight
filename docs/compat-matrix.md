# Live proof and compatibility matrix

Two scripts catch SDK breakage against real OpenClaw hosts before a release reaches users:

- `scripts/live-proof.sh` runs one host, one runtime and one plugin build through a throwaway
  Gateway and real turns, and prints a PASS/FAIL/SKIP table.
- `scripts/compat-matrix.sh` runs the harness for the floor host, the latest release and
  upstream `main`, on the embedded and `claude-cli` runtimes, and writes `MATRIX.md`.

Both are bash with `python3`, `node`, `npm`, `curl`, `git`, `nc` and `openssl`. Building `main`
also needs `pnpm`. The `claude-cli` runtime needs the `claude` CLI, logged in.

## Requirements

- A Hindsight API on loopback (`HINDSIGHT_URL`, default `http://localhost:8888`) and its token
  in a file: `--token-file` (token only) or `--token-env-file` (dotenv, key
  `HINDSIGHT_API_TENANT_API_KEY` or `--token-key`).
- For the embedded runtime, an Anthropic API key for the default model
  `anthropic/claude-haiku-5-5`: `--anthropic-env-file` (key `ANTHROPIC_API_KEY` or
  `--anthropic-key`) or `ANTHROPIC_API_KEY` in the environment. Use `--model` for another
  embedded model; non-Anthropic models read their own provider environment.
- A normal terminal. OpenClaw refuses `openclaw agent` and `gateway call chat.send` from an agent
  exec shell by design. The harness detects that shell, runs setup and the provider self-test,
  and marks the turn checks SKIP. It does not work around the guard.

Secrets are copied into mode-600 files in the scratch dir, never printed and never passed on a
command line. Results are redacted: tokens and keys, IPs, home paths (also in the dashed form
Claude Code uses for project dir names, and `/Users/<name>` of any account), the machine's host
name and the account name as whole words, and long session ids. Host and account names of four
characters or less, and names that are words the logs use themselves (such as `openclaw`,
`claude` or `memory`), are kept; their home paths are still redacted. Another account's dashed
home is replaced up to the end of the dashed path, because its name cannot be told from the
path after it. In the Gateway, OpenClaw and host logs, streamed `claude-cli` delta chunks
(`input_json_delta`, `text_delta`, `thinking_delta`) are replaced by `<delta>`, because they split
paths across chunks; the assembled tool input is logged in full and redacted. Turn outputs and
transcripts keep their text, so the code word checks read it as written. A delta logged inside
an escaped JSON string, or with its payload key before `"type"`, is not matched.

## One run

```sh
scripts/live-proof.sh --openclaw 2026.10.10 --runtime embedded \
  --token-env-file ~/hindsight.env --anthropic-env-file ~/anthropic.env
scripts/live-proof.sh --openclaw main --runtime claude-cli --token-file ~/hindsight-token
scripts/live-proof.sh --openclaw ~/src/openclaw --plugin clawhub:@etzelm/openclaw-memory-hindsight@0.1.2 \
  --runtime embedded --phase published --token-file ~/hindsight-token --anthropic-env-file ~/anthropic.env
```

`--openclaw` takes an npm version or dist-tag (installed into a scratch prefix), a git ref
(shallow-fetched from `OPENCLAW_REPO` and built with `pnpm install --frozen-lockfile && pnpm
build`), or a path to a built checkout or npm prefix. Without it the harness uses `openclaw` on
`PATH`. `--plugin` takes a checkout dir or `git+URL#REF` (built and packed with npm), a `.tgz`,
or any `openclaw plugins install` spec. Without it the harness packs this checkout.

Isolation: own `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` under
`$WORK_ROOT` (default `~/work`), a file log inside the scratch dir (`logging.file`, so nothing
lands in the shared `/tmp/openclaw` log), loopback bind on `PORT` (default 19438), channels and
Bonjour off, a random gateway token, and a throwaway bank `oc-proof-<phase>-<hex>`. The
harness checks the isolated port and log path are in effect before it installs anything. At
the end it deletes every `oc-proof-<phase>-<hex>*` bank and the scratch dir, and checks both
(X1, X2). `--keep` leaves them for inspection, so X1 and X2 FAIL and the exit code is 1; the
mode-600 copies of the token and key stay in the scratch dir until you delete it.

The test agent has no file, shell, session, node or delegate tools (`tools.deny`: `group:fs`,
`group:runtime`, `group:sessions`, `group:nodes`, `openclaw`), so Hindsight is the only path
from the owner session to the conversation session. With those tools an agent asked to
"remember this" writes the fact to the shared workspace daily note (`memory/YYYY-MM-DD.md`), and
any later session of the agent can read it back, which B2 and B4 would report as a leak through
the plugin. B2 fails, and says why, when the owner turn was offered one of those tools, the
conversation turn used one, or a workspace file contains the code word.

`claude-cli` turns run the operator's real `claude` CLI with its login and user settings. The
CLI keeps a per-project dir (transcripts and its own memory, so the code word) under
`~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`), named after the scratch workspace.
Claude Code 2.1.296 builds the name from the turn's cwd: each UTF-16 unit that is not
`[A-Za-z0-9]` becomes `-`, and a name over 200 characters keeps its first 200 plus `-` and a
base-36 32-bit string hash of the cwd. The harness applies the same rule to the logical and the
real workspace path. With `CLAUDE_CONFIG_DIR` set, `CLAUDE_CODE_PROJECT_DIR_NAME` would replace
the name, so the harness unsets it.

Cleanup removes exactly this run's dir, after checking it is a real dir directly under
`projects/` with `-hs-live-proof-` in its name, or a shortened name (the hash comes from this
run's random scratch path). A candidate that already existed before the Gateway started is
never removed; X2 fails and names it (`preexisting`). X2 also fails while the dir exists.

At the start of the run the harness lists `projects/` (in memory only) and writes a marker file into
the results dir. At the end, X2 fails when this run's code word or workspace path is in any file
under a `projects/*hs-live-proof*` dir, under an entry that appeared during the run, or anywhere
under `projects/` modified after the marker. That catches a transcript the CLI wrote under some
other name, in a new dir or in one that already existed. New entries the run did not predict are
counted in X2 and never deleted: another Claude Code session on the machine may own them, so on
their own they do not fail X2. A concurrent Claude Code session that reads this run's output (and so
its code word or workspace path) does fail X2. `CLAUDE_CONFIG_DIR` is not pointed at the scratch dir
because the CLI then no longer finds the login. A user-level Claude Code hook or MCP server would
run inside the proof turns, outside this isolation.

### Checks

| id    | check                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| H1    | host resolved and `openclaw --version` runs                                                                                                  |
| H2    | plugin installed, `hindsight-native` in `plugins.slots.memory`                                                                               |
| H3    | gateway up, `memory.status` comes from the plugin                                                                                            |
| S1    | probe: operator read through the host memory provider reaches the owner bank                                                                 |
| S2    | probe: an audience object the host did not mint is rejected with no Hindsight I/O                                                            |
| R1    | owner turns exit 0 on the requested runtime (provider from the turn report)                                                                  |
| A1-A4 | owner turns: hooks get `owner-private`, turn 1 retains, turn 2 recalls and the reply has the fact, the provider searches only the owner bank |
| B1-B4 | `chat.send` turn: hooks get `conversation`, the owner fact stays out, I/O and retain stay in `<bank>::conv::*`                               |
| M1-M2 | an audience presented for another session is rejected with no I/O                                                                            |
| C1-C2 | an `agent_end` context kept past the run: the guard throws "released" and the provider refuses it                                            |
| X1-X2 | banks deleted, scratch state and the `claude-cli` project dir removed                                                                        |

The probe is a throwaway plugin written into the scratch dir. It records each hook's audience,
traces Hindsight requests by bank and calls `getActiveMemoryProvider` from
`openclaw/plugin-sdk/memory-host-search` the way bundled consumers do.

Output: `results.json` (schema 1: host, plugin, runtime, model, checks, summary, verdict),
`table.txt`, redacted gateway and turn logs, and the documents found in the proof banks.
`--results-dest` copies the results dir there (`RESULTS_PUT` sets the copy command, default
`cp -R`). Exit codes: 0 no check failed, 1 a check failed, 2 usage or preflight, 3 setup.

## Matrix

```sh
scripts/compat-matrix.sh --token-env-file ~/hindsight.env --anthropic-env-file ~/anthropic.env
scripts/compat-matrix.sh --hosts "floor 2026.11.1" --runtimes embedded --token-file ~/hindsight-token \
  --anthropic-env-file ~/anthropic.env
```

Hosts: `floor` is `openclaw.install.minHostVersion` from `package.json` (2026.10.10), `latest` and
`beta` are the npm dist-tags resolved to a version (right after a stable release `beta` can be the
same version as `latest`, or older), `main` is upstream `main` resolved to one commit with `git
ls-remote` so both runtimes test the same build. Any other word goes to `--openclaw` as is (an npm
version such as `2026.11.5-beta.1`). `--hosts` and `--runtimes` take spaces or commas (`--hosts
floor,latest,beta,main`), and the rows follow that order. Each host is prepared once and removed
after its cells. The run dir holds `MATRIX.md`, `matrix.json`, one dir per cell and the cell logs,
and is copied to `--results-dest` even when the run stops early. `--render DIR` rebuilds the matrix
from existing cells; `--self-test` checks the cell classifier against fixtures.

Exit codes: 0 every cell as expected, 1 an unexpected cell, 2 usage, 3 only partial cells
left. A cell is partial when its turn checks are SKIP because it ran in an agent exec shell
or with `--setup-only`; a matrix run with `--setup-only` exits 0 on partial cells. A cell is
unexpected when a check fails (other than the known `claude-cli` case below), when it has no
`results.json` or not all 20 checks, when the harness exit code is not 0 or 1 or disagrees
with `results.json`, or when a check is SKIP for any other reason.

### Expected cells

Released OpenClaw does not give plugin hooks a memory audience on CLI-backed turns
(openclaw#194453). Upstream `main` has the fix since 2026-11-09. Until a release ships it, every
`claude-cli` cell on a release fails the audience checks:

| OpenClaw           | embedded | claude-cli                            |
| ------------------ | -------- | ------------------------------------- |
| 2026.10.10 (floor) | PASS     | FAIL, expected                        |
| latest release     | PASS     | FAIL, expected                        |
| main               | PASS     | PASS with `CLI_AUDIENCE_FIXED_IN` set |

A `claude-cli` cell counts as expected when A1 and B1 show no audience on the hooks and every
failing check is an A, B, M or C check, or G2 (its recall and retain counters stay at 0 when the
hooks get no audience). Any other failure is unexpected and makes the matrix exit 1. When a
release ships the fix, set `CLI_AUDIENCE_FIXED_IN=<version>`: from that version on, `claude-cli`
cells must pass, and a `claude-cli` PASS before it is reported as unexpected so the expectation
gets updated. While it is set, a host built from source (`main`) must pass too, whatever version
it reports: main carries the version of its last release close-out, which can be older than the
first release with the fix. `CLI_AUDIENCE_FIXED_IN=main` is for the time between: the fix is on
upstream main (closed 2026-11-09) but in no release yet (2026.11.3 and 2026.11.5-beta.2 still
give CLI hooks no audience), so main must pass and every release still fails as expected.

## Nightly schedule (macOS launchd)

`scripts/compat-nightly.sh` fetches the package at `HS_COMPAT_REF` from `HS_COMPAT_REPO` into a
fresh scratch dir, runs the matrix from that checkout and copies the run dir to
`HS_COMPAT_RESULTS`. `HS_COMPAT_REF=latest-release` picks the highest `vX.Y.Z` tag in
`HS_COMPAT_REPO`, so the run tests the latest release; a branch name tests that branch.
`scripts/launchd/hs-compat-nightly.plist.example` runs it once a day in the 03 hour as a
per-user LaunchAgent: launchd starts it every 60 s and a gate exits at once unless the hour
matches and the stamp file does not hold today's date (a LaunchAgent in a `user/<uid>`
Background domain does not fire `StartCalendarInterval`). It is not installed by anything in this repo. The job runs whatever
`HS_COMPAT_REF` points to with the operator's Hindsight token, Anthropic key and `claude` login,
so pin it to a protected branch or tag that only maintainers can push. With
`HS_COMPAT_REF=latest-release` that means whoever can push a `vX.Y.Z` tag to `HS_COMPAT_REPO`:
keep the tag ruleset from RELEASING.md (one-time setup, step 4) on, or point `HS_COMPAT_REPO` at
a mirror only you can write. A tag listing that fails exits 2 with "could not list tags"; a repo
with no release tag exits 2 with "no vX.Y.Z tag found". To install it for the
account that owns the Hindsight token and the `claude` login:

```sh
dest="$HOME/Library/Application Support/hs-compat"
mkdir -p "$dest" && cp scripts/compat-nightly.sh "$dest/" && chmod 700 "$dest/compat-nightly.sh"
sed -e "s#__HOME__#$HOME#g" \
    -e "s#__NODE_BIN__#$(dirname "$(command -v node)")#g" \
    -e "s#__NODE__#$(realpath "$(command -v node)")#g" \
    -e "s#__STATUS_FILE__#<dir the metrics exporter reads>/hs-compat-nightly.prom#" \
    -e "s#__CLI_AUDIENCE_FIXED_IN__#<first release with the fix, or empty>#" \
    -e "s#__REPO_URL__#<git URL or path of this package>#" \
    -e "s#__RESULTS_DEST__#<results dir>#" \
    -e "s#__HINDSIGHT_ENV_FILE__#<dotenv with HINDSIGHT_API_TENANT_API_KEY>#" \
    -e "s#__ANTHROPIC_ENV_FILE__#<dotenv with ANTHROPIC_API_KEY>#" \
    scripts/launchd/hs-compat-nightly.plist.example > ~/Library/LaunchAgents/com.etzelm.hs-compat-nightly.plist
plutil -lint ~/Library/LaunchAgents/com.etzelm.hs-compat-nightly.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.etzelm.hs-compat-nightly.plist
launchctl kickstart -k "gui/$(id -u)/com.etzelm.hs-compat-nightly"   # optional first run now
```

`gui/<uid>` exists only while the account is logged in at the console. For an account that
never logs in there (a build user reached over ssh), use `user/$(id -u)` in the `bootstrap`,
`kickstart` and `bootout` commands; the plist's `LimitLoadToSessionType` allows both. Use one
domain per account: the `user` domain does not load the agent again after a reboot, so add the
`bootstrap` command as an `@reboot` line to that account's crontab, and leave that line out for
an account with a console login (its login loads the plist into `gui/<uid>`):

```sh
@reboot sleep 150; launchctl bootstrap user/$(id -u) ~/Library/LaunchAgents/com.etzelm.hs-compat-nightly.plist >> ~/Library/Logs/hs-compat-nightly.log 2>&1
```

The `sleep 150` waits for launchd to finish setting up the user domain after boot; 150 s is a guess
that worked on one Mac, not a documented value. A bootstrap that runs too early fails, and the line
logs it, so check the log after a reboot and raise the delay if needed. If both happen,
`compat-nightly.sh` runs one copy at a time per `WORK_ROOT`; a lock is stale when its pid is not
running the same script path or it is older than `HS_COMPAT_LOCK_MAX_MIN` minutes (720). A launchd
job does not run in an agent exec shell, so its turn checks run; the `claude-cli` cells also need
the CLI login to be readable from that domain, so check the first log after installing and after a
reboot.

`HS_COMPAT_REPO` can be a local clone that only fetches from the forge; then set
`HS_COMPAT_REF=refs/remotes/origin/develop`, and keep something fetching that clone (for
example `HS_COMPAT_PRE`).

The plist starts bash through `node` (`__NODE__`, a real path, not a symlink). On macOS a
LaunchAgent that cron bootstraps after a reboot runs `/bin/bash` without access to an external
volume, so with `WORK_ROOT` on an external disk every `mkdir` there fails with "Operation not
permitted". Give that node binary Full Disk Access (System Settings > Privacy & Security > Full
Disk Access); its children inherit it. A node upgrade changes the real path and drops the grant:
the run then exits 4 with "cannot write WORK_ROOT", and the status file below records it. Keep
`StandardOutPath` on the internal disk, because launchd opens it before the job starts and fails
with EX_CONFIG (78) on a path it cannot open.

`node`, `npm`, `pnpm`, `git` and `claude` must be on the plist `PATH`. Add `HS_COMPAT_PRE` (a
command run first) or `GIT_SSH_COMMAND` to `EnvironmentVariables` if the repo needs them, and
`RESULTS_PUT` if the results go somewhere `cp -R` cannot reach. The log is
`~/Library/Logs/hs-compat-nightly.log`.

`HS_COMPAT_STATUS_FILE` (optional) names a Prometheus textfile, rewritten by every start except
one that finds another run holding the lock (that start leaves it alone). A start that cannot
write `WORK_ROOT` writes it with exit code 4 before it reaches the lock:

| metric                                             | meaning                                                   |
| -------------------------------------------------- | --------------------------------------------------------- |
| `hs_compat_nightly_last_attempt_timestamp_seconds` | last start that found no other run holding the lock       |
| `hs_compat_nightly_last_run_timestamp_seconds`     | last matrix that ran to the end (exit 0, 1 or 3)          |
| `hs_compat_nightly_last_success_timestamp_seconds` | last matrix with every cell as expected (exit 0)          |
| `hs_compat_nightly_last_exit_code`                 | exit code of the last start (4: `WORK_ROOT` not writable) |

Alert on `time() - hs_compat_nightly_last_run_timestamp_seconds > 30 * 3600` (a missed
nightly, including a job that never starts) and on `hs_compat_nightly_last_exit_code >= 2`
(it could not run). An unexpected cell (exit 1) is in the latest `MATRIX.md` in the results
dir. To remove it:

```sh
launchctl bootout "gui/$(id -u)/com.etzelm.hs-compat-nightly"   # or user/$(id -u)
rm ~/Library/LaunchAgents/com.etzelm.hs-compat-nightly.plist
rm -r "$HOME/Library/Application Support/hs-compat"
```

The embedded cells spend a few Anthropic API calls per run (two owner turns and one
conversation turn per host, plus Hindsight's own retain extraction). The `claude-cli` cells use
the CLI's login.
