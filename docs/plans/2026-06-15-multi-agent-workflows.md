# Multi-agent workflows — plan (2026-06-15)

Spec: `docs/specs/2026-06-15-multi-agent-workflows-design.md`. Decisions: declarative deterministic engine + path-granular locking; parallel fan-out is the headline. Autonomous build (spec → plan → execute → ship, no gates).

## Ownership (foundation first; then parallel against the foundation contracts)

**W1 — Foundation (orchestrator, by hand; the load-bearing + security-sensitive core).**
- NEW `src/workflows/types.ts` — `WorkflowDef`/`Phase`/`Task`/`ArgSpec` Zod schema + inferred types.
- NEW `src/workflows/events.ts` — the workflow lifecycle event union (`workflow_started`/`_phase_started`/`_task_started`/`_task_complete`/`_complete`) so the engine emits + the renderer consumes one fixed contract.
- NEW `src/runtime/pathLock.ts` — `PathLockManager` (`PathScope = {kind:'all'} | {kind:'globs',globs}`; conservative overlap; FIFO + abort-aware; absent ⇒ `all` ⇒ Semaphore(1)-equivalent).
- WIRE `src/runtime/scheduler.ts` — replace `writeLock: Semaphore` with `pathLock: PathLockManager`; `DelegateInput.writeScope?: PathScope`; write-capable child acquires `pathLock.acquire(input.writeScope ?? {kind:'all'})`; thread the task's write-scope onto the child `ToolContext`.
- WIRE `src/server/runtime.ts` — `new Semaphore(1)` → `new PathLockManager()`.
- WRITE-SCOPE ENFORCEMENT — a write-scope guard in the permission path (`src/permissions/`) that denies `Write`/`Edit`/destructive-`Bash` outside the child's declared scope; threaded via `ToolContext`.
- Tests: `pathLock` (disjoint concurrent / overlap serial / all-blocks / abort / back-compat); write-scope enforcement; scheduler back-compat (existing tests stay green).

**W2 — Engine + template (owner A).** `src/workflows/engine.ts` (phase loop + barrier + parallel fan-out via `scheduler.delegate`, `writeScope` from the task's `writes`, output collection keyed by phase, map resolution over args/prior-output, per-task failure tolerance, structured-JSON parse + one repair) + `src/workflows/template.ts` (safe dotpath interpolator) + tests.

**W3 — Loader (owner B).** `src/workflows/loader.ts` — scan project/user/bundle `workflows/*.yaml`, validate via W1 types, reject unknown `agent`, validate template refs against declared args + prior phase ids. Tests.

**W4 — Invocation (owner C).** `src/cli/workflowCommand.ts` + `src/main.ts` (`sov workflow list|show|run`); `/workflow` slash command (registry + `dispatchCommand`/server command route); `src/tools/WorkflowRunTool.ts` (`workflow_run`) + add to `SUBAGENT_EXCLUDED_TOOLS` + exclude from the channel tool pool. Tests.

**W5 — Observability (owner D).** Emit the W1 events from the engine seam; plain-text rendering in `sov drive`/CLI; a basic TUI workflow line (reuse the delegation-line vocabulary). Tests.

**W6 — Bundle example + docs (owner E).** `bundle-default/workflows/review.yaml` (a real, useful fan-out→verify→synthesize example) + `docs/usage.md` (a Workflows section) + `docs/extending.md` (authoring recipe) + a semantic/behavioral smoke.

**W7 — Integrate + gate + ship (orchestrator).** Full clean-env gate (lint/typecheck/test/go test); an adversarial review of the path-lock + write-scope concurrency-safety core (can two disjoint-declared tasks clash? can an under-declared write escape the guard? abort/teardown races?); behavioral smoke (`sov workflow run`); docs (state snapshot, testing-log, backlog); commit/push; `sov upgrade`; release.

## Parallelization
W1 by hand (contracts + concurrency core). Then W2–W6 fan out (mostly disjoint files; the engine (W2) is the critical dependency for W4/W5's runtime behavior, but all compile against the W1 contracts; reconcile centrally). W7 integrates + ships.
