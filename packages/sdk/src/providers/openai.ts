// OpenAI-compatible chat transport. Used for OpenAI proper and OpenRouter;
// both share the Chat Completions streaming/tool-call shape.

import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  SystemSegment,
} from '../core/types.js';
import {
  modelSupportsReasoning,
  openAiReasoningFor,
  openrouterModelSupportsPromptCaching,
  openrouterModelSupportsReasoning,
  openrouterReasoningFor,
} from './effort.js';
import { ProviderHttpError } from './errors.js';
import {
  findLastCacheableSegment,
  lastIndexWhere,
  recentMessageCacheBudget,
  recentMessageCacheFrom,
} from './promptCache.js';
import type { ApiMode, ProviderRequest, ToolChoice, ToolSchema, Transport } from './types.js';

/** A multimodal content part. Used ONLY when a message actually carries an
 *  image — a text-only message keeps the plain-string `content` it always had,
 *  because every lane on this transport (sov/vLLM, Ollama, OpenAI proper) shares
 *  this serialisation and some are strict about the shape. */
type OpenAIContentPart =
  | {
      type: 'text';
      /** Anthropic-style prompt-cache breakpoint. Emitted ONLY on the
       *  openrouter lane for a caching-gated model (see
       *  `OpenAIProvider.supportsPromptCaching`); OpenRouter forwards it to
       *  Anthropic verbatim. Every other lane omits the key entirely, keeping
       *  a byte-identical body. */
      text: string;
      cache_control?: { type: 'ephemeral' };
    }
  | { type: 'image_url'; image_url: { url: string } };

/** Per-call switches for `messagesToOpenAI`. Default (`{}`) reproduces the
 *  pre-2026-08-25 output byte-for-byte on every lane. */
export type MessagesToOpenAIOptions = {
  /** Place Anthropic-style `cache_control` breakpoints per the shared policy
   *  in `providers/promptCache.ts`. Off unless the caller's lane+model gate
   *  says the marker is meaningful. */
  promptCache?: boolean;
};

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};

type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAIChatBody = {
  model: string;
  messages: OpenAIMessage[];
  stream: true;
  /** Token cap for non-reasoning models. Mutually exclusive with
   *  `max_completion_tokens` — reasoning models (o1/o3/o4/gpt-5) reject this key. */
  max_tokens?: number;
  /** Token cap reasoning models require in place of `max_tokens`. */
  max_completion_tokens?: number;
  temperature?: number;
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  stream_options?: { include_usage: boolean };
  /** OpenAI reasoning-model effort dial (o1/o3/o4/gpt-5). */
  reasoning_effort?: string;
  /** OpenRouter's unified reasoning param (openrouter lane ONLY). Either the
   *  effort dial or the explicit `{ enabled: false }` disable that `off` sends. */
  reasoning?: { effort: 'low' | 'medium' | 'high' | 'max' } | { enabled: false };
  /** sov/vLLM chat-template flag that toggles the thinking channel. */
  chat_template_kwargs?: Record<string, unknown>;
};

export type OpenAIChatChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      // Chain-of-thought channel emitted by reasoning models (e.g. vLLM/SGLang
      // serving DeepSeek-R1-style models). Kept separate from `content` so it
      // surfaces as a `thinking` stream rather than contaminating the answer.
      reasoning_content?: string | null;
      // OpenRouter's normalized reasoning channel (Reasoning Tokens doc): the
      // same CoT stream under the unified API's field name. Read as a FALLBACK
      // to reasoning_content, never both (`??`).
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  // Present only on the final chunk when stream_options.include_usage is set.
  // That chunk carries an empty `choices` array, so usage must be read
  // independently of the per-choice loop. The two `*_details` objects are
  // OpenAI-only and may be entirely absent on local/older OpenAI-compatible
  // engines (vLLM/MLX) — treat them as optional + nullable-tolerant.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    // prompt_tokens INCLUDES cached_tokens (cache reads billed at a discount);
    // see the disjoint-phase subtraction where usage is emitted below.
    prompt_tokens_details?: {
      cached_tokens?: number | null;
      // OpenRouter: tokens WRITTEN to the cache this call (explicit-caching
      // models only; absent elsewhere). Maps to the cacheCreation phase.
      cache_write_tokens?: number | null;
    } | null;
    // reasoning_tokens is an informational SUBSET of completion_tokens.
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  };
};

type OpenAIProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  name?: string;
  fetchImpl?: typeof fetch;
};

export class OpenAIProvider
  implements Transport<OpenAIMessage, OpenAITool, OpenAIChatBody, OpenAIChatChunk>
{
  readonly name: string;
  readonly apiMode: ApiMode = 'openai';
  protected readonly baseURL: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(protected readonly config: OpenAIProviderConfig) {
    // The official OpenAI lane requires a key; keyless OpenAI-compatible
    // backends (e.g. the local `sov` engine) subclass this and relax the
    // gate by overriding `requiresApiKey()` + the default base URL.
    if (this.requiresApiKey() && !config.apiKey) throw new Error('OpenAIProvider requires apiKey');
    this.name = config.name ?? this.defaultName();
    this.baseURL = (config.baseURL ?? this.defaultBaseUrl()).replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Whether a missing apiKey is a hard error. Subclasses serving keyless
   *  loopback backends override to `false`. */
  protected requiresApiKey(): boolean {
    return true;
  }

  /** Provider name used when config.name is unset. */
  protected defaultName(): string {
    return 'openai';
  }

  /** Base URL used when config.baseURL is unset. */
  protected defaultBaseUrl(): string {
    return 'https://api.openai.com/v1';
  }

  /** Post-fetch hook for subclasses that read response metadata (e.g. a model
   *  router reporting the routed upstream in response headers). Called once per
   *  request after the ok-check, before SSE parsing. Default: no-op. */
  protected onResponse(_response: Response): void {}

  /** Request headers for the chat-completions call. The Authorization
   *  header is only attached when a key is present, so a keyless subclass
   *  transparently omits it. */
  protected requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  toProviderMessages(
    messages: Message[],
    system: SystemSegment[] = [],
    options: MessagesToOpenAIOptions = {},
  ): OpenAIMessage[] {
    return messagesToOpenAI(messages, system, options);
  }

  toProviderTools(tools?: ToolSchema[]): OpenAITool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  /** Whether reasoning/thinking is on for this request: an effort is set, it
   *  isn't `off`, and the model supports reasoning under this apiMode. Shared by
   *  buildKwargs (to set the wire params) and stream (to decide whether the sov
   *  `reasoning_content` channel is genuine CoT or the answer itself). */
  protected reasoningEnabled(req: ProviderRequest): boolean {
    return (
      req.effort !== undefined &&
      req.effort !== 'off' &&
      // The openrouter lane shares apiMode 'openai' but carries vendor/model
      // ids the openai regex never matches; it gets its own curated gate and
      // OpenRouter's unified `reasoning` param (buildKwargs below).
      (this.name === 'openrouter'
        ? openrouterModelSupportsReasoning(req.model)
        : modelSupportsReasoning(req.model, this.apiMode))
    );
  }

  /** Whether this request should carry Anthropic-style `cache_control`
   *  breakpoints: the openrouter lane, a model whose vendor needs explicit
   *  breakpoints, and caching not switched off by the host.
   *
   *  Same shape and same reason as `reasoningEnabled` above — the openrouter
   *  lane shares apiMode 'openai' but carries `vendor/model` ids and vendor
   *  behaviours the plain OpenAI path knows nothing about, so it gets its own
   *  curated gate in effort.ts rather than a regex scattered here.
   *
   *  Everything outside the gate — openai proper, sov, vLLM/SGLang, ollama,
   *  the router, and every non-Anthropic openrouter model — keeps a
   *  BYTE-IDENTICAL body (spec §2.4): several of those lanes are strict about
   *  message shape, and the implicitly-caching vendors gain nothing from a
   *  marker. `req.cacheEnabled === false` (the `--no-cache` flag, the preflight
   *  probe) suppresses it too, exactly as on the Anthropic transport. */
  protected supportsPromptCaching(req: ProviderRequest): boolean {
    return (
      this.name === 'openrouter' &&
      openrouterModelSupportsPromptCaching(req.model) &&
      req.cacheEnabled !== false
    );
  }

  /** The reasoning wire params for this request — `{}` means a byte-identical
   *  body (no reasoning key at all).
   *
   *  The openrouter lane is deliberately NOT gated on `reasoningEnabled()`: for a
   *  curated reasoning model it sends the unified param for EVERY defined effort,
   *  `off` included, because on that lane omitting the param is not a disable.
   *  Models that reason by default (z-ai/glm-5.x, DeepSeek R1, Qwen thinking)
   *  reason anyway when it's absent, and `low` is only advisory for those
   *  binary-thinking families — measured on glm-5.2 (2026-08-25): no param ⇒ 400
   *  reasoning tokens and no answer; `{ enabled: false }` ⇒ 0. Same precedent as
   *  the sov lane's `chat_template_kwargs.enable_thinking: false` below.
   *
   *  `req.effort === undefined` (the host never set one — legacy callers and the
   *  preflight probe) keeps the param omitted, byte-identical to before. Models
   *  outside the curated gate keep it omitted too. Every other lane (openai
   *  proper, sov, ollama, router) is unchanged: `reasoningEnabled()`-gated, so
   *  `off` there still just omits the dial (o-series/gpt-5 cannot be told not to
   *  reason — documented limit). */
  protected reasoningParams(req: ProviderRequest): Partial<OpenAIChatBody> {
    if (req.effort === undefined) return {};
    if (this.name === 'openrouter') {
      return openrouterModelSupportsReasoning(req.model) ? openrouterReasoningFor(req.effort) : {};
    }
    return this.reasoningEnabled(req) ? openAiReasoningFor(req.effort) : {};
  }

  buildKwargs(req: ProviderRequest): OpenAIChatBody {
    const tools = this.toProviderTools(req.tools);
    // "CoT is on" for this request: an effort is set, it isn't `off`, and the
    // model supports reasoning under this apiMode. Used for the sov chat-template
    // flag below; the wire reasoning params come from reasoningParams (which the
    // openrouter lane deliberately does NOT gate on this, so `off` can send an
    // explicit disable).
    const reasoningOn = this.reasoningEnabled(req);
    // OpenAI's hosted reasoning models (o1/o3/o4/gpt-5) reject `max_tokens` (they
    // require `max_completion_tokens`) and reject a non-default temperature —
    // ALWAYS, independent of whether reasoning_effort is set. So the token-cap
    // swap + temperature drop must be gated on the MODEL being a reasoning model
    // under the openai apiMode, NOT on reasoning being actively on. (Gating on
    // reasoningOn made `/effort off` — the default — send `max_tokens` +
    // temperature for a gpt-5/o3 model, which the API rejects, so preflight
    // failed and the session never booted.) This is OpenAI-specific: the `sov`
    // local engine (vLLM/MLX) is reasoning-capable but speaks standard
    // `max_tokens` + `enable_thinking`, so it keeps the normal body.
    const openAiReasoningModel =
      this.apiMode === 'openai' && modelSupportsReasoning(req.model, this.apiMode);
    return {
      model: req.model,
      messages: this.toProviderMessages(req.messages, req.system, {
        promptCache: this.supportsPromptCaching(req),
      }),
      stream: true,
      // Ask for a final usage chunk so token/cost accounting isn't silently
      // zero for openai/openrouter (the chat-completions stream omits usage by
      // default). Mirrors ollama's num_eval reporting.
      stream_options: { include_usage: true },
      ...(openAiReasoningModel
        ? { max_completion_tokens: req.maxTokens }
        : { max_tokens: req.maxTokens }),
      // Reasoning models reject temperature≠default; omit it (matches the
      // Anthropic thinking-on path).
      ...(req.temperature !== undefined && !openAiReasoningModel
        ? { temperature: req.temperature }
        : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(req.toolChoice !== undefined ? { tool_choice: mapToolChoice(req.toolChoice) } : {}),
      // The openrouter lane sends the unified `reasoning` param (OpenRouter
      // normalizes it per vendor) — the effort dial, or `{ enabled: false }` for
      // `off`; every other openai-mode lane keeps the OpenAI `reasoning_effort`
      // dial. See reasoningParams for why `off` differs by lane.
      ...this.reasoningParams(req),
      // The sov local engine (vLLM/MLX) toggles its thinking channel via the
      // chat-template flag. We ALWAYS send it for sov — `true` when reasoning is
      // on, `false` otherwise. Omitting it (the old behavior) let Qwen3's chat
      // template default thinking ON, so `/effort off` could never actually
      // disable reasoning: the model reasoned until it exhausted max_tokens and
      // never produced an answer. Sending `false` is what makes the off-switch
      // real. Only sov gets this key; openai/ollama keep a byte-identical
      // default-off body.
      ...(this.apiMode === 'sov' ? { chat_template_kwargs: { enable_thinking: reasoningOn } } : {}),
    };
  }

  async *normalizeResponse(
    raw: AsyncIterable<OpenAIChatChunk>,
    opts: TranslateOpts = {},
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    return yield* translateOpenAIStream(raw, opts);
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(this.buildKwargs(req)),
      ...(req.signal ? { signal: req.signal } : {}),
    });

    if (!response.ok) {
      throw new ProviderHttpError(
        this.name,
        response.status,
        await safeErrorText(response),
        response.headers,
      );
    }
    if (!response.body) throw new Error(`${this.name} returned no response body`);

    // Post-fetch metadata seam (default no-op). A model-router subclass reads
    // the routed-upstream response headers here, before SSE parsing begins.
    this.onResponse(response);

    // sov local lane with thinking OFF: the vLLM/MLX engine routes the whole
    // answer onto `reasoning_content` (with an empty `content`). Tell the
    // translator to treat that channel as the answer so it renders as the
    // assistant's response instead of dim "thinking". Only sov + thinking-off;
    // every other path keeps reasoning_content → thinking.
    const reasoningIsAnswer = this.apiMode === 'sov' && !this.reasoningEnabled(req);
    return yield* this.normalizeResponse(parseSse(response.body), { reasoningIsAnswer });
  }
}

