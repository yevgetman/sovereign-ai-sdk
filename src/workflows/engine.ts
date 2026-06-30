// The deterministic multi-agent workflow engine (2026-06-15 — see
// docs/specs/2026-06-15-multi-agent-workflows-design.md).
//
// runWorkflow() is the ONLY new spawn orchestrator. It never spawns children
// directly — it calls `host.scheduler.delegate()` (THE child-spawn
// path), inheriting provider/model resolution, lane routing, per-child
// timeout, parent-child session lineage, traces, and the learning hook.
//
// Execution model:
//   1. Validate `args` against `def.args` (Zod), coercing declared types.
//   2. For each phase IN ORDER, with a BARRIER between them (a phase starts
//      only when the previous fully resolves):
//        - resolve the task list (fixed `tasks`, or `map` → one task per
//          element of the resolved-array, binding the loop var);
//        - fan the tasks out in PARALLEL (the headline) over `delegate(...)`,
//          bounded to WORKFLOW_PHASE_CONCURRENCY in flight (the rest queue) so a
//          wide `map` can't exhaust resources or trip the scheduler's per-parent
//          child cap. Real provider concurrency is throttled further by the lane
//          semaphores + the path-lock INSIDE delegate().
//        - collect each task's output (text, or parsed JSON for `output:json`)
//          keyed by phase id. A task whose terminal != completed (or whose JSON
//          fails to parse after one repair retry) records `{ error }` and does
//          NOT abort the phase.
//   3. Return WorkflowResult; `finalText` is the last phase's text.

import { loadPermissionSettings } from '../config/settings.js';
import type { WorkflowResult } from '../core/workflowPort.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import type { AskResponse } from '../permissions/types.js';
import { KNOWN_LANE_NAMES } from '../router/laneRegistry.js';
import type { PathScope } from '../runtime/pathLock.js';
import type { DelegateInput, DelegateResult } from '../runtime/scheduler.js';
import type { ToolContext } from '../tool/types.js';
import type { WorkflowEventSink } from './events.js';
import type { WorkflowHost } from './host.js';
import { validateWorkflow } from './loader.js';
import {
  type PhaseOutput,
  type TaskOutput,
  type TemplateContext,
  interpolate,
  resolveOverArray,
} from './template.js';
import type { ArgSpec, Phase, Task, WorkflowDef } from './types.js';

/** Default loop-variable name when a `map` phase omits `as`. */
const DEFAULT_LOOP_VAR = 'item';

/** Max tasks the engine runs concurrently within a phase. Bounds resource use
 *  (a `map` over a 1000-element list spawns at most this many children at once,
 *  the rest queue) AND is passed as the per-call child-cap override so the
 *  scheduler's default recursion guard never truncates a wide fan-out. Real
 *  provider concurrency is throttled further by the lane semaphores. */
const WORKFLOW_PHASE_CONCURRENCY = 8;

/** Run `items` through `fn` with at most `limit` concurrent in flight, preserving
 *  result order. Used to bound a phase's parallel fan-out. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

export type RunWorkflowOpts = {
  host: WorkflowHost;
  def: WorkflowDef;
  args: Record<string, unknown>;
  parentSessionId: string;
  signal?: AbortSignal;
  onEvent?: WorkflowEventSink;
};

// `WorkflowResult` now lives in open core (`core/workflowPort.js`) so the open
// command contract (`CommandContext.workflows`) can reference the workflow
// capability shape without importing this proprietary engine. Re-exported here
// for existing importers.
export type { WorkflowResult };

/** Coerce + validate raw args against the declared `def.args`. Required args
 *  must be present; missing-with-default fills the default; types coerce
 *  (string/number/boolean/list). Throws a clear error on a missing required
 *  arg or an uncoercible value — fail fast at the system boundary. */
export function validateArgs(
  declared: Record<string, ArgSpec> | undefined,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (declared === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(declared)) {
    const provided = raw[name];
    if (provided === undefined) {
      // Coerce the default through the SAME path as a provided value — so a
      // `list`/`number` default expressed as a string (e.g. `default: 'a,b'`)
      // is split/parsed identically and a later `map.over: args.<list>` works
      // whether the value came from the default or `--arg` (2026-06-15 review).
      if (spec.default !== undefined) out[name] = coerceArg(name, spec, spec.default);
      else if (spec.required) throw new Error(`workflow arg '${name}' is required`);
      continue;
    }
    out[name] = coerceArg(name, spec, provided);
  }
  return out;
}

