# State snapshot — 2026-06-15 — Multi-agent workflows (declarative engine + path-granular locking)

**Canonical current-state snapshot.** A deterministic multi-agent orchestration layer was built into the harness, with **parallel fan-out as the headline** and **path-granular write locking** so write-capable fan-out across disjoint paths runs in parallel. Latest release pending this snapshot. The learning-loop soak continues untouched (recall ON by default — the standing #1 ACTIVE-FOCUS track). No new ADRs; the example workflow lives in the bundle (per ADR H-0010).

## Headline — Multi-agent workflows

**The gap (identified the prior turn):** the harness had strong sub-agent *primitives* (scheduler, `AgentTool`, lanes, background tasks) but fan-out was **model-driven only** (no deterministic pipelines/parallel/map-reduce), and a single global write-lock (`Semaphore(1)`) **serialized all write-capable fan-out**.

**Founder-locked design:** a **DECLARATIVE engine** (workflows defined as data; no arbitrary code execution — fits the safe-by-default posture) + **path-granular locking**. Spec `docs/specs/2026-06-15-multi-agent-workflows-design.md`, plan `docs/plans/2026-06-15-multi-agent-workflows.md`.

**What shipped:**
- **`PathLockManager` (`src/runtime/pathLock.ts`)** — replaces the global `Semaphore(1)` write-lock. A write-capable child acquires a **write SCOPE**; disjoint scopes run **concurrently**, overlapping ones serialize, one release wakes *all* disjoint waiters. **Back-compat: an undeclared scope = `{kind:'all'}` = whole tree = byte-identical to the old global lock**, so model-driven `AgentTool` delegation is unchanged (the scheduler suite stays green through the `writeLock→pathLock` rename across 8 files).
- **Enforced write-scope (`src/permissions/writeScope.ts`)** — a task's declared `writes` is an *enforced* permission boundary (FileWrite/FileEdit checked path-by-path via `Bun.Glob`; write-capable Bash denied in narrow scopes). So **disjoint declared scopes provably can't clash even on author under-declaration** — a stray write fails closed.
- **The engine (`src/workflows/`)** — `WorkflowDef` (YAML: phases / parallel `tasks` / `map` fan-out / barriers / output threading / per-task `lane` + `writes`); `runWorkflow` runs phases in order with a barrier, fans phase tasks out in **parallel** via `scheduler.delegate` (real concurrency bounded by lane semaphores + the path-lock), threads outputs forward (text or parsed JSON), tolerates per-task failure. Safe dotpath template interpolator (no eval). Loader scans project>user>bundle `workflows/*.yaml`.
- **Surfaces:** **`sov workflow list|show|run [--arg k=v] [--json]`** (CLI, functional) + **`/workflow`** slash (in-session, functional, via the `CommandContext.workflows` capability). A bundled example `bundle-default/workflows/review.yaml` (fan-out→verify→synthesize over a diff/dimensions).

**Built:** W1 (the concurrency core + contracts) by hand; W2–W6 (engine, loader, invocation, observability, bundle/docs) via a 5-owner disjoint-file workflow fan-out + per-owner review; seams reconciled centrally (the `/workflow` capability, the `task.lane`→`roleOverride` plumbing, typecheck/lint). **Gate:** lint clean (785 files) + typecheck clean + **TS 4198 pass / 0 fail / 16 skip** (+84) + Go green. Behavioral smoke confirms `sov workflow list/show` + the loader + bundle end-to-end. Shipped across commits `476eb27` (W1) → `86c5818` (W6).

**Deferred (tracked):**
- **#61 — the `workflow_run` TOOL** (agent-invocable). Scaffolding + `SUBAGENT_EXCLUDED_TOOLS` entry landed, but not wired into `assembleToolPool` (a runtime self-reference: the pool is assembled before the runtime object exists). CLI + slash deliver the feature meanwhile.
- **#62 — `/workflow` TUI progress** over SSE (engine emits events; server-side onEvent→bus forwarding not yet wired; CLI prints progress directly).
- v2 (spec §out-of-scope): arbitrary loops/conditionals, scripted (sandboxed-JS) workflows, nested workflows, resume/checkpointing.

## Open backlog (11)
#17 (eval-gated auto-promote) · #50–#54 (Phase-2 learning extraction) · #58 (`runtime.model` process-global) · #59 (F36 sibling-hydrate) · #60 (F15 same-credential race) · #61 (workflow_run tool wiring) · #62 (workflow TUI progress). Founder-reserved (NOT backlog): rented-engine choice, go/no-go, auto-promote default, recall-on default.

Predecessor: `docs/state/2026-06-14-config-live-apply.md` (config live-apply UX + the day's post-audit bug hunt). Find the latest via `ls docs/state/*.md | sort -r | head -1`.
