// Core type definitions for the turn loop. One-way door — changing these
// after they're adopted is a cross-cutting refactor. Anthropic-style content
// blocks as canonical internal shape; providers translate at the boundary.
//
// Source of pattern: Claude Code (agent-harness-design-lessons.md § Lesson 1-6;
// harness-build-plan.md § 0.3).

export type Role = 'user' | 'assistant';

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

export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_delta'; id: string; partial: unknown }
  | { type: 'message_stop'; stop_reason: StopReason }
  | { type: 'assistant_message'; message: AssistantMessage };

export type Terminal = {
  reason: 'completed' | 'max_turns' | 'error' | 'interrupted';
  error?: Error;
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

export type QueryParams = {
  provider: import('../providers/types.js').LLMProvider;
  model: string;
  messages: Message[];
  systemPrompt: SystemSegment[];
  tools?: import('../tool/types.js').Tool<unknown, unknown>[];
  maxTokens: number;
  temperature?: number;
  /** Maximum recursion depth for sub-agents. Default 5. */
  maxTurns?: number;
  /** AbortSignal for interruption. */
  signal?: AbortSignal;
};
