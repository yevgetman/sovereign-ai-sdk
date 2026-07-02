// Phase 13.3 — memory consolidation pass. Dispatches the
// review-consolidate sub-agent against $HARNESS_HOME/memory/MEMORY.md and
// USER.md. Fire-and-forget; failures swallowed by runReviewFork.
//
// The consolidate agent files proposals via memory_propose with target
// set to whichever file it's consolidating. Approval flows through the
// same /review approve gate; v0 appends the consolidated entry rather
// than rewriting the affected entries in place (documented in CLAUDE.md
// follow-ups).

import { join } from 'node:path';
import type { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { runReviewFork } from './fork.js';

export interface RunConsolidationOpts {
  scheduler: SubagentScheduler;
  parentSessionId: string;
  parentSignal: AbortSignal;
  harnessHome: string;
  parentToolPool: Tool<unknown, unknown>[];
  parentToolContext: ToolContext;
  traceRecorder?: (event: TraceEvent) => void;
}

export async function runConsolidation(opts: RunConsolidationOpts): Promise<void> {
  const memDir = join(opts.harnessHome, 'memory');
  await runReviewFork({
    scheduler: opts.scheduler,
    agentName: 'review-consolidate',
    parentSessionId: opts.parentSessionId,
    parentSignal: opts.parentSignal,
    parentToolPool: opts.parentToolPool,
    parentToolContext: opts.parentToolContext,
    promptContext: {
      // Consolidation: primary = MEMORY.md, secondary = USER.md. The
      // review-consolidate.md agent prompt knows it's reading memory
      // files; ReviewForkPromptContext's generic primary/secondary
      // naming makes the role-specific mapping explicit at the call
      // site instead of overloading trajectory/trace semantics.
      primaryFile: join(memDir, 'MEMORY.md'),
      secondaryFile: join(memDir, 'USER.md'),
      recentTurnCount: 0,
    },
    ...(opts.traceRecorder !== undefined ? { traceRecorder: opts.traceRecorder } : {}),
  });
}
