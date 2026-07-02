// Phase 13.5 — global subagent exclusion set. Tool names that no child
// agent may use, regardless of what its agent definition's `allowedTools`
// declares. Enforced at tool-pool assembly time when the scheduler builds
// a child's tool set.
//
// This is belt-and-suspenders safety on top of the per-agent allowlist:
//   - allowedTools controls what a child *can* do (allow-list).
//   - exclusion set controls what no child *may ever* do (hard ceiling).
//
// A misconfigured agent definition cannot accidentally grant a child a
// dangerous capability — the exclusion set always wins. The set is
// append-only and code-owned; it is intentionally not configurable via
// settings or agent frontmatter.
//
// Source of pattern: Qwen Code's session-scoped tool exclusions for
// nested agent contexts (qwen-code-analysis.md §3.6).

import type { AgentDefinition } from './types.js';

export const SUBAGENT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set<string>([
  // No recursive sub-agent spawning — children can't fork further children.
  'AgentTool',
  // Session-scoped cron CRUD stays parent-side. `run` and `tick` are
  // operational (manual fire / debug tick), not CRUD, so they are not
  // listed here — a child's tool surface wouldn't carry them anyway.
  'cron_add',
  'cron_list',
  'cron_show',
  'cron_pause',
  'cron_resume',
  'cron_delete',
  // Parent-side control plane.
  'task_stop',
  'send_message',
  // Multi-agent workflows (2026-06-15) — `workflow_run` orchestrates its own
  // fan-out of sub-agent tasks. Excluding it here means a workflow task (itself
  // a sub-agent child) can never trigger a workflow → no nesting / recursion in
  // v1. The same exclusion strips `workflow_run` from the cron + channel tool
  // pools (both filter against this set), so an untrusted remote sender can't
  // trigger arbitrary workflows.
  'workflow_run',
]);

/**
 * Phase 1 T5 — build the per-child exclusion set, honoring the agent's
 * `allowedSubagents` declaration. When `allowedSubagents` is non-empty,
 * `AgentTool` is removed from the exclusion set so the child can dispatch
 * the listed subagent types (enforcement of the allowlist itself lives in
 * T8 at the AgentTool boundary). When empty, the Phase 13.5 no-recursive-
 * spawn ceiling stays in place — the global constant is returned as-is.
 *
 * The function is non-mutating: it returns a fresh `Set` only when reducing,
 * otherwise it returns the shared `SUBAGENT_EXCLUDED_TOOLS` reference.
 */
export function buildSubagentExclusions(
  agent: Pick<AgentDefinition, 'allowedSubagents'>,
): ReadonlySet<string> {
  if (!agent.allowedSubagents || agent.allowedSubagents.length === 0) {
    return SUBAGENT_EXCLUDED_TOOLS;
  }
  const reduced = new Set(SUBAGENT_EXCLUDED_TOOLS);
  reduced.delete('AgentTool');
  return reduced;
}
