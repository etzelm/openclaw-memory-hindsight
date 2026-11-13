# Releasing

GitLab `develop` is the source of truth and runs `.gitlab-ci.yml`. The public GitHub repo
(github.com/etzelm/openclaw-memory-hindsight) holds one squashed commit per release on `main`
and a `vX.Y.Z` tag. Pushing the tag runs `.github/workflows/release.yml`, which:

1. Checks that the tag equals `v` + the `package.json` version and that the tagged commit is
   on `main`.
2. Runs the same gates as CI (`npm ci`, typecheck, build, test, lint, format check) and packs
   the tarball once. The pack guard rejects tests, helpers and local state and requires the
   README, LICENSE, CHANGELOG, plugin manifest and `dist/index.js`. A tokenless `clawhub package
   publish --dry-run` then validates the tarball, so a ClawHub rejection stops the release
   before the irreversible npm publish.
3. Publishes that tarball to npm with trusted publishing (OIDC) and provenance. No npm token
   is stored anywhere.
4. Publishes the same tarball to ClawHub with a ClawHub API token.
5. Creates a GitHub release with the tarball and its `.sha256`, notes taken from
   `CHANGELOG.md`.

Every job after the build checks the tarball sha256 before it uses it. A rerun skips a
registry that already has the same bytes and fails if it has different bytes.

Pull requests and pushes to `main` on GitHub run `.github/workflows/ci.yml` (same gates, read
only, no secrets).

## One-time setup

Do these once, in this order, before the first tag-driven release. Step 5 does not depend on
the others, but do it before the release push that first puts SECURITY.md on `main`.

### 1. GitHub environment `release`

Repo Settings > Environments > New environment > `release`:

- Required reviewers: add yourself. Every publish job then waits for your approval.
- Deployment branches and tags: "Selected branches and tags", add the tag rule `v*.*.*`.
- Environment secrets: add `CLAWHUB_TOKEN` (step 3).

### 2. npm trusted publisher

npmjs.com > `@etzelm/openclaw-memory-hindsight` > Settings > Trusted publishing >
GitHub Actions:

- Organization or user: `etzelm`
- Repository: `openclaw-memory-hindsight`
- Workflow filename: `release.yml`
- Environment name: `release`

Then, on the same page, set "Publishing access" to "Require two-factor authentication and
disallow tokens". Trusted publishing keeps working; leaked tokens cannot publish. Revoke any
old automation tokens under Access Tokens.

### 3. ClawHub token

ClawHub's trusted publishing only covers `workflow_dispatch` runs of its own reusable
workflow. Tag-push publishes still need a token, so this workflow uses one:

1. ClawHub > Settings > API tokens > create a token named `github-release`.
2. Store it as the `CLAWHUB_TOKEN` secret of the `release` environment (not a repo secret).
   With the GitHub CLI: `gh secret set CLAWHUB_TOKEN --env release --repo etzelm/openclaw-memory-hindsight`
   (it prompts for the value).
3. Rotate it by creating a new token, updating the secret, and revoking the old one.

### 4. Protect `main` and release tags

Repo Settings > Rules > Rulesets:

- Branch ruleset for `main`: restrict deletions, block force pushes.
- Tag ruleset for `v*.*.*`: restrict creations, updates and deletions to you (bypass list).

Settings > Actions > General: keep "Workflow permissions" at "Read repository contents".
The workflows ask for more only where they need it.

### 5. Private vulnerability reporting

Repo Settings > Advanced Security ("Code security" on some accounts) > enable "Private
vulnerability reporting". `SECURITY.md` and the issue chooser link to its report form, which
does not exist until this is on. Enable it before you push the release commit that ships
`SECURITY.md`, so the link works from the first moment it is public.

## Before a release

[SUPPORT.md](SUPPORT.md) is the policy; check it before step 1:

- **Cadence**: at most one minor release a week. A patch carries fixes only: no new keys, no
  changed defaults, no removals.
- **Deprecations**: a minor removes only what an earlier minor deprecated at least two minor
  releases and 30 days ago. A newly deprecated key keeps working and logs a warning.
- **Host floor**: raise `openclaw.install.minHostVersion` and the peer range only in a minor
  release that the previous release announced. The new floor must be a stable release that is
  at least 30 days old.
- **Compat matrix**: the floor and latest stable cells pass (`scripts/compat-matrix.sh`, see
  [docs/compat-matrix.md](docs/compat-matrix.md)).
- **Recall release gate**: the maintainer runs the candidate tarball against the previous
  release on the live memory banks (claw-configs `scripts/hindsight-recall-gate.sh`, private
  infrastructure). It must not be worse on hit@5, MRR@10 or the junk rate. A failed gate blocks
  the tag. Record the result in the release MR.
- **Soak**: for a minor release, run the candidate on the maintainer's Gateway for 48 hours
  before tagging. A security patch may skip this.

## Release steps

1. On GitLab, branch from `develop` and bump the version:
   `npm version X.Y.Z --no-git-tag-version`. Add a `## X.Y.Z (YYYY-MM-DD)` section to
   `CHANGELOG.md`, with an upgrade note for a minor release. Update the version in the
   `SECURITY.md` table ("Latest release (X.Y.Z today)"). Open an MR, wait for the pipeline,
   merge to `develop`. The date is the tag day: on the tag build, `src/release-metadata.test.ts`
   fails when it is more than a day off, so after a soak update it before step 2.
2. In a local clone with both remotes (`origin` = GitLab, `github` = GitHub):

   ```bash
   git fetch origin develop
   git fetch github main
   git switch -c release-X.Y.Z github/main
   # Make the tree identical to develop, as one commit on top of public main.
   git restore --source origin/develop --staged --worktree -- .
   # One --trailer per outside contributor in this release's CHANGELOG section.
   # Drop the flag if there are none.
   git commit -S -m "release: X.Y.Z" --trailer "Co-authored-by: Name <email>"
   git diff --stat origin/develop   # must be empty
   git push github release-X.Y.Z:main
   ```

   Release commits carry one `Co-authored-by:` trailer for each outside contributor whose pull
   request was ported since the last release (the CHANGELOG section names them), as
   CONTRIBUTING.md promises. Take the name and email from the contributor's pull request
   commits (often their GitHub noreply address), so GitHub links the trailer to their account.

   Wait for CI on `main` to pass.

3. Tag the same commit and push the tag:

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push github vX.Y.Z
   ```

4. In the Actions tab, approve the `release` environment for the `npm` and `clawhub` jobs.
5. Check the result:

   ```bash
   npm view @etzelm/openclaw-memory-hindsight@X.Y.Z dist.integrity
   npm audit signatures   # in a project that installs the package
   clawhub package inspect @etzelm/openclaw-memory-hindsight --version X.Y.Z
   ```

   The npm package page shows a "Provenance" badge linking to the workflow run.

## When a job fails

- Build or gate failure: nothing was published. Fix on GitLab, then delete the tag on
  GitHub (`git push github :refs/tags/vX.Y.Z`) and release again. Do not reuse a version
  that reached npm.
- npm, ClawHub or release job failure: use "Re-run failed jobs". Finished registries are
  skipped when they hold the same bytes.
- A ClawHub release that is still in security checks may not show up in
  `clawhub package inspect` yet. If a rerun then fails on a duplicate version, wait for the
  first upload to finish and check it with `clawhub package inspect` before rerunning.

## Local checks

Provenance and trusted publishing only work inside GitHub Actions; they need the runner's
OIDC token. Locally, `npm publish --dry-run` shows the file list, and
`clawhub package publish <tgz> --family code-plugin --dry-run` shows the ClawHub payload.
