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

export const SUBAGENT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set<string>([
  // No recursive sub-agent spawning — children can't fork further children.
  'AgentTool',
  // Session-scoped scheduling stays parent-side.
  'cron_create',
  'cron_list',
  'cron_delete',
  // Parent-side control plane.
  'task_stop',
  'send_message',
  // Phase 13.3 — review proposal tools are review-fork-only; children
  // must not propose recursively.
  'memory_propose',
]);
