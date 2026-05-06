// Phase 13.3 — ReviewManager. Counter-driven trigger orchestrator that
// fire-and-forgets review-fork dispatches via SubagentScheduler. Triggers
// snapshot state and never block the parent's main turn.

import type { SubagentScheduler } from '../runtime/scheduler.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';
import { type ReviewAgentName, runReviewFork } from './fork.js';

export interface ReviewThresholds {
  userTurnsForMemoryReview: number;
  toolIterationsForSkillReview: number;
}

export interface ReviewPaths {
  trajectoryPath: string;
  tracePath: string;
}

export interface ChildCompletionEvent {
  childSessionId: string;
  taskId: string;
  traceId: string;
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
}

const DEFAULT_THRESHOLDS: ReviewThresholds = {
  userTurnsForMemoryReview: 10,
  toolIterationsForSkillReview: 50,
};

const DEFAULT_RECENT_TURN_COUNT = 10;

export class ReviewManager {
  private userTurnsSince = 0;
  private toolIterationsSince = 0;
  private readonly scheduler: SubagentScheduler;
  private readonly sessionId: string;
  private readonly signal: AbortSignal;
  private readonly thresholds: ReviewThresholds;
  private readonly pathsResolver: () => ReviewPaths;
  private readonly parentToolPool: Tool<unknown, unknown>[];
  private readonly parentToolContext: ToolContext;
  private readonly enabled: boolean;
  private readonly traceRecorder?: (event: TraceEvent) => void;

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
  }

  onUserTurn(): void {
    if (!this.enabled) return;
    this.userTurnsSince += 1;
    if (this.userTurnsSince >= this.thresholds.userTurnsForMemoryReview) {
      this.userTurnsSince = 0;
      this.dispatch('review-memory');
    }
  }

  onToolIteration(): void {
    if (!this.enabled) return;
    this.toolIterationsSince += 1;
    if (this.toolIterationsSince >= this.thresholds.toolIterationsForSkillReview) {
      this.toolIterationsSince = 0;
      this.dispatch('review-skill');
    }
  }

  onChildCompletion(_evt: ChildCompletionEvent): void {
    if (!this.enabled) return;
    this.dispatch('review-memory');
  }

  /** Dispatch a one-shot review pass for the given agent. Fire-and-forget. */
  private dispatch(agentName: ReviewAgentName): void {
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
        recentTurnCount: DEFAULT_RECENT_TURN_COUNT,
      },
      ...(this.traceRecorder !== undefined ? { traceRecorder: this.traceRecorder } : {}),
    });
  }
}
