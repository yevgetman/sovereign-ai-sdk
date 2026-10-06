// Core type definitions for the turn loop. One-way door — changing these
// after they're adopted is a cross-cutting refactor. Anthropic-style content
// blocks as canonical internal shape; providers translate at the boundary.
//
// Source of pattern: Claude Code (agent-harness-design-lessons.md § Lesson 1-6;
// harness-build-plan.md § 0.3).

import type { LoopMode, LoopOptions } from '../loop/options.js';
import type { RecallResult } from './recallPort.js';

export type Role = 'user' | 'assistant';

/** Per-turn recall thunk: bound by the host (sessionContext) to its learning
 *  layer + project id; `query()` stays project-agnostic and only invokes it. */
export type RecallTurn = (latestUserText: string | undefined) => Promise<RecallResult>;

export type ContentBlock =
  | { type: 'text'; text: string }
  // `signature` is the opaque token Anthropic returns alongside an extended-
  // thinking block; it must be replayed verbatim on the tool-use continuation
  // call (the API verifies it with interleaved thinking on). Optional so non-
  // Anthropic providers and pre-signature history stay valid.
  | { type: 'thinking'; thinking: string; signature?: string }
  // Anthropic-encrypted thinking. `data` is opaque and replayed verbatim on the
  // continuation call to preserve reasoning continuity across tool-use turns.
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

export type UserMessage = { role: 'user'; content: ContentBlock[] };
export type AssistantMessage = { role: 'assistant'; content: ContentBlock[] };
export type Message = UserMessage | AssistantMessage;

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** INFORMATIONAL SUBSET of `outputTokens`: the reasoning/thinking tokens a
   *  provider broke out separately (e.g. OpenAI `reasoning_tokens`). It is a
   *  slice already counted inside `outputTokens`, so it is NEVER added to cost
   *  math (cost = Σ of the four phase fields × price). The other four fields
   *  remain mutually DISJOINT and ADDITIVE; this fifth field overlaps output
   *  and exists only for classification/observability, not billing. */
  reasoningTokens?: number;
};

export type MicrocompactInfo = {
  cleared: number;
  estimatedTokensSaved: number;
  keptRecent: number;
};

export type LoopDetectionInfo = {
  detector: 'consecutive-identical' | 'no-progress' | 'content-loop';
  hash: string;
  repetitionCount: number;
  /** 1 = first detection, 2 = second, … The orchestrator escalates on it:
   *  in `enforce` mode, guidance while `occurrence < maxStrikes` and abort at
   *  `maxStrikes`; in `warn` mode it only ever guides. */
  occurrence: number;
  /** Human-readable, one sentence: what repeated, with counts. Carried into the
   *  guidance message and the abort error so a kill is explainable from the log
   *  (spec §3.7). */
  reason: string;
  /** What the orchestrator did about this detection. */
  action: 'guidance' | 'abort' | 'warn';
  /** The loop-guard policy in force for this session. */
  mode: LoopMode;
  /** no-progress only: the window size and how many of it were unproductive. */
  window?: { size: number; unproductive: number };
};

export type RouteDecisionInfo = {
  lane: 'local' | 'frontier';
  classifierLane: 'local' | 'frontier' | 'local-with-escalation';
  reason: string;
  /** Provider name the router delegated to for this turn. */
  delegatedProvider: string;
  /** Model name the router delegated to for this turn. */
  delegatedModel: string;
};

export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_delta'; id: string; partial: unknown }
  | { type: 'usage_delta'; usage: TokenUsage }
  | { type: 'message_stop'; stop_reason: StopReason }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'microcompact'; info: MicrocompactInfo }
  | { type: 'loop_detected'; info: LoopDetectionInfo }
  | { type: 'route_decision'; info: RouteDecisionInfo };

export type Terminal = {
  reason: 'completed' | 'max_tokens' | 'max_turns' | 'error' | 'interrupted' | 'checkin';
  error?: Error;
  /** Set when reason === 'checkin': cumulative tool calls in this user turn. */
  toolCallCount?: number;
};

/**
 * Cacheable segment of the system prompt. The provider translates these into
 * the provider-specific cache-control markers. On providers without caching,
 * segments are concatenated and the marker is ignored.
 */
export type SystemSegment = {
  text: string;
  cacheable: boolean;
};

