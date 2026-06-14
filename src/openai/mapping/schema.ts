// Phase 18 T2 — Zod schemas for the OpenAI ChatCompletions request shape.
//
// The schema covers the subset of OpenAI's spec the harness consumes in v0:
// system/user/assistant/tool message roles, model, stream, max_tokens,
// temperature. Other fields (tools[], top_p, frequency_penalty, etc.) are
// allowed through `.passthrough()` so SDK clients that send richer payloads
// aren't rejected — they're simply ignored by the route.
//
// One quirk worth flagging: assistant messages may have `content: null`
// when tool_calls is the only payload (OpenAI's tool-only assistant message
// shape), so the schema accepts `string | null | undefined` for assistant
// content. The user message accepts `string | unknown[]` to allow OpenAI's
// multipart content arrays (image_url etc.) through validation — the
// non-string user content paths are not yet mapped (deferred) but the
// schema doesn't reject them.

import { z } from 'zod';

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

const SystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
});

const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(z.unknown())]),
});

const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
});

const ToolMessageSchema = z.object({
  role: z.literal('tool'),
  tool_call_id: z.string(),
  content: z.string(),
});

export const ChatMessageSchema = z.discriminatedUnion('role', [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** OpenAI's `stream_options` object. v0 honors only `include_usage`: when
 *  true the streaming branch emits a final usage chunk (choices: []) before
 *  [DONE], for parity with the non-streaming `usage` object (#38). Other
 *  keys pass through unused. */
const StreamOptionsSchema = z
  .object({
    include_usage: z.boolean().optional(),
  })
  .passthrough();

export const ChatRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(ChatMessageSchema).min(1),
    stream: z.boolean().optional().default(false),
    stream_options: StreamOptionsSchema.optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .passthrough();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
