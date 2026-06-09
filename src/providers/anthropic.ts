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
  MessageDeltaUsage,
  MessageParam,
  RawContentBlockStartEvent,
  RawMessageStreamEvent,
  TextBlockParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  SystemSegment,
  TokenUsage,
} from '../core/types.js';
import { anthropicThinkingFor, modelSupportsReasoning } from './effort.js';
import { ProviderHttpError } from './errors.js';
import type { ProviderRequest, ToolSchema, Transport } from './types.js';

/** Beta flag that keeps reasoning persistent across tool-use turns. */
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

/**
 * Whether extended thinking applies to this request: an effort level is set,
 * it isn't `off`, and the model supports reasoning. Centralized so buildKwargs
 * (which sets the params) and stream (which attaches the interleaved beta
 * header) agree exactly.
 */
function thinkingApplies(req: ProviderRequest): boolean {
  return (
    req.effort !== undefined &&
    req.effort !== 'off' &&
    modelSupportsReasoning(req.model, 'anthropic')
  );
}

/**
 * Normalize a raw @anthropic-ai/sdk error into a ProviderHttpError so the
 * resolver's rate-guard + credential-pool feedback and preflight
 * classification — which all key on `instanceof ProviderHttpError` — fire for
 * Anthropic too (openai.ts / ollama.ts already throw ProviderHttpError; only
 * Anthropic let raw SDK errors propagate). APIError subclasses (RateLimitError,
 * AuthenticationError, BadRequestError, ...) carry a numeric `.status` and a
 * `Headers`-typed `.headers`. Connection/abort errors have no numeric status
 * and are left untouched so cancellation still propagates as-is. The original
 * message is preserved, so message-substring classifiers (context-overflow,
 * billing) keep working.
 */
export function normalizeAnthropicError(err: unknown): unknown {
  if (err instanceof ProviderHttpError) return err;
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return new ProviderHttpError('anthropic', err.status, err.message, err.headers ?? undefined);
  }
  return err;
}

type WipBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'tool_use'; id: string; name: string; json: string };

export class AnthropicProvider
  implements
    Transport<MessageParam, Anthropic.Tool, Anthropic.MessageCreateParams, RawMessageStreamEvent>
{
  readonly name = 'anthropic';
  readonly apiMode = 'anthropic';
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

  toProviderMessages(messages: Message[]): MessageParam[] {
    return messagesToSdk(messages);
  }

  toProviderTools(tools?: ToolSchema[]): Anthropic.Tool[] | undefined {
    return tools ? toolsToSdk(tools) : undefined;
  }

  buildKwargs(req: ProviderRequest): Anthropic.MessageCreateParams {
    const system = systemToSdk(req.system, req.cacheEnabled !== false);
    const tools = this.toProviderTools(req.tools);
    // Resolve thinking only when it applies; otherwise leave max_tokens and
    // temperature exactly as the caller set them (byte-identical request).
    const thinking =
      // narrows req.effort for the call below
      req.effort !== undefined && thinkingApplies(req)
        ? anthropicThinkingFor(req.effort, req.maxTokens)
        : undefined;
    return {
      model: req.model,
      max_tokens: thinking ? thinking.maxTokens : req.maxTokens,
      // The API rejects temperature≠1 when thinking is enabled, so omit it.
      ...(req.temperature !== undefined && !thinking?.dropTemperature
        ? { temperature: req.temperature }
        : {}),
      ...(thinking?.thinking !== undefined ? { thinking: thinking.thinking } : {}),
      ...(system !== undefined ? { system } : {}),
      messages: messagesToSdk(req.messages, req.cacheEnabled !== false),
      ...(tools !== undefined ? { tools } : {}),
      stream: true,
    };
  }

  async *normalizeResponse(
    raw: AsyncIterable<RawMessageStreamEvent>,
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    return yield* translateAnthropicStream(raw);
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    // Wrap both the create() call and stream iteration: normalize Anthropic
    // SDK errors into ProviderHttpError so the resolver hardening wrapper and
    // preflight can classify 429 / 401 / 403 like the other providers.
    try {
      // Attach the interleaved-thinking beta ONLY when thinking is on, so the
      // non-thinking request is sent byte-identically (no extra header). The
      // beta is delivered via the standard anthropic-beta request header rather
      // than the beta.* namespace, keeping the streaming pipeline unchanged.
      const options = {
        ...(req.signal ? { signal: req.signal } : {}),
        ...(thinkingApplies(req)
          ? { headers: { 'anthropic-beta': INTERLEAVED_THINKING_BETA } }
          : {}),
      };
      const sdkStream = (await this.client.messages.create(
        this.buildKwargs(req),
        options,
      )) as unknown as AsyncIterable<RawMessageStreamEvent>;

      return yield* this.normalizeResponse(sdkStream);
    } catch (err) {
      throw normalizeAnthropicError(err);
    }
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
        yield { type: 'usage_delta', usage: usageToInternal(event.message.usage) };
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
        yield { type: 'usage_delta', usage: usageToInternal(event.usage) };
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

function usageToInternal(usage: Partial<Usage | MessageDeltaUsage>): TokenUsage {
  return {
    ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.cache_creation_input_tokens === 'number'
      ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
      : {}),
    ...(typeof usage.cache_read_input_tokens === 'number'
      ? { cacheReadInputTokens: usage.cache_read_input_tokens }
      : {}),
  };
}

export function systemToSdk(
  segments: SystemSegment[],
  cacheEnabled = true,
): string | TextBlockParam[] | undefined {
  if (segments.length === 0) return undefined;
  const cacheBoundary = cacheEnabled ? findLastCacheableSegment(segments) : -1;
  if (cacheBoundary === -1) {
    return segments.map((s) => s.text).join('\n\n');
  }
  return segments.map(
    (s, index): TextBlockParam =>
      index === cacheBoundary
        ? { type: 'text', text: s.text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: s.text },
  );
}

function findLastCacheableSegment(segments: SystemSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.cacheable) return i;
  }
  return -1;
}

export function messagesToSdk(messages: Message[], cacheEnabled = true): MessageParam[] {
  const cacheFrom = Math.max(0, messages.length - 3);
  return messages.map((m, index) => ({
    role: m.role,
    content: withOptionalCacheMarker(m.content.map(blockToSdk), cacheEnabled && index >= cacheFrom),
  }));
}

function withOptionalCacheMarker(
  blocks: ContentBlockParam[],
  shouldCache: boolean,
): ContentBlockParam[] {
  if (!shouldCache || blocks.length === 0) return blocks;
  const marked = [...blocks];
  for (let i = marked.length - 1; i >= 0; i--) {
    const block = marked[i];
    if (!block || !isCacheableMessageBlock(block)) continue;
    marked[i] = { ...block, cache_control: { type: 'ephemeral' } } as ContentBlockParam;
    return marked;
  }
  return blocks;
}

function isCacheableMessageBlock(block: ContentBlockParam): boolean {
  return block.type === 'text' || block.type === 'tool_result';
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