/** Options for {@link translateOpenAIStream}. */
export type TranslateOpts = {
  /** When true, `reasoning_content` deltas are treated as ANSWER text
   *  (text_delta + text block) instead of thinking. Set for the sov local lane
   *  when thinking is disabled: the vLLM/MLX engine routes the whole answer onto
   *  the reasoning channel with an empty `content`, so without this the answer
   *  would render as dim "thinking" and no assistant response would appear.
   *  Default false preserves reasoning_content → thinking_delta everywhere else. */
  reasoningIsAnswer?: boolean;
};

export async function* translateOpenAIStream(
  raw: AsyncIterable<OpenAIChatChunk>,
  opts: TranslateOpts = {},
): AsyncGenerator<StreamEvent, AssistantMessage> {
  const reasoningIsAnswer = opts.reasoningIsAnswer === true;
  yield { type: 'message_start' };

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let stopReason: StopReason = 'end_turn';
  let lastUsage: OpenAIChatChunk['usage'];

  for await (const chunk of raw) {
    if (chunk.usage) lastUsage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    // reasoning_content (vLLM/SGLang) first, OpenRouter's `reasoning` as the
    // fallback — `??` so a lane emitting both never double-counts.
    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (reasoning) {
      if (reasoningIsAnswer) {
        // Local lane, thinking off: this channel carries the answer, not CoT.
        textParts.push(reasoning);
        yield { type: 'text_delta', text: reasoning };
      } else {
        reasoningParts.push(reasoning);
        yield { type: 'thinking_delta', thinking: reasoning };
      }
    }

    const content = choice.delta?.content;
    if (content) {
      textParts.push(content);
      yield { type: 'text_delta', text: content };
    }

    for (const call of choice.delta?.tool_calls ?? []) {
      const current = toolCalls.get(call.index) ?? {
        id: call.id ?? `tool_${call.index}`,
        name: '',
        args: '',
      };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name = call.function.name;
      if (call.function?.arguments) {
        current.args += call.function.arguments;
        yield { type: 'tool_use_delta', id: current.id, partial: call.function.arguments };
      }
      toolCalls.set(call.index, current);
    }

    if (choice.finish_reason) stopReason = mapOpenAIStopReason(choice.finish_reason);
  }

  const content: ContentBlock[] = [];
  const reasoning = reasoningParts.join('');
  // Thinking precedes text, matching the Anthropic block ordering.
  if (reasoning.length > 0) content.push({ type: 'thinking', thinking: reasoning });
  const text = textParts.join('');
  if (text.length > 0) content.push({ type: 'text', text });
  for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name || 'unknown_tool',
      input: parseToolArgs(call.args),
    });
  }

  if (lastUsage) {
    // OpenAI's `prompt_tokens` INCLUDES cached tokens, but our TokenUsage phase
    // fields must stay DISJOINT + ADDITIVE (Anthropic semantics: `inputTokens`
    // EXCLUDES cache reads; `estimateCostUsd` sums the phases × price). So map
    // `cached_tokens` to its own `cacheReadInputTokens` phase AND subtract it
    // from input. `reasoning_tokens` is an informational SUBSET of output — it
    // is surfaced but NOT subtracted from `outputTokens` (see the TokenUsage
    // doc comment). The `*_details` objects are absent on local/older engines
    // (vLLM/MLX), and a 0 count adds no field — both cases behave exactly as
    // before (byte-identical emission).
    const cachedTokens =
      typeof lastUsage.prompt_tokens_details?.cached_tokens === 'number'
        ? lastUsage.prompt_tokens_details.cached_tokens
        : 0;
    const reasoningTokens =
      typeof lastUsage.completion_tokens_details?.reasoning_tokens === 'number'
        ? lastUsage.completion_tokens_details.reasoning_tokens
        : 0;
    // OpenRouter's cache-write count (explicit-caching models only). A 0/absent
    // count adds no field — byte-identical emission for every other lane.
    const cacheWriteTokens =
      typeof lastUsage.prompt_tokens_details?.cache_write_tokens === 'number'
        ? lastUsage.prompt_tokens_details.cache_write_tokens
        : 0;
    yield {
      type: 'usage_delta',
      usage: {
        ...(typeof lastUsage.prompt_tokens === 'number'
          ? { inputTokens: lastUsage.prompt_tokens - cachedTokens }
          : {}),
        ...(typeof lastUsage.completion_tokens === 'number'
          ? { outputTokens: lastUsage.completion_tokens }
          : {}),
        ...(cachedTokens > 0 ? { cacheReadInputTokens: cachedTokens } : {}),
        ...(cacheWriteTokens > 0 ? { cacheCreationInputTokens: cacheWriteTokens } : {}),
        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      },
    };
  }

  const assistant: AssistantMessage = { role: 'assistant', content };
  yield { type: 'message_stop', stop_reason: stopReason };
  yield { type: 'assistant_message', message: assistant };
  return assistant;
}