/** Coerce one raw value to a declared ArgSpec type. */
function coerceArg(name: string, spec: ArgSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string' ? value : String(value);
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) throw new Error(`workflow arg '${name}' must be a number`);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error(`workflow arg '${name}' must be a boolean`);
    case 'list':
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') return value.split(',').map((s) => s.trim());
      throw new Error(`workflow arg '${name}' must be a list`);
  }
}

/** Build the headless permission gate the workflow's delegated children run
 *  under. Mirrors cron/`sov drive`: layered allow/deny rules still apply, but
 *  any fall-through to `ask` auto-denies (a workflow has no interactive
 *  approver). Per-task `writes` enforcement is layered on inside delegate(). */
function buildWorkflowCanUseTool(host: WorkflowHost) {
  const permissionSettings = loadPermissionSettings({
    cwd: host.cwd,
    harnessHome: host.harnessHome,
  });
  const ask = async (): Promise<AskResponse> => 'deny';
  return buildCanUseTool({
    mode: 'default',
    ask,
    alwaysAllow: new Set<string>(),
    ruleLayers: permissionSettings.layers,
  });
}

/** Extract the parsed JSON value from an agent's final text: a fenced
 *  ```json block if present, else the whole trimmed text. Returns
 *  `{ ok:false }` when no JSON parses. */
function extractJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    return { ok: false };
  }
}

/** Build the DelegateInput for one resolved task. `parentToolContext` already
 *  carries the per-session scheduler/registry/learning wiring; we override its
 *  sessionId-derived fields by passing it straight through (delegate() re-stamps
 *  the child's sessionId). `writeScope` comes from the task's declared `writes`;
 *  a lane override threads through `task.lane` (the agent's role already routes
 *  via the lane registry, so this is reserved for an explicit per-task pin). */
function buildTaskDelegateInput(
  task: Task,
  prompt: string,
  parentSessionId: string,
  parentToolContext: ToolContext,
  signal: AbortSignal | undefined,
): DelegateInput {
  const writeScope: PathScope | undefined =
    task.writes !== undefined ? { kind: 'globs', globs: task.writes } : undefined;
  return {
    agentName: task.agent,
    prompt,
    parentSessionId,
    parentToolPool: parentToolContext.parentToolPool ?? [],
    parentToolContext,
    // Lift the per-parent child cap to the engine's bounded phase-fan-out width
    // so a wide (operator-declared) parallel fan-out isn't silently truncated by
    // the default recursion-guard cap. The engine already bounds real in-flight
    // concurrency to this width (see runPhase), so this never spawns more.
    maxChildrenOverride: WORKFLOW_PHASE_CONCURRENCY,
    ...(parentToolContext.canUseTool !== undefined
      ? { canUseTool: parentToolContext.canUseTool }
      : {}),
    // Thread the parent's learning memory manager so a workflow-delegated task
    // feeds the scheduler's on_delegation learning hook exactly as a model-driven
    // AgentTool delegation does (2026-06-15 review — the active learning soak
    // relies on this; it was previously dropped).
    ...(parentToolContext.memoryManager !== undefined
      ? { memoryManager: parentToolContext.memoryManager }
      : {}),
    ...(writeScope !== undefined ? { writeScope } : {}),
    ...(task.lane !== undefined ? { roleOverride: task.lane } : {}),
    ...(signal !== undefined ? { parentSignal: signal } : {}),
  };
}

/** A resolved task: the declared task + its interpolated prompt + display
 *  label + the loop item it was fanned across (undefined for fixed tasks). */
type ResolvedTask = {
  task: Task;
  prompt: string;
  label: string;
  lane?: string;
};

/** Resolve a phase to its concrete task list (interpolating prompts against the
 *  current context). A `map` phase fans `phase.task` across the resolved-over
 *  array, binding the loop var; a `tasks` phase interpolates each fixed task. */
function resolvePhaseTasks(phase: Phase, ctx: TemplateContext): ResolvedTask[] {
  if (phase.map !== undefined && phase.task !== undefined) {
    const loopVar = phase.map.as ?? DEFAULT_LOOP_VAR;
    const items = resolveOverArray(phase.map.over, ctx);
    return items.map((value, i) => {
      const itemCtx: TemplateContext = { ...ctx, item: { ...ctx.item, [loopVar]: value } };
      const task = phase.task as Task;
      return {
        task,
        prompt: interpolate(task.prompt, itemCtx),
        label: `${task.label ?? task.agent}[${i}]`,
        ...(task.lane !== undefined ? { lane: task.lane } : {}),
      };
    });
  }
  return (phase.tasks ?? []).map((task) => ({
    task,
    prompt: interpolate(task.prompt, ctx),
    label: task.label ?? task.agent,
    ...(task.lane !== undefined ? { lane: task.lane } : {}),
  }));
}

