// Responses wire shared by the two explicitly selected subscription backends.
// No account/provider fallback. A truncated or failed response is never success.
import type { AssistantMessage, ContentBlock, StreamEvent, TokenUsage } from '../core/types.js';
import { type ReasoningEffort, mapMaxEffort } from './effort.js';
import { ContextOverflowError, ProviderHttpError } from './errors.js';
import { RouteError } from './routes/errors.js';
import type { ProviderRequest, ToolSchema } from './types.js';

export function codexReasoning(effort?: ReasoningEffort): { effort: string; summary: string } {
  if (effort === 'off')
    throw new RouteError('effort_unsupported', 'ChatGPT subscription does not support off effort');
  return { effort: mapMaxEffort(effort ?? 'low', 'xhigh'), summary: 'auto' };
}

export function responsesTools(tools?: ToolSchema[]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));
}

export function responsesInput(
  req: ProviderRequest,
  options: { replayEncryptedReasoning?: boolean } = {},
): unknown[] {
  const items: unknown[] = [];
  for (const message of req.messages) {
    let content: unknown[] = [];
    const flush = () => {
      if (content.length) items.push({ type: 'message', role: message.role, content });
      content = [];
    };
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          content.push({
            type: message.role === 'user' ? 'input_text' : 'output_text',
            text: block.text,
          });
          break;
        case 'image':
          if (message.role !== 'user')
            throw new ProviderHttpError('subscription', 400, 'unsupported_input');
          content.push({
            type: 'input_image',
            image_url: `data:${block.source.media_type};base64,${block.source.data}`,
          });
          break;
        case 'tool_use':
          flush();
          items.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
          break;
        case 'tool_result':
          flush();
          items.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: block.content,
          });
          break;
        case 'encrypted_reasoning': {
          if (message.role !== 'assistant' || options.replayEncryptedReasoning !== true) {
            throw new RouteError(
              'unsupported_input',
              'encrypted reasoning history cannot be replayed on this route',
            );
          }
          if (block.encryptedContent.length === 0) {
            throw new RouteError(
              'unsupported_input',
              'encrypted reasoning history cannot be replayed on this route',
            );
          }
          flush();
          const replayed: Record<string, unknown> = {
            type: 'reasoning',
            encrypted_content: block.encryptedContent,
          };
          if (block.id !== undefined) replayed.id = block.id;
          if (block.status !== undefined) replayed.status = block.status;
          items.push(replayed);
          break;
        }
        // Thinking is internal provider state, not a user instruction or a
        // reusable encrypted reasoning item on another backend.
        case 'thinking':
          if (block.signature)
            throw new RouteError(
              'unsupported_input',
              'signed reasoning history cannot be replayed on this route',
            );
          break;
        case 'redacted_thinking':
          throw new RouteError(
            'unsupported_input',
            'encrypted reasoning history cannot be replayed on this route',
          );
      }
    }
    flush();
  }
  return items;
}

type EncryptedReasoningBlock = Extract<ContentBlock, { type: 'encrypted_reasoning' }>;

/** Copy server ciphertext. Ignore empty values and summary text. */
function encryptedReasoningBlock(
  item: Record<string, unknown> | undefined,
): EncryptedReasoningBlock | undefined {
  if (!item || item.type !== 'reasoning') return undefined;
  if (typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0)
    return undefined;
  const block: EncryptedReasoningBlock = {
    type: 'encrypted_reasoning',
    encryptedContent: item.encrypted_content,
  };
  if (typeof item.id === 'string' && item.id.length > 0) block.id = item.id;
  if (typeof item.status === 'string' && item.status.length > 0) block.status = item.status;
  return block;
}

