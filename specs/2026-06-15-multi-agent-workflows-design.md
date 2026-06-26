# Multi-agent workflows — design (2026-06-15)

## Problem

The harness has strong sub-agent *primitives* (the `SubagentScheduler`, `AgentTool`, cost-lane routing, background tasks) but fan-out is **model-driven** — the orchestrator LLM decides to call `AgentTool` N times — and there is no **deterministic orchestration layer** (parallel fan-out / pipelines / map-reduce / decompose→synthesize with barriers). Two limits compound it:

1. **No reusable, deterministic multi-phase plan.** You can't define "fan out reviewers across these dimensions, barrier, then verify each finding, then synthesize" as a first-class, repeatable artifact.
2. **A single global write-lock serializes write-capable fan-out.** Write-capable children acquire one process-wide `Semaphore(1)` (`src/runtime/scheduler.ts`, the v0 "path-lock") held for the child's whole run, so parallel write work runs effectively serial.

## Decisions (locked with the founder)

- **Declarative engine** (NOT a JS-script engine): workflows are defined as DATA and executed by a safe, deterministic engine that reuses the existing scheduler. No arbitrary code execution — consistent with the harness's safe-by-default posture.
- **Include path-granular locking**: replace the global write-lock with per-path locking so write-capable tasks on disjoint paths run in parallel — **backward-compatible** (undeclared write scope = whole tree = identical to today).
- **Parallel fan-out is the headline capability.** The engine centers parallel-within-a-phase and map-over-a-list fan-out; lane semaphores + path locks bound real concurrency.

## The definition format

A workflow is a YAML file under `workflows/` in project / user / bundle roots (precedence project > user > bundle, mirroring the agent loader), validated by a Zod schema. Shape:

```yaml
name: review-changes
description: Review a diff across dimensions, verify each finding, synthesize.
args:
  diff:       { type: string, required: true }
  dimensions: { type: list,   required: true }   # e.g. [bugs, security, perf]
phases:
  - id: find                         # parallel fan-out (the headline)
    map:
      over: args.dimensions          # fan `task` across each item
      as: dimension
    task:
      agent: code-reviewer
      lane: frontier
      output: json                   # parse the agent's final JSON
      prompt: |
        Review the {{dimension}} dimension of this diff and return
        {"findings":[{"claim","file","severity"}]}:
        {{args.diff}}
  - id: verify                       # BARRIER: waits for all of `find`
    map:
      over: find.findings            # dynamic fan-out over a prior phase's output
      as: finding
    task:
      agent: verify
      output: json
      prompt: 'Adversarially refute this finding; return {"real":bool}: {{finding.claim}}'
  - id: synthesize                   # single task; sees prior phase outputs
    task:
      agent: synthesizer
      prompt: 'Merge the confirmed findings into a report: {{verify.results}}'
```

### Schema (`src/workflows/types.ts`, Zod-validated)

- **`WorkflowDef`** `{ name, description, args?: Record<string, ArgSpec>, phases: Phase[] }`. `ArgSpec` `{ type: 'string'|'number'|'boolean'|'list', required?, default?, description? }`.
- **`Phase`** `{ id, ...(tasks | map) }` — exactly one of:
  - `tasks: Task[]` — a fixed set run in parallel.
  - `map: { over: <ref>, as?: string }` + `task: Task` — fan `task` across each element of the array `over` resolves to (`args.<field>` or `<phaseId>.<field>`); `as` names the loop variable (default `item`).
