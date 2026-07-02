// Phase 18 T2 — pure mapping: OpenAI ChatRequest → internal Message[].
//
// System messages lift into `extraSystemSegments` (the route appends them
// to the runtime's bootstrapped systemPrompt before driving query()). The
// remaining roles map onto Anthropic-style ContentBlock[] inside
// Message{role,content} pairs:
//
//   - user (string)        → Message{role:'user', content:[{text}]}
//   - assistant (text +/-  → Message{role:'assistant',
//     tool_calls)              content:[{text}?, ...{tool_use}]}
//   - tool                 → Message{role:'user',
//                                 content:[{tool_result, tool_use_id}]}
//
// Tool result blocks live in USER-role messages per Anthropic conventions
// (see src/core/types.ts — Message is a discriminated union of
// UserMessage | AssistantMessage; tool_result is only valid on the user
// side of the conversation).
//
// FIX 1 — Anthropic requires that ALL tool_result blocks answering one
// assistant turn live in the SINGLE user message immediately following it.
// OpenAI clients answer parallel tool_calls with one `tool` message per
// call, so the naive 1:1 mapping yields assistant[A,B] → user[result A] →
// user[result B], which upstream rejects with a 400 (wedging the
// conversation). After the per-message mapping we therefore (a) merge
// consecutive tool-result-only user messages into one and (b) run the
// repo's repairMissingToolResults() so any orphaned tool_use (e.g. a
// client replaying the harness's own streamed tool_calls without results)
// gets a synthetic result rather than a 400.

import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import type { ContentBlock, Message } from '@yevgetman/sov-sdk/core/types';
import type { ChatMessage, ChatRequest, ToolCall } from './schema.js';

export type RequestToMessagesResult = {
  messages: Message[];
  extraSystemSegments: string[];
};

export function requestToMessages(req: ChatRequest): RequestToMessagesResult {
  const messages: Message[] = [];
  const extraSystemSegments: string[] = [];

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      extraSystemSegments.push(msg.content);
      continue;
    }
    const mapped = mapNonSystemMessage(msg);
    messages.push(mapped);
  }

  // FIX 1 — collapse consecutive tool-result-only user messages (one per
  // OpenAI `tool` message) into a single user message, then synthesize
  // results for any orphaned tool_use so the sequence is Anthropic-valid.
  const merged = mergeConsecutiveToolResultMessages(messages);
  const { messages: repaired } = repairMissingToolResults(merged);

  return { messages: repaired, extraSystemSegments };
}

/** True iff every block in a user message is a tool_result. Such messages
 *  come from OpenAI `tool` role entries; consecutive runs of them answer
 *  one assistant turn's parallel tool_calls and MUST be merged into a
 *  single user message (Anthropic requires all results for an assistant
 *  turn in the immediately-next message). A user message carrying any text
 *  block is a real prompt turn and is left untouched. */
function isToolResultOnlyUser(msg: Message): boolean {
  return (
    msg.role === 'user' &&
    msg.content.length > 0 &&
    msg.content.every((block) => block.type === 'tool_result')
  );
}

/** Merge runs of consecutive tool-result-only user messages into one user
 *  message that concatenates their tool_result blocks, preserving order.
 *  Immutable: returns a fresh array; never mutates the input messages. */
function mergeConsecutiveToolResultMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      isToolResultOnlyUser(prev) &&
      isToolResultOnlyUser(msg) &&
      prev.role === 'user' &&
      msg.role === 'user'
    ) {
      out[out.length - 1] = { role: 'user', content: [...prev.content, ...msg.content] };
      continue;
    }
    out.push(msg);
  }
  return out;
}

function mapNonSystemMessage(msg: Exclude<ChatMessage, { role: 'system' }>): Message {
  if (msg.role === 'user') return mapUser(msg);
  if (msg.role === 'assistant') return mapAssistant(msg);
  return mapTool(msg);
}

function mapUser(msg: Extract<ChatMessage, { role: 'user' }>): Message {
  // T2 only maps string content. Multipart (image_url) content arrays are
  // permitted through the schema but not yet projected into ContentBlocks
  // — defer until the harness's tool surface needs image input. Fall back
  // to JSON-stringifying the array so the model still sees the structure.
  const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return { role: 'user', content: [{ type: 'text', text }] };
}

function mapAssistant(msg: Extract<ChatMessage, { role: 'assistant' }>): Message {
  const blocks: ContentBlock[] = [];
  // Text block (optional). OpenAI's `content: null` shape signals "no text;
  // only tool_calls" — skip the text block in that case so the resulting
  // Message doesn't carry a `{type:'text', text:''}` block downstream.
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content });
  }
  // Tool-use blocks. arguments is a JSON-serialized string per OpenAI's
  // spec; parse here so the internal tool_use block carries a typed input.
  // A malformed JSON string throws — callers should treat that as a 400.
  for (const call of msg.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call),
    });
  }
  return { role: 'assistant', content: blocks };
}

function mapTool(msg: Extract<ChatMessage, { role: 'tool' }>): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
  };
}

function parseToolArguments(call: ToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `tool_call ${call.id} has invalid JSON arguments for function ${call.function.name}: ${msg}`,
    );
  }
}