function rememberReasoning(
  blocks: EncryptedReasoningBlock[],
  seen: Set<string>,
  block: EncryptedReasoningBlock | undefined,
): void {
  if (!block) return;
  if (block.id) {
    if (seen.has(block.id)) return;
    seen.add(block.id);
  }
  blocks.push(block);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function* responseEvents(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('subscription backend returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const lineEvent = (line: string): Record<string, unknown> | undefined => {
    if (!line.startsWith('data:')) return undefined;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('invalid subscription event');
    }
    const event = object(parsed);
    if (!event) throw new Error('invalid subscription event');
    return event;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 8 * 1024 * 1024) throw new Error('subscription event exceeds limit');
      let boundary = pending.indexOf('\n');
      while (boundary >= 0) {
        const line = pending.slice(0, boundary).replace(/\r$/, '');
        pending = pending.slice(boundary + 1);
        const event = lineEvent(line);
        if (event) yield event;
        boundary = pending.indexOf('\n');
      }
      if (chunk.done) {
        if (pending.trim()) {
          const event = lineEvent(pending);
          if (event) yield event;
        }
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* translateResponsesSse(
  response: Response,
  provider: string,
): AsyncGenerator<StreamEvent, AssistantMessage> {
  yield { type: 'message_start' };
  const content: ContentBlock[] = [];
  const streamedReasoning: EncryptedReasoningBlock[] = [];
  const streamedReasoningIds = new Set<string>();
  let placedReasoning = false;
  const toolIds = new Set<string>();
  const pendingCalls = new Set<string>();
  let text = '';
  let complete = false;
  let usage: TokenUsage | undefined;
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
  for await (const event of responseEvents(response)) {
    if (complete) throw new Error('subscription emitted data after terminal response');
    const addedItem = object(event.item);
    if (
      event.type === 'response.output_item.added' &&
      addedItem?.type === 'function_call' &&
      typeof addedItem.id === 'string'
    )
      pendingCalls.add(addedItem.id);
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
      yield { type: 'text_delta', text: event.delta };
    } else if (
      event.type === 'response.reasoning_summary_text.delta' &&
      typeof event.delta === 'string'
    ) {
      yield { type: 'thinking_delta', thinking: event.delta };
    } else if (event.type === 'response.output_item.done') {
      const item = object(event.item);
      if (item?.type === 'function_call') {
        if (
          typeof item.call_id !== 'string' ||
          !item.call_id ||
          typeof item.name !== 'string' ||
          !item.name ||
          typeof item.arguments !== 'string'
        )
          throw new Error('invalid subscription tool call');
        if (toolIds.has(item.call_id)) throw new Error('duplicate subscription tool call');
        let input: unknown;
        try {
          input = JSON.parse(item.arguments);
        } catch {
          throw new Error('invalid subscription tool arguments');
        }
        if (!object(input)) throw new Error('invalid subscription tool arguments');
        if (typeof item.id === 'string') pendingCalls.delete(item.id);
        toolIds.add(item.call_id);
        content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
        yield { type: 'tool_use_delta', id: item.call_id, partial: input };
      } else if (item?.type === 'reasoning') {
        rememberReasoning(streamedReasoning, streamedReasoningIds, encryptedReasoningBlock(item));
      }
    } else if (event.type === 'response.failed' || event.type === 'error') {
      const row = object(event.response);
      const error = object(event.error) ?? object(row?.error) ?? event;
      const code = typeof error.code === 'string' ? error.code : '';
      if (/context|too_many_tokens/i.test(code)) throw new ContextOverflowError(provider);
      if (/model/i.test(code))
        throw new RouteError('model_unsupported', 'Selected subscription model is unsupported');
      if (/rate_limit/i.test(code)) throw new ProviderHttpError(provider, 429, 'rate_limited');
      throw new ProviderHttpError(provider, 502, 'subscription response failed');
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const row = object(event.response);
      if (
        !row ||
        (row.status !== undefined &&
          row.status !== (event.type === 'response.completed' ? 'completed' : 'incomplete'))
      )
        throw new Error('invalid subscription terminal response');
      if (event.type === 'response.incomplete') {
        const reason = object(row?.incomplete_details)?.reason;
        if (reason !== 'max_output_tokens')
          throw new ProviderHttpError(provider, 502, 'subscription response incomplete');
        stopReason = 'max_tokens';
      }
      if (event.type === 'response.incomplete' && (pendingCalls.size || toolIds.size)) {
        throw new ProviderHttpError(provider, 502, 'subscription tool response incomplete');
      }
      if (Array.isArray(row?.output)) {
        let fallbackText = '';
        const sequence: ContentBlock[] = [];
        let pendingText = '';
        const flushPending = () => {
          if (!pendingText) return;
          sequence.push({ type: 'text', text: pendingText });
          pendingText = '';
        };
        const terminalReasoningIds = new Set<string>();
        for (const rawItem of row.output) {
          const item = object(rawItem);
          if (item?.type === 'message' && Array.isArray(item.content)) {
            let messageText = '';
            for (const rawBlock of item.content) {
              const block = object(rawBlock);
              if (block?.type === 'output_text' && typeof block.text === 'string')
                messageText += block.text;
            }
            fallbackText += messageText;
            if (messageText) {
              flushPending();
              pendingText = messageText;
            }
          } else if (item?.type === 'function_call') {
            if (event.type === 'response.incomplete')
              throw new ProviderHttpError(provider, 502, 'subscription tool response incomplete');
            if (
              typeof item.call_id !== 'string' ||
              !item.call_id ||
              typeof item.name !== 'string' ||
              !item.name ||
              typeof item.arguments !== 'string'
            )
              throw new Error('invalid subscription tool call');
            let input: unknown;
            try {
              input = JSON.parse(item.arguments);
            } catch {
              throw new Error('invalid subscription tool arguments');
            }
            if (!object(input)) throw new Error('invalid subscription tool arguments');
            if (typeof item.id === 'string') pendingCalls.delete(item.id);
            const existing = content.find(
              (block) => block.type === 'tool_use' && block.id === item.call_id,
            );
            if (existing) {
              if (
                existing.type !== 'tool_use' ||
                existing.name !== item.name ||
                JSON.stringify(existing.input) !== JSON.stringify(input)
              )
                throw new Error('inconsistent subscription tool call');
            } else {
              toolIds.add(item.call_id);
              content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
              yield { type: 'tool_use_delta', id: item.call_id, partial: input };
            }
            flushPending();
            sequence.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
          } else if (item?.type === 'reasoning') {
            const reasoning = encryptedReasoningBlock(item);
            if (reasoning && !(reasoning.id && terminalReasoningIds.has(reasoning.id))) {
              if (reasoning.id) terminalReasoningIds.add(reasoning.id);
              flushPending();
              sequence.push(reasoning);
            }
          }
        }
        flushPending();
        if (!text && fallbackText) {
          text = fallbackText;
          yield { type: 'text_delta', text };
        } else if (fallbackText && fallbackText !== text)
          throw new Error('inconsistent subscription text');
        if (sequence.some((block) => block.type === 'encrypted_reasoning')) {
          for (const block of streamedReasoning) {
            if (block.id && terminalReasoningIds.has(block.id)) continue;
            if (
              block.id === undefined &&
              sequence.some(
                (entry) =>
                  entry.type === 'encrypted_reasoning' &&
                  entry.encryptedContent === block.encryptedContent &&
                  entry.id === undefined,
              )
            )
              continue;
            sequence.push(block);
          }
          for (const block of content) {
            if (
              block.type === 'tool_use' &&
              !sequence.some((entry) => entry.type === 'tool_use' && entry.id === block.id)
            )
              sequence.push(block);
          }
          if (text && !sequence.some((block) => block.type === 'text'))
            sequence.unshift({ type: 'text', text });
          content.splice(0, content.length, ...sequence);
          placedReasoning = true;
        }
      }
      if (pendingCalls.size) throw new Error('subscription response has unfinished tool calls');
      const rawUsage = object(row?.usage);
      if (rawUsage) {
        usage = {};
        if (typeof rawUsage.input_tokens === 'number' && rawUsage.input_tokens >= 0)
          usage.inputTokens = rawUsage.input_tokens;
        if (typeof rawUsage.output_tokens === 'number' && rawUsage.output_tokens >= 0)
          usage.outputTokens = rawUsage.output_tokens;
        const cached = object(rawUsage.input_tokens_details)?.cached_tokens;
        if (typeof cached === 'number' && cached >= 0) usage.cacheReadInputTokens = cached;
      }
      complete = true;
    }
  }
  if (!complete) throw new Error('subscription stream ended without a terminal response');
  if (usage) yield { type: 'usage_delta', usage };
  if (!placedReasoning) {
    if (text) content.unshift({ type: 'text', text });
    if (streamedReasoning.length) {
      const toolAt = content.findIndex((block) => block.type === 'tool_use');
      content.splice(toolAt === -1 ? content.length : toolAt, 0, ...streamedReasoning);
    }
  }
  if (toolIds.size && stopReason === 'end_turn') stopReason = 'tool_use';
  const message: AssistantMessage = { role: 'assistant', content };
  yield { type: 'message_stop', stop_reason: stopReason };
  yield { type: 'assistant_message', message };
  return message;
}
