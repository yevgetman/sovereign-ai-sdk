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
import { ProviderHttpError } from './errors.js';
import type { ProviderRequest, ToolChoice, ToolSchema, Transport } from './types.js';

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
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
  max_tokens: number;
  temperature?: number;
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  stream_options?: { include_usage: boolean };
};

export type OpenAIChatChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      // Chain-of-thought channel emitted by reasoning models (e.g. vLLM/SGLang
      // serving DeepSeek-R1-style models). Kept separate from `content` so it
      // surfaces as a `thinking` stream rather than contaminating the answer.
      reasoning_content?: string | null;
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
  // independently of the per-choice loop.
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

type OpenAIProviderConfig = {
  apiKey: string;
  baseURL?: string;
  name?: string;
  fetchImpl?: typeof fetch;
};

export class OpenAIProvider
  implements Transport<OpenAIMessage, OpenAITool, OpenAIChatBody, OpenAIChatChunk>
{
  readonly name: string;
  readonly apiMode = 'openai';
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenAIProviderConfig) {
    if (!config.apiKey) throw new Error('OpenAIProvider requires apiKey');
    this.name = config.name ?? 'openai';
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  toProviderMessages(messages: Message[], system: SystemSegment[] = []): OpenAIMessage[] {
    return messagesToOpenAI(messages, system);
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

  buildKwargs(req: ProviderRequest): OpenAIChatBody {
    const tools = this.toProviderTools(req.tools);
    return {
      model: req.model,
      messages: this.toProviderMessages(req.messages, req.system),
      stream: true,
      // Ask for a final usage chunk so token/cost accounting isn't silently
      // zero for openai/openrouter (the chat-completions stream omits usage by
      // default). Mirrors ollama's num_eval reporting.
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(req.toolChoice !== undefined ? { tool_choice: mapToolChoice(req.toolChoice) } : {}),
    };
  }

  async *normalizeResponse(
    raw: AsyncIterable<OpenAIChatChunk>,
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    return yield* translateOpenAIStream(raw);
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
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

    return yield* this.normalizeResponse(parseSse(response.body));
  }
}

export async function* translateOpenAIStream(
  raw: AsyncIterable<OpenAIChatChunk>,
): AsyncGenerator<StreamEvent, AssistantMessage> {
  yield { type: 'message_start' };

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let stopReason: StopReason = 'end_turn';
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

  for await (const chunk of raw) {
    if (chunk.usage) lastUsage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const reasoning = choice.delta?.reasoning_content;
    if (reasoning) {
      reasoningParts.push(reasoning);
      yield { type: 'thinking_delta', thinking: reasoning };
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
    yield {
      type: 'usage_delta',
      usage: {
        ...(typeof lastUsage.prompt_tokens === 'number'
          ? { inputTokens: lastUsage.prompt_tokens }
          : {}),
        ...(typeof lastUsage.completion_tokens === 'number'
          ? { outputTokens: lastUsage.completion_tokens }
          : {}),
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
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const systemText = flattenSystem(system);
  if (systemText.length > 0) out.push({ role: 'system', content: systemText });

  for (const message of messages) {
    if (message.role === 'user') {
      const textParts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'image')
          textParts.push(`[image omitted: ${block.source.media_type}]`);
        else if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
      }
      if (textParts.length > 0) out.push({ role: 'user', content: textParts.join('\n\n') });
      continue;
    }

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
      out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
    } else {
      out.push({ role: 'assistant', content: text });
    }
  }

  return out;
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAIChatChunk> {
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
      if (payload.length > 0) yield JSON.parse(payload) as OpenAIChatChunk;
    }
  }
}

function flattenSystem(system: SystemSegment[]): string {
  return system
    .map((s) => s.text)
    .join('\n\n')
    .trim();
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