- **`Task`** `{ agent, prompt, lane?, writes?: string[], output?: 'text'|'json', label? }`.
  - `agent` — a loaded sub-agent (`subagent_type`); validated against the agent registry at load.
  - `prompt` — a template (see interpolation).
  - `lane?` — optional cost-lane override (`cheap`/`moderate`/`frontier`); otherwise the agent's own role/provider resolution applies.
  - `writes?` — declared write-path globs (relative to cwd). **Absent ⇒ read-only** (never takes a write lock). **Present ⇒** both the path-lock scope AND an enforced write boundary (see Safety). `['**']` = whole tree = serializes with everything (the legacy global-lock behavior).
  - `output` — `'text'` (default; the agent's final text) or `'json'` (engine extracts + parses a JSON value from the final message, one repair retry on parse failure).

### Interpolation (`src/workflows/template.ts`)

A small, **safe** interpolator (dotpath substitution only — NO `eval`, no expressions). References:
- `{{args.X}}` — a validated workflow arg.
- `{{<loopVar>}}` / `{{<loopVar>.field}}` — the current map item (text or a field of a parsed-JSON item).
- `{{<phaseId>.text}}` — a single-task phase's final text.
- `{{<phaseId>.json}}` / `{{<phaseId>.json.field}}` — a single-task phase's parsed JSON (when `output: json`).
- `{{<phaseId>.results}}` — a map phase's collected outputs (array; serialized to JSON for text prompts).
- `{{<phaseId>.<field>}}` — sugar: the flattened array of `item.<field>` across a map phase's JSON outputs (powers `map.over: find.findings`).

Unresolved refs are a load-time error (refs are validated against declared args + prior phase ids) where statically checkable, else a clear run-time error.

## The engine (`src/workflows/engine.ts`)

`runWorkflow({ runtime, def, args, parentSessionId, signal, onEvent }) → WorkflowResult`:
1. Validate `args` against `def.args` (Zod); coerce types.
2. For each phase **in order** (a **barrier** between phases — a phase starts only when the previous fully resolves):
   - Resolve the task list: fixed `tasks`, or `map` → resolve `over` to an array (error if not an array) → one task per element.
   - Run the phase's tasks **in parallel**: `Promise.all(tasks.map(t => scheduler.delegate(buildDelegateInput(t, ctx))))`. The engine fires them all; **real concurrency is bounded by the lane semaphores + the path-lock manager inside `delegate()`** — read-only/disjoint-write tasks run concurrently, overlapping-write tasks serialize.
   - Collect each task's output (text, or parsed JSON for `output: json`), keyed by phase id (+ index for map). A task that errors (terminal ≠ completed) records a structured `{ error }` and does NOT abort the phase (mirrors the scheduler's atom-failure tolerance); the synthesis phase sees the failures.
   - Emit progress events (below).
3. Return `WorkflowResult { ok, phases: Record<id, output>, finalText, runSummary }` — `finalText` is the last phase's text (the conventional synthesis).

The engine is the **only** new spawn orchestrator; it never spawns children directly — it calls `scheduler.delegate()` (THE child-spawn path), so it inherits provider/model resolution, lane routing, per-child timeout, parent-child session lineage, per-child traces, and the learning hook for free.

## Path-granular locking (`src/runtime/pathLock.ts`)

Replace `writeLock: Semaphore(1)` with a **`PathLockManager`**:
- `acquire(scope: PathScope, signal?) → Promise<release>` where `PathScope = { kind: 'all' } | { kind: 'globs', globs: string[] }`.
- Grants immediately iff `scope` does **not overlap** any currently-held scope; else queues (FIFO, abort-aware — mirrors `Semaphore`). `kind:'all'` overlaps everything. Two glob sets overlap if any pair could match a common path — computed conservatively (normalize to path prefixes; if either is a broad glob or prefixes nest, treat as overlapping). **Conservative = safe**: a false "overlap" only costs parallelism, never correctness.
- `delegate()` change: a write-capable child (`!agent.readOnly`) acquires `pathLock.acquire(input.writeScope ?? { kind: 'all' })`. **`writeScope` absent ⇒ `{kind:'all'}` ⇒ byte-identical to today's single global lock** (model-driven `AgentTool` delegation is unchanged). Workflow tasks pass `writeScope` derived from their declared `writes` → disjoint scopes parallelize.
- The runtime constructs one `PathLockManager` (replacing the `new Semaphore(1)`), threaded into the scheduler exactly where `writeLock` was. `Semaphore` stays for the lane caps.

### Safety: declared writes are an ENFORCED boundary, not just a lock hint

