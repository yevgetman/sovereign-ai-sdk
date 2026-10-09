# Production PR gates

The #15 hardening PR defines full PR checks and runnable consumer evidence.
Opening it does not change the jobs or branch rules on master.

## Checks supplied

CI runs lint/boundary/types, the unskipped TypeScript suite and Go tests on Linux
and macOS, installed SDK/protocol consumers on the Bun/Node compatibility floor
and primary pins, typed public consumer fixtures, and dependency advisories.
The TUI build is a mandatory command rather than the best-effort installer.
The packages now declare Node >=20.19.0, the oldest tested Node pin. The previous >=20 minimum incorrectly included early Node20 releases without AbortSignal.any. This raises the declared minimum; consumers on earlier Node20 must upgrade before using the next package release. Bun >=1.2.0 remains tested.

All PR action references are immutable commit hashes and workflow permissions
are contents-read. Toolchain pins are explicit in the workflow.

`bun run audit:dependencies` fails on high/critical advisories, process/registry
failure or malformed reports. Lower severities are counted rather than hidden.
`scripts/security/dependency-exceptions.json` starts empty. An exception must
name one package and GHSA ID, explain the reason, and carry a valid future
expiry. Expired or malformed exceptions fail even if the registry is clean.
Update dependencies rather than add an exception where a compatible fix exists.

## Actual Agent Casa contract

The public packed canary now tests type shapes and multi-turn rehydration,
authorization refusal and pre-inference cancellation under Node and Bun.
It is an authored fixture, not copied private consumer source.

To run the actual downstream suite locally:

```sh
node scripts/canary/run-agent-casa-canary.mjs /path/to/real-estate-agent-runtime
```

It tests the consumer's committed HEAD in a temporary snapshot against the
current packed SDK. API credentials are excluded from its process environment.
The consumer checkout and lockfile are untouched. Only a result summary is
printed. Supply an optional third argument to save a private failure log locally.
The script requires tar/git/npm and the consumer's supported Node runtime.

The manual Agent Casa workflow requires `AGENT_CASA_READ_TOKEN` with read-only
access to the private repository. Never reuse a write/release credential for
this purpose. Do not add private source or test output to public fixtures or
workflow artifacts. This workflow remains an explicit access requirement until
the secret has been configured and a successful run has been recorded.

## Activate branch rules after merge

```sh
node scripts/enable-pr-gates.mjs
node scripts/enable-pr-gates.mjs --apply
```

The first command only prints the proposed rule. The second requires all named
jobs to pass on the current master commit, then applies and checks GitHub's
response. The rules require PRs and up-to-date passing checks, including for
admins, and disable force pushes/deletion. Human approval count is zero so a
solo owner does not get locked out. Independent code review is still required
by the working process. Merge permission does not authorize a release.