export function messagesToOpenAI(
  messages: Message[],
  system: SystemSegment[] = [],
  options: MessagesToOpenAIOptions = {},
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const promptCache = options.promptCache === true;
  const systemMessage = systemToOpenAI(system, promptCache);
  if (systemMessage !== undefined) out.push(systemMessage);
  // Where each internal message's wire messages begin. One internal Message
  // can fan out to several wire messages (a user turn carrying N tool_results
  // becomes N `tool` messages plus maybe a `user` message), so "the last
  // cacheable wire message THIS message produced" is only answerable by
  // recording the runs as we build them — never by re-parsing the output.
  const runStarts: number[] = [];

  for (const message of messages) {
    runStarts.push(out.length);
    out.push(...(message.role === 'user' ? userToOpenAI(message) : assistantToOpenAI(message)));
  }

  if (!promptCache) return out;
  // A marked system message is emitted as content parts; a flat string means
  // no system breakpoint was spent (spec §2.2 item 2).
  const systemMarkers = Array.isArray(systemMessage?.content) ? 1 : 0;
  return withRecentMessageMarkers(out, runStarts, systemMarkers);
}

/**
 * The wire messages one internal USER message becomes: its `tool_result`
 * blocks as `tool` messages IN BLOCK ORDER, then — last — a single `user`
 * message carrying the turn's text and images, if it has either.
 *
 * That ordering is the pre-existing wire contract (a tool result must follow
 * the assistant turn that called for it, before any new user text), and it is
 * also what makes "mark the LAST cacheable wire message" land on the user's
 * own text rather than on a tool result when a turn carries both.
 */
