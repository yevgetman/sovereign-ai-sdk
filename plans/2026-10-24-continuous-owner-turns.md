# Continuous owner turns — implementation plan

Owner approval: Telegram, 2026-10-24: “load the dev skill set. approved”.
Authoritative spec: `specs/2026-10-24-continuous-owner-turns-design.md` at
`98958792`; design PR273. Approval applies to implementation, verification and
ready-to-merge PRs. It does not authorize merging delivery PRs, releases,
installed upgrades, service restarts or external spending.

## Scope and repositories

- SDK/SOV integration: `master`; feature `feat/continuous-owner-turns` in
  `/private/tmp/sov-owner-turn-design-20261025`, based on `e1a08bb5` plus the spec.
- Telekit integration: `main`; feature `feat/sov-continuous-owner-turns` in an
  isolated worktree. Its native contractor is seated on `telekit`.
- Preserve dirty primary checkouts. No machine-level configuration changes.
- Resolve and load all six `set:dev` skills. Dependency checks for the review
  compounds must remain ready. Use deliver-development for the review/acceptance
  procedure: at most five completed passes per final PR; two consecutive passes
  with no critical/high and all findings resolved permit early exit.

## Implementation tasks

### Task 1 — SDK/SOV execution and durable policy

1. Reproduce continuous-loop expectations in focused fixtures; establish the
   eight-call/cancelled cause from current runtime code, not field inference.
2. Make model-call limits nullable and optional without losing explicit numeric
   caller/parent policy. Remove toolset-derived lifetime budgets. Update schemas,
   agent defaults, child scheduling and visible configuration.
3. Update logical-turn records/capabilities to versioned continuous support;
   preserve legacy finite policies, stop and lease/receipt guarantees. Add an
   explicit, recorded safe migration path.
4. Use one owner-turn lifecycle for native CLI and direct server surfaces. Keep
   context recovery, wait/steering, hooks, usage, cancellation and final delivery
   coherent across internal boundaries. Correct internal-cleanup cancellation.
5. Report effective tools, not tools unavailable to the admitted turn. Preserve
   route and permission ceilings. Do not add an automatic larger toolset.
6. Preserve bounded failure episodes; ensure changing results/pagination/waits do
   not falsely trip a length-based guard. No infinite retry or synthetic prompt
   loop. Keep active context and detector memory bounded.
7. Cover >1,000 productive calls, multiple compactions/output continuations,
   explicit parent/child limits, invalid/null values, stop, unknown tool effects,
   safe crash recovery and legacy rows. Map all spec acceptance to evidence.

### Task 2 — Telekit continuous execution adapter

1. Read the approved shared spec and current adapter contracts; write a local
   implementation plan referencing that approval, without a second approval gate.
2. Negotiate SOV continuous execution support from the machine capability. Remove
   implicit absolute deadlines only on capable SOV owner turns. Keep user/host
   limits, legacy compatibility, child exit, stop and other harness behavior.
3. Make timeout origin visible. Do not reinterpret unknown-provenance explicit
   stored limits as defaults. Do not use a global environment override.
4. Test fake-clock work past the old deadline, capability/legacy handling,
   explicit limits, cancellation, crash and final delivery. Update the public
   manual and configured quality gates. Open one delivery PR against `main`.
5. Adapter capability fields must match SDK contract; coordinate before final
   verification and report dependency/merge order.

## Integration and review

1. Each implementation task runs in its own native Kernel contractor with its
   native record, explicit worktree/branch and durable handoff. All work required
   for this Telegram turn must finish before a final ready claim.
2. Keep atomic commits on feature branches; run configured gates before commits,
   record test results, push after commits. No unrelated source or policy edits.
3. Open SDK and Telekit delivery PRs. Verify exact head/base repository/branch.
4. Lock one review ledger per final PR. Use the resolved code-review skill and
   independent lenses; sequential passes. Record every finding. Repairs get
   their own branches/issues/PRs and merge only into the reviewed feature branch
   once verified. Never merge final delivery PRs.
5. Check combined final heads, CI, packed consumers, context/loop/cancellation
   regressions and each acceptance criterion. A controlled read-only live replay
   must use the real chat path if an authorized test interface exists. If that
   interface is unavailable, record the missing evidence and do not claim full
   end-to-end acceptance.
6. Qualifying review passes must resolve even low findings. Stop after two in a
   row or five total. Never reset the pass count on resume or at a context reset.
7. Keep the native task checkpoints and living handoff current. Final report:
   verdict, both PRs/SHAs, acceptance/gates, limits and merge order. No deployment.

## Evidence and checkpoints

- Local coordinator state: `.kernel/development/continuous-owner-turns.json`.
- Review ledgers: `.kernel/autonomous-code-review-and-fix/pr-<number>.json`.
- Independent reports: `.kernel/code-review/` (not committed).
- Required current-state updates: CLI/API/config docs, migration notes, testing
  log and state snapshot when code lands on the feature branch.
- Task status remains in progress until code, repair reviews and acceptance are
  complete. Missing evidence is not a ready verdict.
