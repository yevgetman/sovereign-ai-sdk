// Anthropic provider. Translates @anthropic-ai/sdk raw stream events into
// our internal StreamEvent shape. Accumulates content blocks during the
// stream and yields a final assistant_message event when the message stops;
// the generator's return value is the same AssistantMessage (belt-and-
// suspenders — callers can consume either).
//
// The translation logic is a pure function over an AsyncIterable of raw
// events so it can be unit-tested against a fixture without the SDK.
//
// Source of pattern: harness-build-plan.md § 1.

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  RawContentBlockStartEvent,
  RawMessageStreamEvent,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  SystemSegment,
} from '../core/types.js';
import type { LLMProvider, ProviderRequest, ToolSchema } from './types.js';

type WipBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'tool_use'; id: string; name: string; json: string };

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly apiKey: string;
  private readonly client: Anthropic;

  constructor(config: { apiKey: string; baseURL?: string }) {
    if (!config.apiKey) {
      throw new Error('AnthropicProvider requires apiKey');
    }
    this.apiKey = config.apiKey;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const system = systemToSdk(req.system);
    const messages = messagesToSdk(req.messages);
    const tools = req.tools ? toolsToSdk(req.tools) : undefined;

    const sdkStream = (await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(system !== undefined ? { system } : {}),
        messages,
        ...(tools !== undefined ? { tools } : {}),
        stream: true,
      },
      req.signal ? { signal: req.signal } : {},
    )) as unknown as AsyncIterable<RawMessageStreamEvent>;

    return yield* translateAnthropicStream(sdkStream);
  }
}

/**
 * Pure translation: consumes raw @anthropic-ai/sdk events, yields our
 * internal StreamEvent shape, and returns the accumulated AssistantMessage
 * when the stream ends.
 */
export async function* translateAnthropicStream(
  raw: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<StreamEvent, AssistantMessage> {
  const finalized: ContentBlock[] = [];
  const wip = new Map<number, WipBlock>();
  let stopReason: StopReason = 'end_turn';

  for await (const event of raw) {
    switch (event.type) {
      case 'message_start': {
        yield { type: 'message_start' };
        break;
      }
      case 'content_block_start': {
        const block = initWipFromStart(event);
        if (block) wip.set(event.index, block);
        break;
      }
      case 'content_block_delta': {
        const w = wip.get(event.index);
        if (!w) break;
        const d = event.delta;
        if (d.type === 'text_delta' && w.kind === 'text') {
          w.text += d.text;
          yield { type: 'text_delta', text: d.text };
        } else if (d.type === 'thinking_delta' && w.kind === 'thinking') {
          w.thinking += d.thinking;
          yield { type: 'thinking_delta', thinking: d.thinking };
        } else if (d.type === 'signature_delta' && w.kind === 'thinking') {
          w.signature += d.signature;
        } else if (d.type === 'input_json_delta' && w.kind === 'tool_use') {
          w.json += d.partial_json;
          yield { type: 'tool_use_delta', id: w.id, partial: d.partial_json };
        }
        // citations_delta intentionally ignored — not modelled yet.
        break;
      }
      case 'content_block_stop': {
        const w = wip.get(event.index);
        if (!w) break;
        finalized.push(finalizeBlock(w));
        wip.delete(event.index);
        break;
      }
      case 'message_delta': {
        const sr = event.delta.stop_reason;
        if (sr) stopReason = mapStopReason(sr);
        break;
      }
      case 'message_stop': {
        const assistant: AssistantMessage = { role: 'assistant', content: finalized };
        yield { type: 'message_stop', stop_reason: stopReason };
        yield { type: 'assistant_message', message: assistant };
        return assistant;
      }
    }
  }

  // Stream ended without explicit message_stop — emit what we have.
  const assistant: AssistantMessage = { role: 'assistant', content: finalized };
  yield { type: 'message_stop', stop_reason: stopReason };
  yield { type: 'assistant_message', message: assistant };
  return assistant;
}

function initWipFromStart(event: RawContentBlockStartEvent): WipBlock | null {
  const cb = event.content_block;
  if (cb.type === 'text') {
    return { kind: 'text', text: cb.text ?? '' };
  }
  if (cb.type === 'thinking') {
    return {
      kind: 'thinking',
      thinking: cb.thinking ?? '',
      signature: cb.signature ?? '',
    };
  }
  if (cb.type === 'tool_use') {
    return { kind: 'tool_use', id: cb.id, name: cb.name, json: '' };
  }
  // Other block kinds (server tools, web-search results, redacted thinking, etc.)
  // are not yet modelled in our internal shape. Phase 1 only exercises text.
  return null;
}

function finalizeBlock(w: WipBlock): ContentBlock {
  if (w.kind === 'text') return { type: 'text', text: w.text };
  if (w.kind === 'thinking') return { type: 'thinking', thinking: w.thinking };
  let input: unknown = {};
  try {
    input = w.json ? JSON.parse(w.json) : {};
  } catch {
    input = { __parse_error: w.json };
  }
  return { type: 'tool_use', id: w.id, name: w.name, input };
}

function mapStopReason(sr: string): StopReason {
  switch (sr) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return sr;
    default:
      return 'error';
  }
}

function systemToSdk(segments: SystemSegment[]): string | TextBlockParam[] | undefined {
  if (segments.length === 0) return undefined;
  if (!segments.some((s) => s.cacheable)) {
    return segments.map((s) => s.text).join('\n\n');
  }
  return segments.map(
    (s): TextBlockParam =>
      s.cacheable
        ? { type: 'text', text: s.text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: s.text },
  );
}

function messagesToSdk(messages: Message[]): MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(blockToSdk),
  }));
}

function blockToSdk(block: ContentBlock): ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking, signature: '' };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      };
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.source.media_type as
            | 'image/jpeg'
            | 'image/png'
            | 'image/gif'
            | 'image/webp',
          data: block.source.data,
        },
      };
  }
}

function toolsToSdk(tools: ToolSchema[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
}
