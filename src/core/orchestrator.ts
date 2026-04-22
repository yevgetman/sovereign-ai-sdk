// Tool orchestration — partitions tool_use blocks into concurrency-safe
// batches, dispatches through the permission layer, applies contextModifier
// between serial steps. Phase 0: stub. Phase 2: functional.
//
// Source of pattern: Claude Code src/services/tools/toolOrchestration.ts.

// Intentionally empty on Phase 0. runTools() lands in Phase 2 alongside the
// first tool. Keeping this file in place reserves the import path so the
// turn loop doesn't need to move imports around when the function is added.

export const ORCHESTRATOR_PHASE = 0 as const;
