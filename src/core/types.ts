// Core type definitions for the turn loop. One-way door — changing these
// after they're adopted is a cross-cutting refactor. Anthropic-style content
// blocks as canonical internal shape; providers translate at the boundary.
//
// Source of pattern: Claude Code (agent-harness-design-lessons.md § Lesson 1-6;
// harness-build-plan.md § 0.3).

import type { RecallResult } from '../learning-layer/ports.js';

export type Role = 'user' | 'assistant';

/** Per-turn recall thunk: bound by the host (sessionContext) to its learning
 *  layer + project id; `query()` stays project-agnostic and only invokes it. */
export type RecallTurn = (latestUserText: string | undefined) => Promise<RecallResult>;

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
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
};

export type MicrocompactInfo = {
  cleared: number;
  estimatedTokensSaved: number;
  keptRecent: number;
};

export type LoopDetectionInfo = {
  detector: 'consecutive-identical' | 'action-stagnation' | 'content-loop';
  hash: string;
  repetitionCount: number;
  /** 1 = first detection (orchestrator injects guidance and continues),
   *  2 = second detection (orchestrator breaks the loop). */
  occurrence: number;
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
  /** Maximum turns for tool-use continuation. Default 10. */
  maxTurns?: number;
  /** When set, the turn loop pauses after this many cumulative tool calls
   *  and returns terminal reason 'checkin'. The caller (REPL) surfaces a
   *  prompt and resumes via a follow-up query() call. Default unset. */
  maxToolCallsBeforeCheckin?: number;
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
};