function userToOpenAI(message: Message): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const textParts: string[] = [];
  // Images are collected separately: OpenAI-format vision is `image_url`
  // content parts, and a message only switches to the parts array when it
  // actually has one. Flattening them to "[image omitted]" is what made a
  // tool-rendered screenshot unreachable no matter what the tool returned.
  const images: OpenAIContentPart[] = [];
  for (const block of message.content) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'image') {
      images.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    } else if (block.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
    }
  }
  if (images.length > 0) {
    const text = textParts.join('\n\n');
    out.push({
      role: 'user',
      content: [...(text.length > 0 ? [{ type: 'text' as const, text }] : []), ...images],
    });
  } else if (textParts.length > 0) {
    out.push({ role: 'user', content: textParts.join('\n\n') });
  }
  return out;
}

/**
 * The single wire message one internal ASSISTANT message becomes: its text
 * joined, plus any `tool_use` blocks as `tool_calls`. A tool-calling turn with
 * no preamble sends `content: null` — the shape this transport has always sent
 * and the one several strict lanes expect. Always exactly one message, so the
 * array return is purely for a uniform call site.
 */
function assistantToOpenAI(message: Message): OpenAIMessage[] {
  const text = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  const toolCalls = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map(
      (b): OpenAIToolCall => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }),
    );
  if (toolCalls.length > 0) {
    return [{ role: 'assistant', content: text || null, tool_calls: toolCalls }];
  }
  return [{ role: 'assistant', content: text }];
}

