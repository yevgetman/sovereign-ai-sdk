// src/core/workflowPort.ts — open-core workflow capability CONTRACT.
//
// These are the pure workflow data/contract shapes the open command contract
// references via `CommandContext.workflows?: WorkflowCommandCapability`. They
// describe WHAT a workflow run returns + emits — distinct from the proprietary
// `workflows/engine.ts` that actually RUNS workflows (the same open-contract /
// proprietary-impl split as `TaskManagerPort` vs `TaskManager`). Relocated here
// so the open contract never imports the proprietary `workflows/` layer;
// `workflows/events.ts` (`WorkflowEvent`), `workflows/engine.ts`
// (`WorkflowResult`), and `commands/workflowOps.ts` (`WorkflowSummary`,
// `WorkflowCommandCapability`) re-export them, inverting the dependency. Pure
// leaves: only primitives and nested records.

/** Workflow lifecycle events emitted by the engine, rendered by `sov drive` /
 *  CLI (plain text) and the TUI. A fixed contract so emit + render never drift. */
export type WorkflowEvent =
  | { type: 'workflow_started'; workflow: string; phaseCount: number }
  | { type: 'workflow_phase_started'; phaseId: string; index: number; taskCount: number }
  | {
      type: 'workflow_task_started';
      phaseId: string;
      index: number;
      label: string;
      lane?: string;
    }
  | {
      type: 'workflow_task_complete';
      phaseId: string;
      index: number;
      label: string;
      ok: boolean;
    }
  | {
      type: 'workflow_complete';
      workflow: string;
      ok: boolean;
      durationMs: number;
      phases: Array<{ phaseId: string; total: number; failed: number }>;
    };

/** The result of running one workflow; `finalText` is the last phase's text. */
export type WorkflowResult = {
  ok: boolean;
  phases: Record<string, unknown>;
  finalText: string;
  runSummary: {
    phases: Array<{ phaseId: string; total: number; failed: number }>;
    durationMs: number;
  };
};

/** One workflow as surfaced by `/workflow list`. */
export type WorkflowSummary = {
  name: string;
  description: string;
  source: 'project' | 'user' | 'bundle';
  phaseCount: number;
};

/** Runtime-bearing capability the surface supplies on CommandContext so
 *  `/workflow` can list + run workflows in the active session. The server
 *  command context wires it; standalone / headless surfaces omit it. Mirrors
 *  the optional `getRoutingStats` hook. */
export type WorkflowCommandCapability = {
  list: () => Promise<WorkflowSummary[]>;
  run: (
    name: string,
    args: Record<string, unknown>,
    onEvent?: (event: WorkflowEvent) => void,
  ) => Promise<WorkflowResult>;
};