/** Run a single resolved task to completion and reduce it to a TaskOutput. A
 *  non-completed terminal records `{ error }`; a `json` task extracts+parses
 *  (one repair retry) and records `{ error }` on a hard parse failure. Never
 *  throws — a task failure must not abort the phase. */
async function runTask(
  resolved: ResolvedTask,
  parentSessionId: string,
  parentToolContext: ToolContext,
  runDelegate: (input: DelegateInput) => Promise<DelegateResult>,
  signal: AbortSignal | undefined,
): Promise<TaskOutput> {
  const { task } = resolved;
  let result: DelegateResult;
  try {
    result = await runDelegate(
      buildTaskDelegateInput(task, resolved.prompt, parentSessionId, parentToolContext, signal),
    );
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : String(err) };
  }
  if (result.terminal.reason !== 'completed' && result.terminal.reason !== 'max_turns') {
    return { text: result.summary, error: `terminal=${result.terminal.reason}` };
  }
  if (task.output !== 'json') return { text: result.summary };
  return reduceJsonTask(
    task,
    resolved,
    result,
    parentSessionId,
    parentToolContext,
    runDelegate,
    signal,
  );
}

/** JSON-output reduction with ONE repair retry. Parses the agent's final text;
 *  on failure, re-delegates once with a corrective prompt; records `{ error }`
 *  if the repair also fails to parse. */
async function reduceJsonTask(
  task: Task,
  resolved: ResolvedTask,
  result: DelegateResult,
  parentSessionId: string,
  parentToolContext: ToolContext,
  runDelegate: (input: DelegateInput) => Promise<DelegateResult>,
  signal: AbortSignal | undefined,
): Promise<TaskOutput> {
  const first = extractJson(result.summary);
  if (first.ok) return { text: result.summary, json: first.value };
  const repairPrompt = `${resolved.prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY a single JSON value (optionally in a \`\`\`json fenced block), nothing else.`;
  let repaired: DelegateResult;
  try {
    repaired = await runDelegate(
      buildTaskDelegateInput(task, repairPrompt, parentSessionId, parentToolContext, signal),
    );
  } catch (err) {
    return { text: result.summary, error: err instanceof Error ? err.message : String(err) };
  }
  const second = extractJson(repaired.summary);
  if (second.ok) return { text: repaired.summary, json: second.value };
  return { text: repaired.summary, error: 'output: json — failed to parse after one repair retry' };
}

/** Reduce a phase's completed task outputs to its stored PhaseOutput. A
 *  single-task `tasks` phase is `single` (exposes `.text` / `.json`); a `map`
 *  phase (or multi-task `tasks`) is `multi` (exposes `.results` + the `.field`
 *  flatten sugar). */
function toPhaseOutput(phase: Phase, outputs: TaskOutput[]): PhaseOutput {
  const isSingle = phase.map === undefined && (phase.tasks?.length ?? 0) === 1;
  if (isSingle && outputs[0] !== undefined) return { kind: 'single', task: outputs[0] };
  return { kind: 'multi', results: outputs };
}

/** Run one phase: resolve tasks, fire them all in parallel, collect outputs,
 *  emit lifecycle events. Returns the phase's reduced output + its task-failure
 *  count. */
