# Autonomous feature builds (spec → plan → ship)

## Building a feature → SOP-12 (inherited from the Firm apex)

This node's build procedure is the Firm's **apex SOP-12 — "Build a codebase"**, inherited via the firm
governance cascade. It **supersedes the prior local `autonomous-feature-builds` procedure**, and the agent
governing this node **must follow it for any code build, without being told**. Shape:

**spec → CEO green-light → autonomous subagent build → docs + tests → ship.**

1. Write + self-review the **spec** at `specs/YYYY-MM-DD-<topic>-design.md`.
2. **Present the spec to the CEO and PAUSE for an explicit green-light** — the one human gate; never
   self-approved, never skipped. (This is the change from the old local workflow, which had no gate.)
3. On green-light: write the **plan** at `plans/YYYY-MM-DD-<feature>.md`, then execute it **fully
   autonomously** — a fresh subagent per task, review between tasks, no further approval pauses; fix issues
   with sound judgment.
4. Always finish with **docs + tests** and the node quality gate green, then **ship** (commit + push +
   release plumbing). Stop only for a CEO-reserved decision the spec can't resolve, a
   destructive/irreversible/outward action, or decomposition into sub-specs.

**This node's specifics:** quality gate = `bun run lint && bun run typecheck && bun run test`; specs →
`specs/`, plans → `plans/` (this repo currently uses `specs/` + `plans/` — keep using those for
now, migrate later per thefirm/docs/firm-plugin-roadmap.md; never `superpowers/`). Full text:
`~/code/me/org/sop/12-build-a-codebase.md` (or `firm seed sovereign-ai`). It is **inherited, not copied** —
the apex owns it; this node may *tighten* but never relax it.
