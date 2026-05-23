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
]);
