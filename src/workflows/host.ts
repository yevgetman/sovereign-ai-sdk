// The narrow host handle the workflow engine runs against.
//
// `runWorkflow` (engine.ts) used to take the wide `Runtime` god-object AND
// reach directly into `server/routes/turns.ts` for `buildSessionToolContext` —
// coupling the proprietary engine to the server layer. `WorkflowHost` replaces
// both: it exposes EXACTLY the four things the engine touches and INJECTS
// `buildToolContext` (a drop-in for the old `buildSessionToolContext` call), so
// the engine no longer imports the server or the wide Runtime. The proprietary
// callers (cli/workflowCommand, tools/WorkflowRunTool, server/commandContext)
// build a WorkflowHost from their Runtime and supply the injected resolver — the
// SAME `buildSessionToolContext`, just passed in rather than imported here.
//
// Every member type is open-core (permissions / tool / runtime ports), so this
// handle carries no proprietary surface.

import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import type { Scheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { DelegationLifecycleEvent } from '@yevgetman/sov-sdk/tool/ports';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';

export type WorkflowHost = {
  /** Working directory — sourced for the headless permission settings. */
  cwd: string;
  /** Harness home — sourced for the headless permission settings. */
  harnessHome: string;
  /** The open child-spawn port surface: the engine only delegates children and
   *  lists agent names (the semantic gate). The named `Scheduler` port is the
   *  exact narrowing this field was built on (formerly a `Pick<...>`). */
  scheduler: Scheduler;
  /** Resolve the per-session parent ToolContext the workflow runs under. The
   *  signature matches `buildSessionToolContext` minus its leading `Runtime`, so
   *  a caller wires it as a drop-in:
   *    `(sid, cut, opts) => buildSessionToolContext(runtime, sid, cut, opts)`. */
  buildToolContext: (
    sessionId: string,
    canUseTool: CanUseTool,
    opts?: {
      delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void;
      effectivePool?: Tool<unknown, unknown>[];
    },
  ) => ToolContext;
};
