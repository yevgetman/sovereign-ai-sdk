# Contributing to the Sovereign AI SDK

The SDK is the reusable engine. The coding harness, gateway and learning layer
are its consumers. Keep this boundary explicit in code, issues and documentation.

## Start with an issue

Use a GitHub issue for a defect, capability gap or proposed improvement. Include
the affected package/version, concrete trigger, expected behavior, evidence and
acceptance criteria. Separate reproduced defects from concerns that need testing.
Link existing roadmap entries instead of creating two competing work queues.

Report suspected security defects privately as described in
[SDK security guidance](packages/sdk/SECURITY.md). Never put credentials,
owner transcripts, private databases or security reproductions in public issues.

## Use a branch and pull request

Work on a focused branch from current `origin/master`. An isolated worktree is
preferred when another session has local changes. Do not include those changes.
One logical change gets one coherent commit or commit series and one PR.
Push the branch and open a PR; do not push implementation commits to `master`.
The `.kernel/ship-via-pr` marker makes this the default shipping workflow.

The PR describes the problem, resulting behavior, linked issues, validation and
material limits. Keep it draft while checks, review or required design decisions
remain open. Review permission boundaries, cancellation, cleanup, persistence,
compatibility and downstream callers before merge. A successful test suite does
not establish the absence of bugs.

For code builds, the existing [design approval procedure](docs/05-conventions/autonomous-feature-builds.md)
still applies. PRs do not replace the owner's approval of a design or authorize
release publication. Do not merge or publish merely because a PR was opened.

## Validate the change

Install locked dependencies. Install Go and build the TUI before the full suite:

```sh
bun install --frozen-lockfile
bun run tui:build
bun run lint
bun run typecheck
bun run test
```

For package/public API changes, also run:

```sh
bun run build
bun test packages/protocol/tests packages/sdk/tests
bun run canary
```

The canary installs packed artifacts and runs Node and Bun consumers. It checks
package purity as well as importability. For TUI changes, run `go test ./...` in
`packages/tui`. Provider or agent behavior changes need the applicable semantic
checks under the [semantic test policy](docs/05-conventions/semantic-tests.md).
Use isolated mock providers first. Live paid calls need a defined scope and budget.

Record exact commands, versions, results and missing coverage in
[the testing log](docs/06-testing/testing-log.md). Reproduce failures before
classifying them as environmental. Do not silently skip a failing check.

## Preserve consumer contracts

Use the public package entry for supported SDK examples. Deep imports are internal.
Review [stability](STABILITY.md) and the
[consumer contract](docs/05-conventions/consumer-contract.md) before changing an
export, type shape, persistence behavior or default. Add a migration note for a
breaking change. A surface snapshot freezes names; it does not prove type-shape
or behavioral compatibility. The Agent Casa downstream canary is not yet built;
verify affected consumers by hand until it exists.

## Keep documentation useful

Update docs with behavior changes. SDK docs describe what an embedder must supply.
Harness docs describe how the app supplies it. Do not advertise an app feature
as a bare SDK capability. Add runnable, isolated examples for new public features.
Follow [the documentation manual](docs/How_To_Work_With_Docs.md) and its index.

## Current enforcement limits

At the 2026-10-09 review, PR CI runs lint/boundary/typecheck and packed-package
checks. It does not run the full runtime test suite or Go tests on every PR.
GitHub reports no protected-branch configuration and no effective rules for
`master`. This guide and the marker establish a working process; they do not
create a server-enforced merge gate.

The proposed hardening spec includes full-suite PR CI, a tested runtime pin,
required status checks, dependency checks and downstream contract coverage.
Enable required checks only after the corresponding jobs exist and pass.
One human maintainer cannot approve their own GitHub PR; do not add a review
requirement that prevents all merges without an agreed reviewer arrangement.

GitHub documents the distinction between checks and enforced requirements in
[its protected-branch guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Read next

- [SDK README](packages/sdk/README.md)
- [2026-10-09 production review](docs/07-history/audits/2026-10-09-sdk-production-review.md)
- [Proposed production hardening](specs/2026-10-09-sdk-production-hardening-design.md)
