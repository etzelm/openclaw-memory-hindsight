# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, discussion or pull request.

Use GitHub private vulnerability reporting on the public repository:
<https://github.com/etzelm/openclaw-memory-hindsight/security/advisories/new>
(the **Security** tab, then **Report a vulnerability**).

If that form is not available, open a bug report and write only "requesting a private
security contact" in its text fields. Put no details of the problem anywhere in the issue.

Please include:

- the plugin version, OpenClaw version and agent runtime (embedded or a CLI runtime such as
  `claude-cli`);
- the relevant plugin config with tokens, hostnames and conversation text removed;
- steps to reproduce, and what an attacker gains.

## Supported versions

| Version                      | Supported                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Latest release (0.9.0 today) | Yes                                                                                                            |
| Older releases               | No. Upgrade to the latest release.                                                                             |
| 0.1.1                        | No. Deprecated on npm: sends the bearer token and conversation text over plain http to remote hosts (CWE-319). |
| 0.1.0, 0.0.0-stage           | No. 0.1.0 was never published; 0.0.0-stage is an empty placeholder on npm with no code.                        |

Before 1.0, only the latest release gets fixes. Upgrade to it first and check that the
problem is still there. [SUPPORT.md](SUPPORT.md) has the full policy: release cadence,
deprecation notice and the minimum OpenClaw version.

## What to expect

This plugin has one maintainer, so responses are best effort:

- An acknowledgement, usually within a week.
- An assessment of whether the report is in scope and how severe it is.
- For confirmed issues, a fix in a patch release, a `Security` entry in
  [CHANGELOG.md](CHANGELOG.md), a GitHub security advisory that credits you unless you prefer
  otherwise, and an npm deprecation of affected versions.

Please give the maintainer a reasonable time to ship a fix before you disclose publicly.

## Scope

In scope: the code in this repository and the published `@etzelm/openclaw-memory-hindsight`
package on npm and ClawHub. Examples: credentials or conversation text sent where they should not
go, memory read or written across audiences (owner-private versus conversation banks), or
recalled text that escapes its untrusted-data wrapper.

Out of scope here, please report upstream instead:

- the Hindsight server and API: <https://github.com/vectorize-io/hindsight>;
- OpenClaw itself (Gateway, plugin host, memory audience minting): see the
  [OpenClaw security policy](https://github.com/openclaw/openclaw/security/policy).

Running with `allowInsecureHttp: true` sends the token and conversation text unencrypted by
design. That is documented in the README and is not a vulnerability.
