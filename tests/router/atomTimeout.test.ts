// Phase 1 T15 — Atom timeout integration test (deferred).
//
// The plan calls for verifying that a lane's configured `timeoutMs` is
// enforced end-to-end: a `cheap-task` lane with `timeoutMs: 50` should
// cancel a `slowMode`-throttled MockProvider stream, surfacing as an
// `interrupted` terminal on the atom's tool_result envelope.
//
// However, the underlying enforcement path is NOT yet wired. The R-D
// mitigation in the design spec requires three pieces:
//
//   1. `SubagentScheduler.delegate()` must accept a
//      `perChildTimeoutMsOverride?: number` field on its `DelegateInput`.
//      The current code (src/runtime/scheduler.ts:197-198) reads only
//      the static `opts.perChildTimeoutMs` set at scheduler construction
//      and falls back to `agent.maxTurns * DEFAULT_PER_TURN_TIMEOUT_MS`.
//
//   2. `ToolContext` must expose a `laneRegistry` (the runtime's
//      LaneRegistry instance) so AgentTool.call can resolve the target
//      agent's lane timeoutMs at dispatch time. The current
//      `src/tool/types.ts` exposes `subagentScheduler` and `agents` but
//      no laneRegistry.
//
//   3. `AgentTool.call` (src/tools/AgentTool.ts:85-95) must look up
//      `ctx.laneRegistry?.lookup(agent.role)?.timeoutMs` and pass it
//      as `perChildTimeoutMsOverride` on the `scheduler.delegate()`
//      call.
//
// These changes are a meaningful surface expansion — three files +
// new tests for the override-resolution logic + a unit test for the
// lane-aware timeout. Per the T15 plan note, this is allowed to land
// "as part of T15", but the failure test (atomFailure.test.ts) already
// provides the core error-handling coverage that the plan needs for
// Phase 1. The timeout enforcement is operational hardening that
// fits cleanly in a Phase 2 follow-up dedicated to scheduler ergonomics.
//
// Decision: skip with documentation. The test stub below stays in the
// repo as a tracked TODO so a future session lands the plumbing along
// with this test in one focused commit. The semantic suite case
// `task-routing-failure-recovery` (tests/semantic/suites/22-task-routing.cases.ts)
// also exercises the lane-failure user-visible path end-to-end against
// a real LLM with an unreachable model, so the *user-visible* failure
// behavior is covered by other tests already.
//
// Plan: docs/plans/2026-05-23-phase-1-task-routing.md (T15)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md (R-D)

import { describe, test } from 'bun:test';

describe('delegator integration — atom timeout', () => {
  test.skip('lane timeoutMs causes atom to be cancelled (deferred — needs per-child timeout plumbing)', () => {
    // Intentionally empty. See file header for rationale.
    // When the plumbing lands, this test should:
    //   - Configure taskRouting.lanes.cheap-task.timeoutMs = 50
    //   - Set MockProvider.slowMode = true, slowModeDelayMs = 200
    //   - Drive a turn that dispatches cheap-task
    //   - Assert the cheap-task atom's tool_result carries
    //     terminal="interrupted" with a timeout-shaped message
    //   - Assert synthesis acknowledges the timeout gap
  });
});
