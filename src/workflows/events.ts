// Workflow lifecycle events (2026-06-15 — multi-agent workflows). Emitted by
// the engine, rendered by `sov drive`/CLI (plain text) and the TUI (a workflow
// line). A fixed contract so emit + render never drift. Mirrors the delegation
// progress-event pattern (src/router/progressEvents.ts).

import type { WorkflowEvent } from '@yevgetman/sov-sdk/core/workflowPort';

// `WorkflowEvent` now lives in open core (`core/workflowPort.js`) so the open
// command contract (`CommandContext.workflows`) can reference the workflow
// capability shape without importing this proprietary layer. Re-exported here
// for existing importers.
export type { WorkflowEvent };

/** Sink the engine calls for each lifecycle event. Always optional at call
 *  sites — a no-op when the surface doesn't render progress. */
export type WorkflowEventSink = (event: WorkflowEvent) => void;

/** Render a workflow event as a single plain-text line (used by `sov drive`,
 *  the CLI, and as the TUI fallback). Kept here so every surface formats events
 *  identically. */
export function formatWorkflowEvent(event: WorkflowEvent): string {
  switch (event.type) {
    case 'workflow_started':
      return `[workflow] ${event.workflow} — ${event.phaseCount} phase(s)`;
    case 'workflow_phase_started':
      return `[workflow] phase ${event.index + 1}: ${event.phaseId} — ${event.taskCount} task(s) in parallel`;
    case 'workflow_task_started':
      return `[workflow]   → ${event.phaseId}/${event.label}${event.lane ? ` (${event.lane})` : ''}`;
    case 'workflow_task_complete':
      return `[workflow]   ${event.ok ? '✓' : '✗'} ${event.phaseId}/${event.label}`;
    case 'workflow_complete': {
      const failed = event.phases.reduce((n, p) => n + p.failed, 0);
      return `[workflow] ${event.workflow} ${event.ok ? 'complete' : 'completed with errors'} — ${failed} failed task(s), ${Math.round(event.durationMs)}ms`;
    }
  }
}
