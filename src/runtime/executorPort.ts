// OPEN — the subscription-executor PORT contract.
//
// These types describe the CONTRACT the open `SubagentScheduler` consumes when a
// delegation is routed to a headless executor — independent of the PROPRIETARY
// `runSubprocessExecutor` (in `./subprocessExecutor.ts`) that satisfies it. The
// scheduler imports ONLY from here (no open→proprietary value crossing); the
// proprietary composition (`buildRuntime`) INJECTS the real implementation as
// the `RunSubprocessExecutor` port. The spawn/learning/trace helper types stay
// with the implementation; they're imported back here type-only (erased).

import type { SubscriptionExecutorConfig } from '../config/schema.js';
import type { AssistantMessage, Message, Terminal } from '../core/types.js';
import type { LearningSink, SpawnFn, TraceSink } from './subprocessExecutor.js';

export type RunSubprocessExecutorOpts = {
  /** The task prompt handed to `claude -p`. */
  prompt: string;
  /** Working directory the subprocess runs in — constrained to the runtime cwd
   *  by the caller (the scheduler). */
  cwd: string;
  config: SubscriptionExecutorConfig;
  /** Composed abort signal (parent signal ∧ per-child timeout) from the
   *  scheduler. When it fires, the subprocess is killed and an error terminal
   *  is returned. */
  signal?: AbortSignal;
  /** Injected for tests. Defaults to the real Bun.spawn wrapper. */
  spawn?: SpawnFn;
  /** OPTIONAL learning replay sink. When present, each `tool_use`/`tool_result`
   *  pair parsed from the subprocess stream is replayed as a `LearningObservation`
   *  so a delegated headless-Claude-Code turn feeds the learning loop exactly as
   *  a native delegation does. Absent (e.g. learning disabled) ⇒ clean no-op —
   *  the parser is byte-identical to the spike. */
  learningObserver?: LearningSink;
  /** OPTIONAL trace replay sink. When present, each replayed tool call records a
   *  `tool_start` + (`tool_end` | `tool_error`) bracket, mirroring the
   *  orchestrator's trace events. Absent ⇒ no-op. */
  traceRecorder?: TraceSink;
};

/** The exact shape SubagentScheduler.delegate() consumes from `drainRunner`. */
export type SubprocessExecutorResult = {
  terminal: Terminal;
  finalAssistant?: AssistantMessage;
  iterationsUsed: number;
  toolCallCount: number;
  distinctToolNames: string[];
  messages: Message[];
};

/** The INJECTED subscription-executor port. The proprietary
 *  `runSubprocessExecutor` satisfies this signature; the open scheduler depends
 *  ONLY on this type and the proprietary composition supplies the value. */
export type RunSubprocessExecutor = (
  opts: RunSubprocessExecutorOpts,
) => Promise<SubprocessExecutorResult>;
