// src/learning/synthesizer.ts
// Phase 13.4 — one-shot dispatch helper for the instinct-synthesizer
// sub-agent. Mirrors src/review/fork.ts but augments the parent's tool
// pool with LEARNING_ONLY_TOOLS so the child can call instinct_propose,
// instinct_update_confidence, instinct_list, instinct_view.
//
// Fire-and-forget at the call site (callers `void` the promise), but the
// outcome is OBSERVABLE: the helper never throws into the user turn, yet
// returns a small status object AND logs a clear warning on failure
// (Task 14 — synthesis used to fail silently, which hid the most common
// reason the learning loop never closed). Logging uses the project's
// stderr `log` sink convention (mirrors disposeSessionContext /
// TraceWriter), not console.log.

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
  /** Sink for the fail-loud warning. Defaults to stderr. A test seam +
   *  the project's standard non-blocking logging channel (mirrors
   *  disposeSessionContext / TraceWriter). */
  log?: (message: string) => void;
}

/** Outcome of a synthesizer dispatch. Returned (never thrown) so callers
 *  and tests can assert on whether the pass actually ran. */
export type SynthesizerResult = { ok: true; summary: string } | { ok: false; reason: string };

function buildPrompt(opts: RunSynthesizerOpts): string {
  return [
    'You are operating as the instinct-synthesizer sub-agent.',
    `Project: ${opts.projectName} (${opts.projectId})`,
    `Observations file: ${observationsPath(opts.harnessHome, opts.projectId)}`,
    `Recent observation count to focus on: ${opts.recentObservationCount}`,
    '',
    'Read recent observations, cluster them, and propose / reinforce / contradict instincts.',
    'Propose an instinct for any pattern with at least 3 consistent supporting',
    'observations; state the trigger and action precisely. Do not invent patterns',
    'or propose from thin evidence.',
  ].join('\n');
}

export async function runSynthesizer(opts: RunSynthesizerOpts): Promise<SynthesizerResult> {
  const log = opts.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));
  const augmentedPool: Tool<unknown, unknown>[] = [...opts.parentToolPool, ...LEARNING_ONLY_TOOLS];
  try {
    const result = await opts.scheduler.delegate({
      agentName: 'instinct-synthesizer',
      prompt: buildPrompt(opts),
      parentSessionId: opts.parentSessionId,
      parentSignal: opts.parentSignal,
      parentToolPool: augmentedPool,
      parentToolContext: opts.parentToolContext,
      ...(opts.traceRecorder !== undefined ? { traceRecorder: opts.traceRecorder } : {}),
    });

    // A non-success terminal (error / interrupted / max_tokens) means the
    // pass did not run to completion. Surface it instead of treating any
    // returned result as a win.
    const reason = result.terminal.reason;
    if (reason !== 'completed' && reason !== 'max_turns') {
      const detail = `instinct-synthesizer did not complete (terminal: ${reason})`;
      log(`[synthesizer] ${detail} for ${opts.projectName} (${opts.projectId})`);
      return { ok: false, reason: detail };
    }
    return { ok: true, summary: result.summary };
  } catch (err) {
    // Non-blocking by contract — never re-throw into the user turn — but
    // fail LOUD: log a clear warning so a broken synthesis is diagnosable
    // rather than silently dropping the N → N+1 learning step.
    const reason = err instanceof Error ? err.message : String(err);
    log(`[synthesizer] dispatch failed for ${opts.projectName} (${opts.projectId}): ${reason}`);
    return { ok: false, reason };
  }
}
