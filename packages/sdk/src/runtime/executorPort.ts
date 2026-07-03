// OPEN — the subscription-executor PORT contract.
//
// These types describe the CONTRACT the open `SubagentScheduler` consumes when a
// delegation is routed to a headless executor — independent of the PROPRIETARY
// `runSubprocessExecutor` (in `./subprocessExecutor.ts`) that satisfies it. The
// scheduler imports ONLY from here (no open→proprietary value crossing); the
// proprietary composition (`buildRuntime`) INJECTS the real implementation as
// the `RunSubprocessExecutor` port. The spawn/learning/trace helper types are
// the port's own dependency types, so they live HERE on the open port; the
// proprietary implementation re-exports them for its existing importers.

import type { SubscriptionExecutorConfig } from '../config/schema.js';
import type { ObserveInput } from '../core/observePort.js';
import type { AssistantMessage, Message, Terminal } from '../core/types.js';
import type { TraceEvent } from '../trace/types.js';

/** The minimal subprocess handle surface the executor needs. Bun.spawn's
 *  return value structurally satisfies it; tests inject a fake. Lives here on
 *  the open PORT (not the proprietary implementation) so the port's own
 *  dependency types are self-contained — the impl re-exports them. */
export type SpawnedProc = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: { write: (data: string | Uint8Array) => number; end: () => void };
  exited: Promise<number>;
  kill: (signal?: number) => void;
  /** The signal name the child died on (e.g. `'SIGKILL'`, `'SIGTERM'`), or
   *  `null` when it exited normally. Populated by the time `exited` resolves.
   *  Additive/optional so existing fakes and Bun.spawn's return value still
   *  satisfy the port. Lets callers (GrepTool) tell a signal kill from a
   *  genuine exit code instead of inferring it — a killed search must never be
   *  reported as an authoritative "no matches". */
  signalCode?: NodeJS.Signals | null;
};

export type SpawnOpts = {
  cwd: string;
  signal?: AbortSignal;
};

/** Injectable spawn fn. Defaults to a thin Bun.spawn wrapper; tests pass a
 *  fake that emits canned JSONL on stdout. */
export type SpawnFn = (argv: string[], opts: SpawnOpts) => SpawnedProc;

/** The minimal learning sink the executor needs — structurally satisfied by
 *  `LearningObserver` (its `observe(input)` method). The replay constructs an
 *  `ObserveInput` per tool call IDENTICAL in shape to what the orchestrator
 *  builds in `src/core/orchestrator.ts`, so the synthesizer can't tell a
 *  replayed observation from a native one. `ObserveInput` is the open
 *  observe-port type. */
export type LearningSink = { observe: (input: ObserveInput) => void };

/** The minimal trace sink the executor needs — a `(event) => void` recorder.
 *  The scheduler passes its `wrappedTraceRecorder` (the closure that tags the
 *  event with the child sessionId and forks to BOTH the parent recorder and the
 *  child's per-session TraceWriter), so replayed tool brackets land in the same
 *  destination(s) a native child's would. */
export type TraceSink = (event: TraceEvent) => void;

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
