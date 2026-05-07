// Phase 13.3 — ReviewManager. Counter-driven trigger orchestrator that
// fire-and-forgets review-fork dispatches via SubagentScheduler. Triggers
// snapshot state and never block the parent's main turn.

import { runSynthesizer } from '../learning/synthesizer.js';
import type { SubagentScheduler } from '../runtime/scheduler.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';
import { runConsolidation } from './consolidate.js';
import { type ReviewAgentName, runReviewFork } from './fork.js';

export interface ReviewThresholds {
  userTurnsForMemoryReview: number;
  toolIterationsForSkillReview: number;
  childReviewEveryN: number;
  /** Phase 13.3 (A3) — minimum milliseconds between two dispatches of
   *  the same review-fork agent. Auto-triggered dispatches respect this
   *  lockout; manual runConsolidationPass bypasses. */
  minIntervalMs: number;
  /** Phase 13.4 — synthesizer fires every Nth user turn. Default 20. */
  synthesizerEveryN: number;
}

export interface ReviewPaths {
  trajectoryPath: string;
  tracePath: string;
  /** Phase 13.4 — optional instinct corpus directory. Reviewer agents
   *  prefer it over raw trajectory slices when present. */
  instinctsDir?: string;
}

export interface ChildCompletionEvent {
  childSessionId: string;
  taskId: string;
  traceId: string;
  /** Phase 13.3+ throttle inputs — used by ReviewManager to skip trivial
   *  children that produced no learnable signal. */
  iterationsUsed?: number;
  toolCallCount?: number;
}

export interface ReviewManagerOpts {
  scheduler: SubagentScheduler;
  sessionId: string;
  signal: AbortSignal;
  thresholds?: Partial<ReviewThresholds>;
  pathsResolver: () => ReviewPaths;
  parentToolPool: Tool<unknown, unknown>[];
  parentToolContext: ToolContext;
  enabled?: boolean;
  traceRecorder?: (event: TraceEvent) => void;
  /** Phase 13.4 — stable per-project identity used to route the
   *  synthesizer at the right project's observations.jsonl. When
   *  absent, synthesizer dispatch is suppressed (e.g., harness running
   *  without a session-rooted project context). */
  projectIdentity?: () => { id: string; name: string };
  /** Phase 13.4 — root for learning artifacts (passed to the
   *  synthesizer to compute its observations path). Required alongside
   *  `projectIdentity` for the synthesizer to fire. */
  harnessHome?: string;
}

const DEFAULT_THRESHOLDS: ReviewThresholds = {
  userTurnsForMemoryReview: 10,
  toolIterationsForSkillReview: 50,
  childReviewEveryN: 3,
  minIntervalMs: 30_000, // 30s
  synthesizerEveryN: 20,
};

const TRIVIAL_MIN_ITERATIONS = 2;
const TRIVIAL_MIN_TOOL_CALLS = 1;

const DEFAULT_RECENT_TURN_COUNT = 10;

export class ReviewManager {
  private userTurnsSince = 0;
  private toolIterationsSince = 0;
  private childCompletionsSince = 0;
  /** Phase 13.4 — synthesizer turn counter; independent of memory review. */
  private synthesizerSince = 0;
  private lastDispatchAtMs: Map<ReviewAgentName, number> = new Map();
  /** Phase 13.3 (B3) — per-agent dispatch counts for the goodbye summary.
   *  Phase 13.4 — extended to include 'instinct-synthesizer'. */
  private dispatchCounts: Map<
    ReviewAgentName | 'review-consolidate' | 'instinct-synthesizer',
    number
  > = new Map();
  private readonly scheduler: SubagentScheduler;
  private readonly sessionId: string;
  private readonly signal: AbortSignal;
  private readonly thresholds: ReviewThresholds;
  private readonly pathsResolver: () => ReviewPaths;
  private readonly parentToolPool: Tool<unknown, unknown>[];
  private readonly parentToolContext: ToolContext;
  private readonly enabled: boolean;
  private readonly traceRecorder?: (event: TraceEvent) => void;
  private readonly projectIdentity?: () => { id: string; name: string };
  private readonly harnessHome?: string;

  constructor(opts: ReviewManagerOpts) {
    this.scheduler = opts.scheduler;
    this.sessionId = opts.sessionId;
    this.signal = opts.signal;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    this.pathsResolver = opts.pathsResolver;
    this.parentToolPool = opts.parentToolPool;
    this.parentToolContext = opts.parentToolContext;
    this.enabled = opts.enabled ?? true;
    if (opts.traceRecorder !== undefined) {
      this.traceRecorder = opts.traceRecorder;
    }
    if (opts.projectIdentity !== undefined) {
      this.projectIdentity = opts.projectIdentity;
    }
    if (opts.harnessHome !== undefined) {
      this.harnessHome = opts.harnessHome;
    }
  }

  onUserTurn(callerSessionId: string): void {
    if (!this.enabled) return;
    if (this.signal.aborted) return;
    if (callerSessionId !== this.sessionId) return;
    this.userTurnsSince += 1;
    if (this.userTurnsSince >= this.thresholds.userTurnsForMemoryReview) {
      this.userTurnsSince = 0;
      this.dispatch('review-memory');
    }

    // Phase 13.4 — synthesizer fires every Nth user turn (independent
    // of review-memory). Skipped when no projectIdentity / harnessHome
    // configured (e.g. the harness is running without a session-rooted
    // project context).
    this.synthesizerSince += 1;
    if (this.synthesizerSince >= this.thresholds.synthesizerEveryN) {
      this.synthesizerSince = 0;
      this.dispatchSynthesizer();
    }
  }

