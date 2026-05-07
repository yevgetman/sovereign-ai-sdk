// Phase 13.3 — review fork factory. One-shot dispatch wrapper around
// SubagentScheduler.delegate that builds the review-agent's prompt from
// generic primary/secondary file paths (re-purposed per agent role —
// trajectory/trace for review forks, MEMORY.md/USER.md for consolidate)
// and silently swallows scheduler errors so the parent session never
// sees a review failure.
//
// The agent's maxTurns / restricted toolset are enforced by its
// definition file in bundle-default/agents/, not by this helper.

import type { SubagentScheduler } from '../runtime/scheduler.js';
import { LEARNING_ONLY_TOOLS, REVIEW_ONLY_TOOLS } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';

export type ReviewAgentName = 'review-memory' | 'review-skill' | 'review-consolidate';

export interface ReviewForkPromptContext {
  /** The agent's primary input file. For review forks, this is the
   *  trajectory file path. For consolidation, this is the MEMORY.md
   *  path. The agent's body prompt knows what to expect based on its
   *  role. */
  primaryFile: string;
  /** Optional companion file. For review forks, this is the trace
   *  file. For consolidation, this is USER.md. May be omitted when
   *  the agent only reads one file. */
  secondaryFile?: string;
  /** Phase 13.4 — when present, the review fork is told to prefer the
   *  instinct corpus (curated, evidence-backed, confidence-graduated)
   *  over raw trajectory slices. Falls back to the primary file when
   *  no instincts have been promoted yet. */
  instinctsDir?: string;
  /** How many recent turns the agent should focus on (informational —
   *  the agent reads the file directly; this is a hint about scope). */
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
  const lines = [`You are operating as a review sub-agent (${agentName}).`];
  if (ctx.instinctsDir !== undefined) {
    lines.push(`Instincts directory (preferred input): ${ctx.instinctsDir}`);
  }
  lines.push(
    `Primary file${ctx.instinctsDir !== undefined ? ' (fallback)' : ''}: ${ctx.primaryFile}`,
  );
  if (ctx.secondaryFile !== undefined) {
    lines.push(`Secondary file: ${ctx.secondaryFile}`);
  }
  lines.push(
    `Recent turn count to focus on: ${ctx.recentTurnCount}`,
    '',
    ctx.instinctsDir !== undefined
      ? 'When instincts are available, prefer them — they are pre-clustered, evidence-backed, and confidence-graduated. Use the primary/secondary files as fallback or to confirm specific evidence.'
      : 'Read the primary file and (when present) the secondary file, then file proposals via your allowed proposal tool. Be conservative.',
  );
  return lines.join('\n');
}

export async function runReviewFork(opts: RunReviewForkOpts): Promise<void> {
  // Augment the parent's pool with review-only tools so the scheduler's
  // filterToolsForChild can surface memory_propose / skill_propose for
  // review-* agents (whose allowedTools declare them).
  //
  // Phase 13.4 — also augment with LEARNING_ONLY_TOOLS so review forks
  // can call instinct_list / instinct_view (read-only). The
  // synthesizer-only writers in the same pool (instinct_propose,
  // instinct_update_confidence) are filtered out by the scheduler's
  // agent.allowedTools enforcement — review-* agents don't list them.
  const augmentedPool: Tool<unknown, unknown>[] = [
    ...opts.parentToolPool,
    ...REVIEW_ONLY_TOOLS,
    ...LEARNING_ONLY_TOOLS,
  ];

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