async function runPhase(
  phase: Phase,
  index: number,
  ctx: TemplateContext,
  parentSessionId: string,
  parentToolContext: ToolContext,
  runDelegate: (input: DelegateInput) => Promise<DelegateResult>,
  signal: AbortSignal | undefined,
  onEvent: WorkflowEventSink | undefined,
): Promise<{ output: PhaseOutput; total: number; failed: number }> {
  // Resolve the phase's task list (interpolating prompts / the map.over array).
  // This can THROW when an earlier phase failed and a downstream ref reads its
  // missing `.json` — in that case the whole phase degrades to a single failed
  // task rather than crashing the run (the per-task failure contract must hold
  // for resolution-time failures too, 2026-06-15 review fix H3).
  let tasks: ResolvedTask[];
  try {
    tasks = resolvePhaseTasks(phase, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent?.({ type: 'workflow_phase_started', phaseId: phase.id, index, taskCount: 0 });
    const errorTask: TaskOutput = { text: '', error: message };
    return { output: toPhaseOutput(phase, [errorTask]), total: 1, failed: 1 };
  }
  onEvent?.({ type: 'workflow_phase_started', phaseId: phase.id, index, taskCount: tasks.length });

  // The headline: fan the phase's tasks out in PARALLEL, bounded to
  // WORKFLOW_PHASE_CONCURRENCY in flight (the rest queue). Real provider
  // concurrency is throttled further by the lane semaphores + the path-lock
  // inside delegate().
  const outputs = await mapWithConcurrency(
    tasks,
    WORKFLOW_PHASE_CONCURRENCY,
    async (resolved, i) => {
      onEvent?.({
        type: 'workflow_task_started',
        phaseId: phase.id,
        index: i,
        label: resolved.label,
        ...(resolved.lane !== undefined ? { lane: resolved.lane } : {}),
      });
      const output = await runTask(
        resolved,
        parentSessionId,
        parentToolContext,
        runDelegate,
        signal,
      );
      onEvent?.({
        type: 'workflow_task_complete',
        phaseId: phase.id,
        index: i,
        label: resolved.label,
        ok: output.error === undefined,
      });
      return output;
    },
  );

  const failed = outputs.filter((o) => o.error !== undefined).length;
  return { output: toPhaseOutput(phase, outputs), total: outputs.length, failed };
}

/** Resolve the last phase's representative text for `finalText` (the
 *  conventional synthesis output). A single-task phase yields its text; a map
 *  phase yields its per-task texts joined. */
function finalTextOf(output: PhaseOutput | undefined): string {
  if (output === undefined) return '';
  if (output.kind === 'single') return output.task.text;
  return output.results.map((r) => r.text).join('\n\n');
}

/** Execute a declarative workflow. See the file header for the model. */
export async function runWorkflow(opts: RunWorkflowOpts): Promise<WorkflowResult> {
  const { host, def, parentSessionId, signal, onEvent } = opts;
  const startedAt = Date.now();

  // Semantic gate (2026-06-15 review fix M4): validate every `task.agent`,
  // template ref, and `lane` against the live registry BEFORE running any phase.
  // This was defined but never wired — so an unknown agent or a typo'd `{{ref}}`
  // surfaced as a confusing mid-run failure (or, for refs, an uncaught throw
  // out of a later phase) after earlier phases had already spent real work. Now
  // it fails fast at the start of the run on every surface (CLI / slash / tool).
  const semanticErrors = validateWorkflow(def, host.scheduler.agentNames(), KNOWN_LANE_NAMES);
  if (semanticErrors.length > 0) {
    throw new Error(`workflow '${def.name}' is invalid:\n  - ${semanticErrors.join('\n  - ')}`);
  }

  const args = validateArgs(def.args, opts.args);

  onEvent?.({ type: 'workflow_started', workflow: def.name, phaseCount: def.phases.length });

  const canUseTool = buildWorkflowCanUseTool(host);
  const parentToolContext = host.buildToolContext(parentSessionId, canUseTool);
  const runDelegate = (input: DelegateInput): Promise<DelegateResult> =>
    host.scheduler.delegate(input);

  const phaseOutputs: Record<string, PhaseOutput> = {};
  const runSummaryPhases: Array<{ phaseId: string; total: number; failed: number }> = [];
  let lastOutput: PhaseOutput | undefined;

  // Barrier between phases: each `await` here blocks the next phase until the
  // current one fully resolves (every parallel task settled).
  for (let i = 0; i < def.phases.length; i++) {
    const phase = def.phases[i] as Phase;
    const ctx: TemplateContext = { args, phases: phaseOutputs };
    const { output, total, failed } = await runPhase(
      phase,
      i,
      ctx,
      parentSessionId,
      parentToolContext,
      runDelegate,
      signal,
      onEvent,
    );
    phaseOutputs[phase.id] = output;
    runSummaryPhases.push({ phaseId: phase.id, total, failed });
    lastOutput = output;
  }

  const totalFailed = runSummaryPhases.reduce((n, p) => n + p.failed, 0);
  const ok = totalFailed === 0;
  const durationMs = Date.now() - startedAt;

  onEvent?.({
    type: 'workflow_complete',
    workflow: def.name,
    ok,
    durationMs,
    phases: runSummaryPhases,
  });

  return {
    ok,
    phases: phaseOutputs,
    finalText: finalTextOf(lastOutput),
    runSummary: { phases: runSummaryPhases, durationMs },
  };
}
