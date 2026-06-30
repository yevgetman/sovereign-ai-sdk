// WorkflowRunTool (`workflow_run`) — model-invocable multi-agent workflow
// trigger (W4 / owner C). The model calls it mid-turn to run a named,
// declarative workflow (parallel fan-out / map / barrier orchestration).
//
// Closure-injected factory (mirrors buildHarnessInfoTool / buildToolSearchTool):
// the engine entrypoint runWorkflow needs the full Runtime (scheduler, session
// DB, tool pool), which a tool's ToolContext does not carry — so the runtime
// supplies it via this factory at tool-pool assembly time. Because the pool is
// assembled DURING runtime construction (before the runtime object exists), the
// factory takes a lazy `getRuntime` accessor backed by a holder the runtime
// fills in once built (mirrors the laneRegistryHolder pattern); `getRuntime()`
// is only ever called inside `call()`, which runs at turn time when the holder
// is populated.
//
// Safety (spec §"Invocation surfaces"): `workflow_run` is in
// SUBAGENT_EXCLUDED_TOOLS so it can never nest (a workflow task can't itself
// trigger a workflow → no recursion) AND so it's stripped from the channel +
// cron tool pools (an untrusted remote sender can't trigger arbitrary
// workflows). The exclusion is the single enforcement point — every non-
// interactive child pool already filters against that set.

import { z } from 'zod';
import type { Runtime } from '../server/runtime.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

export const WORKFLOW_RUN_TOOL_NAME = 'workflow_run';

const inputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('The name of the workflow to run (kebab-case; see `sov workflow list`).'),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Arguments for the workflow, keyed by the names the workflow declares. ' +
        "Validated + coerced against each workflow's arg spec by the engine.",
    ),
});

type Input = z.infer<typeof inputSchema>;

export type WorkflowRunToolOutput = {
  workflow: string;
  ok: boolean;
  finalText: string;
  durationMs: number;
  phases: Array<{ phaseId: string; total: number; failed: number }>;
};

/** Build the `workflow_run` tool bound to a live Runtime via a lazy accessor.
 *  The runtime supplies the loader roots (cwd / harnessHome / bundleRoot) and
 *  the engine's runtime dependency. `getRuntime` is resolved inside `call()`
 *  (turn time), so it can be wired before the runtime object is constructed. */
export function buildWorkflowRunTool(deps: { getRuntime: () => Runtime }): Tool<
  Input,
  WorkflowRunToolOutput
> {
  const { getRuntime } = deps;
  return buildTool<Input, WorkflowRunToolOutput>({
    name: WORKFLOW_RUN_TOOL_NAME,
    searchHint: 'Run a named declarative multi-agent workflow.',
    description: () =>
      [
        'Run a named, declarative multi-agent workflow: a reusable plan that fans out tasks across',
        'sub-agents in parallel, barriers between phases, and threads outputs forward to a final',
        'synthesis. Use this when a task maps onto a defined workflow (review-across-dimensions,',
        'map-over-a-list, decompose-then-synthesize) instead of issuing many AgentTool calls by hand.',
        "It returns the workflow's final text plus per-phase success counts; full per-task traces live",
        'in the trace log. List available workflows with `sov workflow list`.',
      ].join(' '),
    inputSchema,
    displayInput: (input) => input.name,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    renderHint: { kind: 'markdown' },
    async call(input, ctx) {
      const runtime = getRuntime();
      const { loadWorkflows } = await import('../workflows/loader.js');
      const { runWorkflow } = await import('../workflows/engine.js');
      const { buildSessionToolContext } = await import('../server/routes/turns.js');

      const { byName } = await loadWorkflows({
        cwd: runtime.cwd,
        harnessHome: runtime.harnessHome,
        ...(runtime.bundleRoot !== undefined ? { bundleRoot: runtime.bundleRoot } : {}),
      });
      const loaded = byName.get(input.name);
      if (!loaded) {
        const available = [...byName.keys()].sort().join(', ') || '(none loaded)';
        throw new Error(`workflow_run: unknown workflow '${input.name}'. Available: ${available}`);
      }

      const result = await runWorkflow({
        host: {
          cwd: runtime.cwd,
          harnessHome: runtime.harnessHome,
          scheduler: runtime.subagentScheduler,
          buildToolContext: (sid, cut, opts) => buildSessionToolContext(runtime, sid, cut, opts),
        },
        def: loaded.def,
        args: input.args ?? {},
        // The active session is the lineage root for the workflow's child tasks
        // — the engine passes this to scheduler.delegate as parentSessionId.
        parentSessionId: ctx.sessionId,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });

      const failed = result.runSummary.phases.reduce((n, p) => n + p.failed, 0);
      return {
        data: {
          workflow: input.name,
          ok: result.ok,
          finalText: result.finalText,
          durationMs: result.runSummary.durationMs,
          phases: result.runSummary.phases,
        },
        observation: {
          status: result.ok ? 'success' : 'error',
          summary: `workflow ${input.name} ${result.ok ? 'completed' : 'completed with errors'} — ${failed} failed task(s)`,
        },
      };
    },
    renderResult(output) {
      const header = `<workflow_result name="${output.workflow}" ok="${output.ok}" duration_ms="${Math.round(output.durationMs)}">`;
      return {
        content: [header, output.finalText, '</workflow_result>'].join('\n'),
        isError: !output.ok,
      };
    },
  });
}