/**
 * The wire messages with the recent-message breakpoints applied — the second
 * half of the shared policy (spec §2.2 item 3), and what lets a long
 * tool-calling turn cache its own growing history instead of only the system
 * prompt.
 *
 * Exactly ONE marker per internal message in the window, on the LAST cacheable
 * wire message that message produced — mirroring `withOptionalCacheMarker` on
 * the Anthropic lane, which marks the last cacheable BLOCK of the same
 * message. An internal message that produced nothing cacheable (an assistant
 * turn that is pure tool_calls, an image-only user turn) simply gets no
 * marker; a marker is never "borrowed" by an earlier message, because a
 * breakpoint further back caches strictly less.
 *
 * BUDGET: `systemMarkers` (≤1) + at most `RECENT_MESSAGE_CACHE_WINDOW` here,
 * capped by `recentMessageCacheBudget` so the total can never exceed
 * `MAX_CACHE_BREAKPOINTS` — Anthropic's hard per-request limit. The window is
 * walked NEWEST-FIRST so that if the budget ever binds (it cannot today:
 * 1 + 3 === 4) the markers that survive are the most recent, which is where
 * the next turn's cache hit comes from.
 *
 * Pure: `wire` and its messages are never mutated; marked messages are new
 * objects in a new array.
 */
