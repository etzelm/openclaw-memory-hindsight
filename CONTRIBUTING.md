# Contributing

Thanks for helping. Bug reports, feature requests and pull requests are all welcome.

## Where development happens

- The source of truth is the `develop` branch of a private GitLab repository. Day-to-day work,
  review and CI happen there.
- This GitHub repository is a release mirror. `main` gets one squashed commit per release, tagged
  `vX.Y.Z`, matching the version on npm and ClawHub.
- Issues on GitHub are the public place to report bugs and ask for features.
- Security problems: do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Pull requests from outside

Open your pull request against `main` on GitHub. It is not merged there. If it is accepted:

1. The maintainer ports the change into GitLab `develop` and reviews it like any other change.
   Small edits during the port are possible; the pull request gets a comment explaining them.
2. You stay credited. The CHANGELOG entry names you and the pull request, and the release
   commit on GitHub carries a `Co-authored-by:` trailer for you. GitHub links the trailer to your
   account when it uses an email from your pull request commits.
3. The pull request is closed with a link to the release that contains it.

For anything larger than a small fix, please open an issue first so we can agree on the approach.

## Before you open a pull request

Use Node 24 or later. Run the same gates as CI:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run lint
npm run format:check
```

`npm run format` fixes formatting. Add or update tests in `src/*.test.ts` for any behavior change.

Keep changes small and focused. TypeScript ESM only, no new runtime dependencies without
discussion, and no secrets, tokens or private hostnames in code, tests or logs.

Commit subjects use `type(scope): summary`, for example `fix(recall): skip empty banks`.
Types: feat, fix, docs, refactor, test, chore.

## Compatibility

The plugin supports OpenClaw `>=2026.10.10`. If your change needs a newer host API, detect it at
runtime and degrade on older hosts, or say clearly in the pull request that the floor has to move.
See "Supported OpenClaw versions" in the [README](README.md#supported-openclaw-versions).