  onToolIteration(callerSessionId: string): void {
    if (!this.enabled) return;
    if (this.signal.aborted) return;
    if (callerSessionId !== this.sessionId) return;
    this.toolIterationsSince += 1;
    if (this.toolIterationsSince >= this.thresholds.toolIterationsForSkillReview) {
      this.toolIterationsSince = 0;
      this.dispatch('review-skill');
    }
  }

  onChildCompletion(evt: ChildCompletionEvent): void {
    if (!this.enabled) return;
    if (this.signal.aborted) return;

    // Trivial-skip: a child that produced almost nothing has no learnable
    // signal. Only kick in when caller provided both metrics; absent metrics
    // mean we fall through to the counter (back-compat for any caller that
    // doesn't yet thread them through).
    if (
      evt.iterationsUsed !== undefined &&
      evt.toolCallCount !== undefined &&
      (evt.iterationsUsed < TRIVIAL_MIN_ITERATIONS || evt.toolCallCount < TRIVIAL_MIN_TOOL_CALLS)
    ) {
      return;
    }

    // Counter throttle: only fire every Nth qualifying completion.
    this.childCompletionsSince += 1;
    if (this.childCompletionsSince >= this.thresholds.childReviewEveryN) {
      this.childCompletionsSince = 0;
      this.dispatch('review-memory');
    }
  }

  /** Fire-and-forget consolidation pass. Used by /review consolidate. */
  runConsolidationPass(harnessHome: string): void {
    if (!this.enabled) return;
    if (this.signal.aborted) return;
    this.dispatchCounts.set(
      'review-consolidate',
      (this.dispatchCounts.get('review-consolidate') ?? 0) + 1,
    );
    void runConsolidation({
      scheduler: this.scheduler,
      parentSessionId: this.sessionId,
      parentSignal: this.signal,
      harnessHome,
      parentToolPool: this.parentToolPool,
      parentToolContext: this.parentToolContext,
      ...(this.traceRecorder !== undefined ? { traceRecorder: this.traceRecorder } : {}),
    });
  }

  /** Phase 13.3 (B3) — session-end summary. Returns total dispatches and
   *  a per-agent breakdown for the goodbye card. */
  getDispatchSummary(): { totalDispatched: number; byAgent: Record<string, number> } {
    const byAgent: Record<string, number> = {};
    let totalDispatched = 0;
    for (const [agent, count] of this.dispatchCounts) {
      byAgent[agent] = count;
      totalDispatched += count;
    }
    return { totalDispatched, byAgent };
  }

  /** Dispatch a one-shot review pass for the given agent. Fire-and-forget. */
  private dispatch(agentName: ReviewAgentName): void {
    if (this.signal.aborted) return;
    // Phase 13.3 (A3) — temporal lockout. If we dispatched the same agent
    // type within minIntervalMs, skip silently. Prevents back-to-back
    // re-reads of nearly-identical trajectory content (e.g., two
    // AgentTool calls landing within seconds both triggering counter).
    const last = this.lastDispatchAtMs.get(agentName);
    if (last !== undefined && Date.now() - last < this.thresholds.minIntervalMs) {
      return;
    }
    this.lastDispatchAtMs.set(agentName, Date.now());
    this.dispatchCounts.set(agentName, (this.dispatchCounts.get(agentName) ?? 0) + 1);

    const paths = this.pathsResolver();
    void runReviewFork({
      scheduler: this.scheduler,
      agentName,
      parentSessionId: this.sessionId,
      parentSignal: this.signal,
      parentToolPool: this.parentToolPool,
      parentToolContext: this.parentToolContext,
      promptContext: {
        trajectoryPath: paths.trajectoryPath,
        tracePath: paths.tracePath,
        ...(paths.instinctsDir !== undefined ? { instinctsDir: paths.instinctsDir } : {}),
        recentTurnCount: DEFAULT_RECENT_TURN_COUNT,
      },
      ...(this.traceRecorder !== undefined ? { traceRecorder: this.traceRecorder } : {}),
    });
  }

  /** Phase 13.4 — fire-and-forget dispatch of the instinct-synthesizer
   *  sub-agent. Early-returns when project identity / harness home are
   *  absent (no learning context configured) or the signal is aborted. */
  private dispatchSynthesizer(): void {
    if (!this.projectIdentity || !this.harnessHome) return;
    if (this.signal.aborted) return;
    const project = this.projectIdentity();
    this.dispatchCounts.set(
      'instinct-synthesizer',
      (this.dispatchCounts.get('instinct-synthesizer') ?? 0) + 1,
    );
    void runSynthesizer({
      scheduler: this.scheduler,
      parentSessionId: this.sessionId,
      parentSignal: this.signal,
      parentToolPool: this.parentToolPool,
      parentToolContext: this.parentToolContext,
      harnessHome: this.harnessHome,
      projectId: project.id,
      projectName: project.name,
      recentObservationCount: 50,
      ...(this.traceRecorder !== undefined ? { traceRecorder: this.traceRecorder } : {}),
    });
  }
}