function withRecentMessageMarkers(
  wire: OpenAIMessage[],
  runStarts: number[],
  systemMarkers: number,
): OpenAIMessage[] {
  const from = recentMessageCacheFrom(runStarts.length);
  let budget = recentMessageCacheBudget(systemMarkers);
  const marked = [...wire];
  for (let i = runStarts.length - 1; i >= from && budget > 0; i--) {
    const start = runStarts[i] ?? wire.length;
    const run = wire.slice(start, runStarts[i + 1] ?? wire.length);
    const offset = lastIndexWhere(run, isCacheableWireMessage);
    // Nothing this internal message produced can carry a marker (a pure
    // tool_calls turn, an image-only turn, a turn that emitted no wire message
    // at all): no marker, and no budget spent.
    if (offset === -1) continue;
    const target = run[offset];
    // Unreachable — `offset` came from this same array. Present only to narrow
    // the checked index access.
    if (target === undefined) continue;
    marked[start + offset] = markedWireMessage(target);
    budget -= 1;
  }
  return marked;
}

/**
 * Whether a wire message can carry a breakpoint. Mirrors
 * `isCacheableMessageBlock` on the Anthropic lane — text and tool_result only
 * — translated into this transport's shapes: a `tool` message IS a
 * tool_result, and a `user`/`assistant` message's text is its string content
 * or its `text` parts.
 *
 * ONE DELIBERATE DIVERGENCE from the Anthropic lane: emptiness. A marker rides
 * on a text part, and this lane must never invent an empty `{ text: '' }` part
 * to hang one on — so empty string content (an assistant turn that is pure
 * tool_calls, an empty tool result) is not cacheable here, where the Anthropic
 * lane would mark an empty text/tool_result block. Marking an empty block
 * caches nothing anyway; the divergence is in wire hygiene, not in policy.
 *
 * An `image_url` part is NEVER markable: `cache_control` on an image part is
 * not the shape Anthropic accepts, so an image-only user message is skipped.
 */
function isCacheableWireMessage(message: OpenAIMessage): boolean {
  if (message.role === 'system') return false;
  const { content } = message;
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return lastIndexWhere(content, isMarkableTextPart) !== -1;
}

function isMarkableTextPart(part: OpenAIContentPart): boolean {
  return part.type === 'text' && part.text.length > 0;
}

/**
 * A copy of `message` carrying the breakpoint. String content becomes a
 * one-element text-parts array — the shape live-verified against OpenRouter
 * for the system role in spec §1.2, and live-verified 2026-08-25 for the two
 * shapes this function adds (numbers recorded in CHANGELOG.md, harness
 * 0.6.72):
 *
 *   - a `tool`-role message with a parts array + `cache_control` — accepted,
 *     HTTP 200, cache write then a cache read of the same size;
 *   - an `assistant` message carrying BOTH a text-parts array and `tool_calls`
 *     — accepted, HTTP 200, 7,114-token cache write on request 1 and a
 *     7,114-token cache read on request 2, with four breakpoints in the
 *     request.
 *
 * Parts content — a user message carrying images — keeps its parts and marks
 * the LAST text one, never an `image_url`.
 */
function markedWireMessage(message: OpenAIMessage): OpenAIMessage {
  const { content } = message;
  if (typeof content === 'string') return { ...message, content: [markedTextPart(content)] };
  if (!Array.isArray(content)) return message;
  const boundary = lastIndexWhere(content, isMarkableTextPart);
  const part = content[boundary];
  // The `type !== 'text'` half is unreachable via isMarkableTextPart; it is
  // what narrows the union, and it keeps the marker off an image part even if
  // the predicate is ever loosened.
  if (part === undefined || part.type !== 'text') return message;
  const parts = [...content];
  parts[boundary] = markedTextPart(part.text);
  return { ...message, content: parts };
}

// Exported for direct unit testing of the malformed-line tolerance (deep
// internal subpath; not part of the frozen SDK barrel / semver surface).
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAIChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') return;
      if (payload.length === 0) continue;
      // A single malformed `data:` line from a non-conformant OpenAI-compatible
      // endpoint or proxy must NOT abort the whole turn with a raw SyntaxError
      // (this path serves openai/openrouter/sov). Skip the unparseable chunk and
      // keep streaming — mirrors the defensive parse in parseToolArgs below.
      let chunk: OpenAIChatChunk;
      try {
        chunk = JSON.parse(payload) as OpenAIChatChunk;
      } catch {
        continue;
      }
      yield chunk;
    }
  }
}

