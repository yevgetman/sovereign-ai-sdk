// Phase 10.5 — operational trace events. Distinct from `src/trajectory/`
// (training-shaped session captures): traces are append-only JSONL records
// of what happened during a session, used for evals, replay, and `sov trace
// show`. Every variant carries a timestamp (`iso`) and a discriminator so
// the writer and viewer can be schema-driven.

import type { StopReason, Terminal, TokenUsage } from '../core/types.js';
import type { LoopMode } from '../loop/options.js';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export type TraceEvent =
  | {
      type: 'session_start';
      sessionId: string;
      provider: string;
      model: string;
      cwd: string;
      bundlePath?: string;
      iso: string;
    }
  | { type: 'turn_start'; turn: number; iso: string }
  | {
      type: 'provider_request';
      provider: string;
      model: string;
      /** 'main' = the user-facing turn loop; 'compact' = auxiliary
       *  summarizer that compacts older turns. */
      purpose: 'main' | 'compact';
      messageCount: number;
      systemBytes: number;
      /** Effective request limits and provenance, distinct from publisher maxima. */
      modelLimits?: import('../providers/modelLimits.js').EffectiveModelLimits;
      iso: string;
    }
  | {
      type: 'provider_response';
      provider: string;
      model: string;
      purpose: 'main' | 'compact';
      usage: TokenUsage;
      latencyMs: number;
      ttftMs?: number;
      stopReason: StopReason;
      iso: string;
    }
  | {
      type: 'permission_check';
      tool: string;
      decision: PermissionDecision;
      reason?: string;
      /** True when permissions normalized the input (per-rule
       *  `updatedInput`). Helps spot rules that silently rewrite input. */
      transformed: boolean;
      iso: string;
    }
  | { type: 'tool_start'; tool: string; toolUseId: string; iso: string }
  | {
      type: 'tool_end';
      /** The rendered result is an in-band failure. Absent on legacy traces. */
      isError?: boolean;
      tool: string;
      toolUseId: string;
      durationMs: number;
      outputBytes: number;
      iso: string;
    }
  | {
      type: 'tool_error';
      tool: string;
      toolUseId: string;
      durationMs: number;
      message: string;
      iso: string;
    }
  | {
      type: 'microcompact';
      cleared: number;
      estimatedTokensSaved: number;
      keptRecent: number;
      iso: string;
    }
  | { type: 'compaction_start'; parentSessionId: string; iso: string }
  | {
      type: 'compaction_end';
      parentSessionId: string;
      childSessionId: string;
      tokensSaved: number;
      iso: string;
    }
  | { type: 'memory_write'; path: string; bytes: number; iso: string }
  | { type: 'skill_write'; name: string; path: string; iso: string }
  | { type: 'interrupt'; stage: string; iso: string }
  | { type: 'session_end'; reason: Terminal['reason']; iso: string }
  | {
      type: 'loop_detected';
      detector: 'consecutive-identical' | 'no-progress' | 'content-loop';
      repetitionCount: number;
      hash: string;
      /** Human-readable, one sentence: what repeated, with counts (spec §3.7). */
      reason: string;
      /** What the orchestrator did about it. */
      action: 'guidance' | 'abort' | 'warn';
      /** The loop-guard policy in force for this session. */
      mode: LoopMode;
      /** no-progress only: window size and how many of it were unproductive. */
      window?: { size: number; unproductive: number };
      iso: string;
    }
  /** The loop guard is advisory infrastructure: any throw inside the detector
   *  is caught, recorded here, and treated as "no detection" for that turn
   *  (spec §3.8). Its presence in a trace means the guard was blind, not that
   *  the turn failed. */
  | { type: 'loop_detector_error'; message: string; iso: string }
  | {
      type: 'stall_detected';
      /** Human-readable description of why stall was diagnosed. */
      reason: string;
      /** Turn index (0-based) at which the stall was detected. */
      turn: number;
      iso: string;
    }
  | {
      /** An event produced by a third-party tool (e.g. a governance engine),
       *  adapted into the SDK's trace. `source` names the producer; `payload`
       *  is the producer's own event, opaque to the SDK. This is the SDK's
       *  general inlet for external observability — vendor-neutral by design. */
      type: 'external';
      source: string;
      payload: unknown;
      iso: string;
    };

export type TraceEventType = TraceEvent['type'];
