# Native Kernel skill compatibility — implementation plan

Date: 2026-10-15
Design: [approved specification](../specs/2026-10-15-kernel-skill-compatibility-design.md).
Baseline: `b34f3cdd8800027c40f403b3730b9e70e7f74d14`.
Worktree: `/private/tmp/sov-kernel-skill-compatibility-20261015`.

## Work and acceptance

1. **Descriptor and activation fixtures — complete.** A scoped agent adds synthetic bundled/added/learned/ordinary/compound fixtures, establishes the context failure, permits only the exact kernel label, and proves metadata, catalog paging, invocation and independent compound-member activation. No host-policy change.
2. **Linked session continuity — complete.** A second scoped agent proves real linked-skill activation, persisted database reopen with a mock provider, session/owner separation, turn-only expiry and fresh tool/permission state. Reuse native continuity; no new persistence.
3. **Discovery and local diagnostics — complete.** The root agent adds bounded external-link approval hints, retains containment and exclusions, reduces redundant local alias diagnostics, and proves approval/absence/retarget cases. Keep remote diagnostic redaction.
4. **Review and gates — complete.** Root reviews each scoped result and the combined diff. Run focused tests first, then build, lint, types and full runtime tests; run required packaged Node/Bun consumers, engine-floor checks and isolated real doctor CLI smokes. Record failures and passing evidence in the testing log. Fix failures without expanding scope.
5. **Documentation and handoff — complete.** Update portable compatibility and continuity guides plus a current-state receipt. Verify the matching Runtime producer plan/PR if available, otherwise state the unresolved dependency. Commit coherent feature units after repository gates, push branch, open a PR. Keep it open. No release, merge, upgrade, pins or real settings edits.

## Execution controls

The approved spec is the scope boundary. Each agent edits only its assigned files in the shared isolated worktree. Agents report focused before/after evidence; root owns all commits and full checks. Do not alter the dirty primary checkout. No paid providers or private real-node skill bodies are used in fixtures.

## Cross-references

- [Portable skills](../docs/04-extending/skill-compatibility.md)
- [Continuity](../docs/04-extending/skill-continuity.md)
- [Commit gate](../docs/05-conventions/lint-and-commit.md)

## Review notes

Root reviewed scoped results. An independent read-only implementation check found no concrete blocker in containment, exact approval hints, remote redaction, grouping or continuity coverage. Initial strict type errors in the new descriptor fixtures were corrected before full validation. The implementation uses exact canonical file targets for file projections, which avoids suggesting a broader parent approval.

The matching Runtime compatibility extension remains unidentified after checking current remote main plans/specs and skill-related PRs. The existing on-demand plan and PR249 are related only. This does not prevent isolated SOV source tests, but remains an explicit limit on a complete cross-product claim.

## Delivery receipt

[SDK/SOV PR95](https://github.com/yevgetman/sovereign-ai-sdk/pull/95) contains the feature and remains open. Source commits: `4e689c38` (domain metadata, activation/catalog/continuity fixtures and packed descriptor checks), `83ea9fc7` (local approval diagnostics, grouping and link regressions). The documentation receipt follows those source commits. Full gate:6497pass/19existing skips/0fail; current/floor package consumers and96floor package tests pass. No merge or release was performed. The unresolved producer match remains in the PR and source-state note.
