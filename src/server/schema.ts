// SSE event schemas + types for the Phase 16.1 HTTP server.
// Single source of truth for what the server may emit on /sessions/:id/events.
// The Go TUI mirrors these shapes in packages/tui/internal/transport/types.go.

import { z } from 'zod';

const BaseEvent = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
});

export const TextDeltaEvent = BaseEvent.extend({
  type: z.literal('text_delta'),
  block: z.number().int().nonnegative(),
  text: z.string(),
});

export const ThinkingDeltaEvent = BaseEvent.extend({
  type: z.literal('thinking_delta'),
  block: z.number().int().nonnegative(),
  text: z.string(),
});

export const ToolUseStartEvent = BaseEvent.extend({
  type: z.literal('tool_use_start'),
  block: z.number().int().nonnegative(),
  tool: z.string(),
  inputPartial: z.unknown().optional(),
});

export const ToolUseInputDeltaEvent = BaseEvent.extend({
  type: z.literal('tool_use_input_delta'),
  block: z.number().int().nonnegative(),
  delta: z.string(),
});

export const ToolUseDoneEvent = BaseEvent.extend({
  type: z.literal('tool_use_done'),
  block: z.number().int().nonnegative(),
  input: z.unknown(),
});

export const ToolResultEvent = BaseEvent.extend({
  type: z.literal('tool_result'),
  block: z.number().int().nonnegative(),
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  renderHint: z.string(),
  language: z.string().optional(),
});

export const PermissionRequestEvent = BaseEvent.extend({
  type: z.literal('permission_request'),
  requestId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  reason: z.string().optional(),
});

export const StatusUpdateEvent = BaseEvent.extend({
  type: z.literal('status_update'),
  cost: z.number().optional(),
  tokensIn: z.number().int().optional(),
  tokensOut: z.number().int().optional(),
  cacheHitRate: z.number().optional(),
  streaming: z.boolean().optional(),
});

export const TurnCompleteEvent = BaseEvent.extend({
  type: z.literal('turn_complete'),
  finishReason: z.string(),
  usage: z
    .object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
      cache_creation_input_tokens: z.number().int().optional(),
      cache_read_input_tokens: z.number().int().optional(),
    })
    .optional(),
});

export const TurnErrorEvent = BaseEvent.extend({
  type: z.literal('turn_error'),
  error: z.string(),
  recoverable: z.boolean(),
});

export const SessionResumedEvent = BaseEvent.extend({
  type: z.literal('session_resumed'),
  resumedFromSeq: z.number().int().nonnegative(),
});

// M6 T3 — proactive (and, in T4, overflow-recovery) compaction surface.
// `sessionId` is the parent — the id the SSE subscriber connected to.
// `activeSessionId` is the new child id; the TUI must pivot subsequent
// POSTs (turns, approvals) onto it for the rest of the conversation.
// Token estimates expose the compaction's effect for footer / status
// rendering without forcing the TUI to recompute them.
export const CompactionCompleteEvent = BaseEvent.extend({
  type: z.literal('compaction_complete'),
  activeSessionId: z.string(),
  summary: z.string(),
  estimatedBeforeTokens: z.number().int().nonnegative(),
  estimatedAfterTokens: z.number().int().nonnegative(),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolUseStartEvent,
  ToolUseInputDeltaEvent,
  ToolUseDoneEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  StatusUpdateEvent,
  TurnCompleteEvent,
  TurnErrorEvent,
  SessionResumedEvent,
  CompactionCompleteEvent,
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;

export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const obj: unknown = JSON.parse(raw);
    return ServerEventSchema.parse(obj);
  } catch {
    return null;
  }
}
