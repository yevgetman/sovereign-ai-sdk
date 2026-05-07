// src/learning/synthesizer.ts
// Phase 13.4 — one-shot dispatch helper for the instinct-synthesizer
// sub-agent. Mirrors src/review/fork.ts but augments the parent's tool
// pool with LEARNING_ONLY_TOOLS so the child can call instinct_propose,
// instinct_update_confidence, instinct_list, instinct_view.
//
// Fire-and-forget — dispatch failures are routed to the trace recorder
// per Invariant #10 (learning loop is additive and non-blocking).

import type { SubagentScheduler } from '../runtime/scheduler.js';
import { LEARNING_ONLY_TOOLS } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';
import { observationsPath } from './paths.js';

export interface RunSynthesizerOpts {
  scheduler: SubagentScheduler;
  parentSessionId: string;
  parentSignal: AbortSignal;
  parentToolPool: Tool<unknown, unknown>[];
  parentToolContext: ToolContext;
  harnessHome: string;
  projectId: string;
  projectName: string;
  recentObservationCount: number;
  traceRecorder?: (event: TraceEvent) => void;
}

function buildPrompt(opts: RunSynthesizerOpts): string {
  return [
    'You are operating as the instinct-synthesizer sub-agent.',
    `Project: ${opts.projectName} (${opts.projectId})`,
    `Observations file: ${observationsPath(opts.harnessHome, opts.projectId)}`,
    `Recent observation count to focus on: ${opts.recentObservationCount}`,
    '',
    'Read recent observations, cluster them, and propose / reinforce / contradict instincts.',
    'Be conservative. Producing zero proposals is valid.',
  ].join('\n');
}

export async function runSynthesizer(opts: RunSynthesizerOpts): Promise<void> {
  const augmentedPool: Tool<unknown, unknown>[] = [
    ...opts.parentToolPool,
    ...LEARNING_ONLY_TOOLS,
  ];
  try {
    await opts.scheduler.delegate({
      agentName: 'instinct-synthesizer',
      prompt: buildPrompt(opts),
      parentSessionId: opts.parentSessionId,
      parentSignal: opts.parentSignal,
      parentToolPool: augmentedPool,
      parentToolContext: opts.parentToolContext,
      ...(opts.traceRecorder !== undefined ? { traceRecorder: opts.traceRecorder } : {}),
    });
  } catch (_err) {
    // Invariant #10 — silent on failure; route to trace recorder.
    try {
      opts.traceRecorder?.({
        type: 'session_end',
        reason: 'error',
        iso: new Date().toISOString(),
      } as never);
    } catch {
      // best-effort
    }
  }
}
