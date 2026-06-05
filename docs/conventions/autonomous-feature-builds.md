# Autonomous feature builds (spec → plan → ship)

**Locked rule.** Any **large feature build that warrants a planning phase** (i.e. one you'd write a spec + an implementation plan for) runs the full pipeline **autonomously, with no approval gates**. Do not stop to ask the founder to approve the spec or the plan, and do not check in between implementation tasks. Drive it to a shipped, verified, released state.

This composes with the other conventions ([`lint-and-commit.md`](lint-and-commit.md), [`subagent-policy.md`](subagent-policy.md), [`cutting-releases.md`](cutting-releases.md), [`sov-upgrade.md`](sov-upgrade.md), [`testing-log.md`](testing-log.md)) — it removes the *approval gates*, not the *quality gates*.

## The pipeline

1. **Spec.** Write the design spec at `docs/specs/YYYY-MM-DD-<topic>-design.md`. **Self-review it** before moving on — placeholder scan, internal consistency, scope, ambiguity — and fix inline. **Do NOT pause for spec approval.**
2. **Plan.** Immediately write the implementation plan at `docs/plans/YYYY-MM-DD-<feature>.md`, task-checkboxed for `superpowers:subagent-driven-development`. **Do NOT pause for plan approval.**
3. **Execute.** Immediately execute the plan with `superpowers:subagent-driven-development` — **fully autonomous**. Fresh subagent per task; review at sensible checkpoints. While executing, if bugs or issues surface, **address them autonomously with best judgment and prudence**. Do not stop to check in between tasks. Continue until the feature is shipped.
4. **Final pass.** Once the build is complete, do a final pass to confirm everything is copasetic; address any issues that surface.
5. **Docs + tests (always).** Update the documentation. Add and update the requisite tests. Run the full pre-commit gate (`bun run lint && bun run typecheck && bun run test`) and confirm it is green (no new failures beyond the known env-only set).
6. **Ship.** Add, commit, and push to remote. Then **update + reinstall the CLI** (`sov upgrade`), update **any agent skills** affected, and **cut a new release when applicable** (per [`cutting-releases.md`](cutting-releases.md) — any `src/` / `bundle-default/` / `packages/tui/` change).

## What this does NOT remove (still requires judgment / a pause)

- **Founder-reserved / strategic decisions** — anything that sets direction, cost, lock-in, or a major tech choice (e.g. TypeScript-vs-Python, build-vs-adopt). Surface it; do not decide it.
- **Destructive or irreversible actions outside the build itself** (deleting/overwriting unrelated work, force-pushing shared history, publishing to an external service beyond the normal release). Confirm first.
- **Decomposition.** If the spec reveals the work is actually several independent subsystems, decompose into sub-specs/plans first — still no approval gate, but plan accordingly.

## Scope

Applies to **all** large feature builds requiring a planning phase. Small or mechanical changes (a one-file fix, a config tweak, a doc edit) don't need the spec/plan ceremony — just make them (still through the quality gates). When unsure whether a change is "large," ask only "does this warrant a spec?" — if yes, this rule governs it end-to-end.