/** Runtime inputs for one async-generator query loop. */
export type QueryParams = {
  provider: import('../providers/types.js').LLMProvider;
  model: string;
  messages: Message[];
  systemPrompt: SystemSegment[];
  tools?: import('../tool/types.js').Tool<unknown, unknown>[];
  /** Context passed to every tool invocation. Required when `tools` is set. */
  toolContext?: import('../tool/types.js').ToolContext;
  maxTokens: number;
  temperature?: number;
  /** Reasoning-depth level for extended thinking. Default 'off' (no thinking). */
  effort?: import('../providers/effort.js').ReasoningEffort;
  /** Maximum turns for tool-use continuation. Default 10. */
  maxTurns?: number;
  /** When set, the turn loop pauses after this many cumulative tool calls
   *  and returns terminal reason 'checkin'. The caller (REPL) surfaces a
   *  prompt and resumes via a follow-up query() call. Default unset. */
  maxToolCallsBeforeCheckin?: number;
  /** Progress-aware loop guard policy, consumed by query() to construct the
   *  loop detector. Absent ⇒ the detector's defaults (enforce mode, identical
   *  ≥ 4, no-progress window 8, 2 strikes) — byte-identical to a host that
   *  configures nothing. `HARNESS_LOOP_DETECTOR=off` still wins over any mode.
   *  Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §3.4/§3.6 */
  loop?: LoopOptions;
  /** AbortSignal for interruption. */
  signal?: AbortSignal;
  /** Permission decider invoked before every tool dispatch. When omitted,
   * tools run without gating (Phase 2 default; tests and bypass-mode REPL). */
  canUseTool?: import('../permissions/types.js').CanUseTool;
  /** Provider prompt-cache markers. Defaults to enabled; --no-cache disables. */
  cacheEnabled?: boolean;
  /** Optional bounded-memory manager; injects a fenced snapshot once per user turn. */
  memoryManager?: import('../memory/provider.js').MemoryRuntime;
  /** Optional per-turn recall thunk (learning loop). When set, runs after memory
   *  injection and prepends recalled lessons to the latest user message. The host
   *  binds the underlying RecallApi + projectId; query() stays project-agnostic. */
  recall?: RecallTurn;
  /** Optional mid-turn steering thunk. Polled at agent-loop boundaries (after
   *  each tool batch, and once when the model finishes without tool calls);
   *  returns ready-to-inject framed text, or null when nothing is pending.
   *  The host owns the transport (steer file, queue) and the framing; query()
   *  only merges the text into the conversation at a legal point: appended to
   *  the tool batch's user message pre-yield, or as a standalone user message
   *  at turn end (which CONTINUES the loop instead of finishing). */
  pollSteering?: () => Promise<string | null>;
  /** Microcompaction config. When enabled, stale tool results are cleared before
   *  they cause full compaction. Omit or set `enabled: false` to disable. */
  microcompactConfig?: import('../compact/microcompact.js').MicrocompactConfig;
  /** Lifecycle-event hook runner (Phase 11). Optional — when omitted, no
   *  PreToolUse/PostToolUse/UserPromptSubmit/Stop hooks fire. */
  hookRunner?: import('../hooks/types.js').HookRunner;
  /** Session id used for hook event payloads. Required when hookRunner is set. */
  sessionId?: string;
  /** cwd used for hook event payloads. Required when hookRunner is set; falls
   *  back to toolContext.cwd when both are present. */
  cwd?: string;
  /** Phase 10.5 — sink for operational trace events. When supplied, query.ts
   *  records turn_start / provider_request / provider_response / microcompact
   *  / interrupt; the orchestrator records permission_check / tool_start /
   *  tool_end / tool_error. Best-effort: a thrown handler is swallowed. */
  traceRecorder?: (event: import('../trace/types.js').TraceEvent) => void;
  /** Conduct Port (1b) — optional agent-behavior governance provider. Absent
   *  → null provider: byte-identical behavior. query() runs preGate (after
   *  the UserPromptSubmit rewrite; 'user' surface only) and triage (pre-model,
   *  fail-open); the composition seams live in createAgent. */
  conduct?: import('./conductPort.js').ConductProvider;
  /** Per-turn conduct context. Required for the seams to run — createAgent
   *  builds it; a bare query() caller may omit both. */
  conductCtx?: import('./conductPort.js').ConductContext;
  /** Gate-input capture (attestation evidence §3.4) — the bridge that hands
   *  createAgent the EXACT gateText preGate saw (post-rewrite,
   *  post-injection), for the once-per-turn ConductEvidenceEvent's `input`.
   *  Called only when preGate runs ("what the gate saw", nothing else) and
   *  BEFORE its verdict applies; an observer — a throw is swallowed and never
   *  breaks the turn. Absent ⇒ byte-identical (no capture). */
  onConductGateInput?: (finalUserText: string) => void;
  /**
   * Write the assistant tool call before tools run. Absent means no early
   * write. A throw stops the tool batch. The caller maps that throw to
   * `PersistBeforeRunError`.
   */
  persistBeforeTools?: (assistant: AssistantMessage) => Promise<void> | void;
};