A task's declared `writes` is threaded onto its child `ToolContext` as a **write-scope boundary**; the permission layer (`canUseTool` / a write-scope guard) **denies** any `Write`/`Edit`/destructive-`Bash` whose target falls outside the declared globs. So if an author **under-declares** (claims a narrow scope but the agent tries to write elsewhere), the stray write is **refused** — it fails safe (a denied tool call), never a silent data race. This makes parallel write fan-out safe *by construction*: non-overlapping declared scopes provably can't clash. A task with no `writes` is read-only (writes denied entirely, as a read-only agent already is); `['**']` permits the whole tree (and serializes).

## Invocation surfaces

- **CLI** (`src/cli/workflowCommand.ts`, registered in `main.ts` like `cron`/`mission`): `sov workflow list`, `sov workflow show <name>`, `sov workflow run <name> [--arg k=v ...] [--json]` — headless, builds a runtime + a parent session (cron-style), drives the engine, prints progress + the final result; `--json` emits the structured `WorkflowResult`.
- **Slash command** (`/workflow`, via the command registry + `dispatchCommand`): `/workflow list`, `/workflow <name> [k=v ...]` — runs in the active session, streams progress events to the TUI, relays `finalText` as the turn output.
- **Tool** (`WorkflowRunTool`, `workflow_run`): model-invocable `{ name, args }` so an agent can trigger a named workflow mid-turn. **In `SUBAGENT_EXCLUDED_TOOLS`** (no workflow-from-subagent → no nesting/recursion in v1) and **excluded from the channel tool pool** (untrusted senders can't trigger arbitrary workflows).

## Observability

New workflow lifecycle events (mirroring `src/router/progressEvents.ts`): `workflow_started` (name, phase count), `workflow_phase_started` (id, task count), `workflow_task_started`/`workflow_task_complete` (phase, label, lane, ok), `workflow_complete` (per-phase ok counts, duration). Rendered as plain text in `sov drive`/CLI; the TUI gets a basic workflow line (reusing the delegation-line component vocabulary). Per-task traces + parent-child lineage come free from `delegate()`. Full TUI visualization is a follow-up.

## Security / trust

- Declarative ⇒ **no arbitrary code execution.** Workflow files are author-controlled bundle/user/project artifacts (same trust tier as agents — they ARE the agent-orchestration definitions). Not screened by injection-defense (that's for untrusted *context* files), but loaded only from the trusted roots.
- `workflow_run` is TTY/local-session only by tool-pool construction (excluded from channel + subagent pools).
- Declared `writes` enforced at the permission boundary (above) → parallel write fan-out is safe even with author error.

## Out of scope (v1) — deferred, documented

- Arbitrary loops / conditionals / `while` / loop-until-dry (v1 has parallel + map fan-out + barriers; bounded `repeat: {times}` is a candidate but deferred unless trivial).
- Scripted (`type: script`, sandboxed JS) workflows — the format is designed so a future `script:` workflow kind can be added without reworking the engine/loader.
- Nested workflows, resume/checkpointing, cross-process coordination, a gateway HTTP route.
- Full TUI workflow visualization (v1 = plain-text events + a basic line).

## Testing

- `pathLock`: disjoint scopes acquire concurrently; overlapping serialize; `all` blocks everything; abort while queued; back-compat (absent scope ≡ Semaphore(1) — model-driven delegate unchanged; the existing scheduler tests stay green).
- write-scope **enforcement**: a task writing outside its declared `writes` is denied; within is allowed; no-`writes` task is read-only.
- engine: barrier ordering; parallel fan-out actually concurrent (timing/instrumentation); map-over-args + map-over-prior-output; output threading (text + json + the `.field` flatten); a failing task doesn't abort the phase; arg validation.
- loader/template: precedence (project>user>bundle), unknown-agent rejection, unresolved-ref errors, the safe interpolator (no eval, dotpath only).
- invocation: a CLI `sov workflow run` e2e (MockProvider) + the `workflow_run` tool + a `/workflow` dispatch route test; `workflow_run` is excluded from subagent + channel pools.
- A bundled example workflow (e.g. `bundle-default/workflows/review.yaml`) + a semantic/behavioral smoke that runs it.

## Milestones — see `plans/2026-06-15-multi-agent-workflows.md`.
No new ADRs (additive; decisions captured here). Built per ADR H-0010 (vendor-neutral runtime; the example workflow lives in the bundle, not `src/`).
