# Release and support policy

This plugin has one maintainer. This page says how often releases ship, which versions get
fixes, how much notice a removal gets, and which OpenClaw versions are supported. It applies
from 0.8.0. Security reports go through [SECURITY.md](SECURITY.md); how a release is cut is in
[RELEASING.md](RELEASING.md).

## Release cadence

- **Minor releases (0.x.0)**: at most one a week, when there is something to ship. There is no
  fixed schedule. A minor may change config or behavior and always has an upgrade note in
  [CHANGELOG.md](CHANGELOG.md).
- **Patch releases (0.x.y)**: fixes and security fixes only, as soon as they are ready. No new
  config keys, no changed defaults, no removals.
- **Before a tag**, the release candidate has to:
  - pass CI and the compat matrix (see [docs/compat-matrix.md](docs/compat-matrix.md));
  - pass the maintainer's recall release gate: no worse than the previous release on hit@5,
    MRR@10 and the junk rate of injected memories, measured on the same live banks in one run;
  - for a minor release, run for at least 48 hours on the maintainer's own Gateway.

  A security patch may skip the 48 hours. It still needs CI and the gate.

## Which versions get fixes

| Line                                               | Gets                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Latest minor (for example 0.8.x once 0.8.0 is out) | All fixes, as a new patch release                                                |
| Previous minor                                     | Nothing new. Its upgrade path to the latest minor is kept free of breaks (below) |
| Older                                              | Nothing. Upgrade                                                                 |
| Versions with a known security problem             | Deprecated on npm once the fix ships                                             |

The release workflow publishes only from the public `main` branch, so before 1.0 there are no
backport releases to older lines. To make "upgrade to the latest" always safe:

- A security fix never ships only inside a minor that also needs config changes. If the fix
  lands during such a minor's development, it is also released as a patch of the current latest
  minor first.
- A minor never removes anything that the previous minor did not already warn about (see
  "Deprecations"). So moving from one minor to the next never fails at Gateway start.

From 1.0 the previous minor will also get security fixes for 90 days after its successor
ships. That needs backport releases, which the release workflow does not support yet.

## Deprecations

The config schema rejects unknown keys. A key that simply disappeared would therefore stop the
Gateway from loading the plugin, so nothing is removed without notice:

1. **Deprecate in a minor release.** The CHANGELOG upgrade note names the replacement. The
   Gateway log warns once at start while the old key, tool or behavior is in use. A deprecated
   config key is still accepted. It is either mapped to its replacement or ignored with the
   warning, as `listToolsWithoutAudience` was.
2. **Keep it working** for at least two more minor releases **and** at least 30 days after the
   deprecating release, whichever is later.
3. **Remove it only in a minor release**, with an upgrade note.

Stored formats get the same notice. These are the retain queue file, bank ids, document ids and
retain tags. A change ships with a reader for the old format that stays for at least two minor
releases.

A security problem can shorten the notice when keeping the old behavior is the risk. The
upgrade note then says so and why.

## Minimum OpenClaw version

- **The floor** is `openclaw.install.minHostVersion` in `package.json`, and the same version in
  the `openclaw` peer range (`>=2026.10.10` today). The plugin is supported on every stable
  OpenClaw release from the floor to the latest.
- **Tested** nightly against the floor, the latest stable release, the current beta and `main`
  (the compat matrix). The floor and latest stable must pass. Beta and `main` are best effort.
  A failure there is tracked, and it is fixed before that host version becomes the latest
  stable release when the cause is in the plugin.
- **Raising the floor** happens only in a minor release, never in a patch. The release before
  must announce it in the CHANGELOG. The new floor must be a stable OpenClaw release that has
  been out for at least 30 days. The only exception is a host fix that the plugin needs for
  security or to avoid data loss. Its upgrade note says why.
- A host feature newer than the floor is detected at runtime and degrades cleanly on older
  hosts, rather than raising the floor.

## Toward 1.0

1.0 is not tied to a date. It ships when all of these hold:

- 30 days with no data-loss bug;
- this policy followed for several minor releases;
- the compat matrix green on the floor and the latest stable for two weeks;
- the recall release gate in use for every release.

From 1.0, semver applies to the config surface, the tool names and parameters, and the stored
formats above.
