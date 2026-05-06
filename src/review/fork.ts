// Phase 13.3 — review fork factory. One-shot dispatch wrapper around
// SubagentScheduler.delegate that builds the review-agent's prompt from
// trajectory/trace paths and silently swallows scheduler errors so the
// parent session never sees a review failure.
//
// The agent's maxTurns / restricted toolset are enforced by its
// definition file in bundle-default/agents/, not by this helper.

import type { SubagentScheduler } from '../runtime/scheduler.js';
import { REVIEW_ONLY_TOOLS } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';

export type ReviewAgentName = 'review-memory' | 'review-skill' | 'review-consolidate';

export interface ReviewForkPromptContext {
  trajectoryPath: string;
  tracePath: string;
  recentTurnCount: number;
}

export interface RunReviewForkOpts {
  scheduler: SubagentScheduler;
  agentName: ReviewAgentName;
  parentSessionId: string;
  parentSignal: AbortSignal;
  parentToolPool: Tool<unknown, unknown>[];
  parentToolContext: ToolContext;
  promptContext: ReviewForkPromptContext;
  traceRecorder?: (event: TraceEvent) => void;
}

function buildPrompt(agentName: ReviewAgentName, ctx: ReviewForkPromptContext): string {
  return [
    `You are operating as a review sub-agent (${agentName}).`,
    `Trajectory file: ${ctx.trajectoryPath}`,
    `Trace file: ${ctx.tracePath}`,
    `Recent turn count to focus on: ${ctx.recentTurnCount}`,
    '',
    'Read the trajectory and trace, then file proposals via your allowed proposal tool. Be conservative.',
  ].join('\n');
}

export async function runReviewFork(opts: RunReviewForkOpts): Promise<void> {
  // Augment the parent's pool with review-only tools so the scheduler's
  // filterToolsForChild can surface memory_propose / skill_propose for
  // review-* agents (whose allowedTools declare them).
  const augmentedPool: Tool<unknown, unknown>[] = [...opts.parentToolPool, ...REVIEW_ONLY_TOOLS];

  try {
    await opts.scheduler.delegate({
      agentName: opts.agentName,
      prompt: buildPrompt(opts.agentName, opts.promptContext),
      parentSessionId: opts.parentSessionId,
      parentSignal: opts.parentSignal,
      parentToolPool: augmentedPool,
      parentToolContext: opts.parentToolContext,
      ...(opts.traceRecorder !== undefined ? { traceRecorder: opts.traceRecorder } : {}),
    });
  } catch (_err) {
    // Review failures never bubble. Best-effort trace recording for diagnosis.
    try {
      opts.traceRecorder?.({
        type: 'session_end',
        reason: 'error',
        iso: new Date().toISOString(),
      } as never);
    } catch {
      // even the trace recorder is best-effort.
    }
  }
}