/**
 * The system wire message, or `undefined` when there is nothing to send.
 *
 * INVARIANT: the model sees the SAME system text either way — only the wire
 * SHAPE differs. Concatenating the emitted part texts reproduces the flat
 * string this transport has always sent, character for character. Caching must
 * never change the prompt: a different prompt is a different behaviour AND a
 * guaranteed cache miss.
 *
 * Default (and every non-caching lane): that flat trimmed string. A string
 * `content` cannot carry `cache_control`, and several lanes on this transport
 * are strict about message shape.
 *
 * With caching on and a cacheable segment present, it becomes AT MOST TWO
 * parts and exactly ONE breakpoint — the cacheable prefix (segments up to and
 * including the boundary) carrying the marker, then the volatile remainder.
 * Not one part per segment: extra parts buy nothing (the marker is what
 * matters) and multiply the ways the text can drift.
 *
 * Division of labour: WHICH segment is the boundary is the shared policy
 * (`findLastCacheableSegment` — the same call the Anthropic transport's
 * `systemToSdk` makes, so both lanes cut at the same segment for the same
 * input); HOW the parts are laid out around it is this lane's business.
 *
 * The empty case is decided on the FLATTENED text, before the caching branch,
 * so an all-whitespace system prompt is skipped identically whether or not
 * caching is on.
 */
function systemToOpenAI(system: SystemSegment[], promptCache: boolean): OpenAIMessage | undefined {
  const flat = flattenSystem(system);
  if (flat.length === 0) return undefined;
  const cacheBoundary = promptCache ? findLastCacheableSegment(system) : -1;
  if (cacheBoundary === -1) return { role: 'system', content: flat };
  const parts = systemCacheParts(system, cacheBoundary);
  // No markable prefix (everything up to the boundary is whitespace) ⇒ the
  // plain string, byte-identical to the caching-off path.
  if (parts === undefined) return { role: 'system', content: flat };
  return { role: 'system', content: parts };
}

/**
 * The 1-or-2 marked content parts for a system prompt cut at `cacheBoundary`,
 * or `undefined` when there is nothing worth marking.
 *
 * The trims are what preserve the text invariant: the flat form is the full
 * `\n\n` join TRIMMED, so the first part drops the join's leading whitespace
 * and the last part drops its trailing whitespace — concatenated, the parts
 * equal the flat string exactly. An empty or whitespace-only part is never
 * emitted (a bare `{ text: '' }` part is noise the marker cannot ride on, and
 * some upstreams reject it).
 */
function systemCacheParts(
  system: SystemSegment[],
  cacheBoundary: number,
): OpenAIContentPart[] | undefined {
  const cacheable = joinSegmentText(system.slice(0, cacheBoundary + 1)).trimStart();
  if (cacheable.length === 0) return undefined;
  // The separator belongs to the volatile part: it sits INSIDE the cached
  // prefix's boundary otherwise, and the prefix must end exactly where the
  // cache does.
  const volatileTail = `\n\n${joinSegmentText(system.slice(cacheBoundary + 1))}`.trimEnd();
  if (volatileTail.length === 0) return [markedTextPart(cacheable.trimEnd())];
  return [markedTextPart(cacheable), { type: 'text', text: volatileTail }];
}

function markedTextPart(text: string): OpenAIContentPart {
  return { type: 'text', text, cache_control: { type: 'ephemeral' } };
}

function joinSegmentText(segments: SystemSegment[]): string {
  return segments.map((s) => s.text).join('\n\n');
}

function flattenSystem(system: SystemSegment[]): string {
  return joinSegmentText(system).trim();
}

function parseToolArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __parse_error: raw };
  }
}

function mapToolChoice(
  choice: ToolChoice,
): 'auto' | 'required' | { type: 'function'; function: { name: string } } {
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  return { type: 'function', function: { name: choice.name } };
}

function mapOpenAIStopReason(reason: string): StopReason {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'stop') return 'end_turn';
  return 'error';
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}
