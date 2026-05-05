// Phase 10.5 — operational trace events. Distinct from `src/trajectory/`
// (training-shaped session captures): traces are append-only JSONL records
// of what happened during a session, used for evals, replay, and `sov trace
// show`. Every variant carries a timestamp (`iso`) and a discriminator so
// the writer and viewer can be schema-driven.

import type { StopReason, Terminal, TokenUsage } from '../core/types.js';

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
      detector: 'consecutive-identical' | 'action-stagnation' | 'content-loop';
      repetitionCount: number;
      hash: string;
      iso: string;
    };

export type TraceEventType = TraceEvent['type'];
