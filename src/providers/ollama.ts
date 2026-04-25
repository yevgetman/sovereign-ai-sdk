// Ollama chat transport. Uses /api/chat with streaming JSON lines and the
// same internal content-block contract as every other provider.

import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  SystemSegment,
} from '../core/types.js';
import { ProviderHttpError } from './errors.js';
import { messagesToOpenAI } from './openai.js';
import type { ProviderRequest, ToolSchema, Transport } from './types.js';

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    function: { name: string; arguments: unknown };
  }>;
};

type OllamaTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

type OllamaChatBody = {
  model: string;
  messages: OllamaMessage[];
  stream: true;
  tools?: OllamaTool[];
  options?: {
    temperature?: number;
    num_predict?: number;
  };
};

export type OllamaChatChunk = {
  message?: {
    content?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: unknown;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
};

type OllamaProviderConfig = {
  baseURL?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export class OllamaProvider
  implements Transport<OllamaMessage, OllamaTool, OllamaChatBody, OllamaChatChunk>
{
  readonly name = 'ollama';
  readonly apiMode = 'ollama';
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OllamaProviderConfig = {}) {
    this.baseURL = (config.baseURL ?? 'http://localhost:11434').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  toProviderMessages(messages: Message[], system: SystemSegment[] = []): OllamaMessage[] {
    return messagesToOpenAI(messages, system).map((message) => {
      if (!message.tool_calls) return message as OllamaMessage;
      const converted: OllamaMessage = {
        role: message.role,
        tool_calls: message.tool_calls.map((call) => ({
          function: {
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
          },
        })),
      };
      if (message.content !== undefined) converted.content = message.content;
      return converted;
    });
  }

  toProviderTools(tools?: ToolSchema[]): OllamaTool[] | undefined {
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

  buildKwargs(req: ProviderRequest): OllamaChatBody {
    const tools = this.toProviderTools(req.tools);
    return {
      model: req.model,
      messages: this.toProviderMessages(req.messages, req.system),
      stream: true,
      ...(tools !== undefined ? { tools } : {}),
      options: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        num_predict: req.maxTokens,
      },
    };
  }

  async *normalizeResponse(
    raw: AsyncIterable<OllamaChatChunk>,
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    return yield* translateOllamaStream(raw);
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const response = await this.fetchImpl(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers,
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
    if (!response.body) throw new Error('ollama returned no response body');

    return yield* this.normalizeResponse(parseJsonLines(response.body));
  }
}

export async function* translateOllamaStream(
  raw: AsyncIterable<OllamaChatChunk>,
): AsyncGenerator<StreamEvent, AssistantMessage> {
  yield { type: 'message_start' };
  const textParts: string[] = [];
  const toolCalls: ContentBlock[] = [];
  let stopReason: StopReason = 'end_turn';
  let toolCounter = 0;

  for await (const chunk of raw) {
    const content = chunk.message?.content;
    if (content) {
      textParts.push(content);
      yield { type: 'text_delta', text: content };
    }
    for (const call of chunk.message?.tool_calls ?? []) {
      const name = call.function?.name ?? 'unknown_tool';
      const input = call.function?.arguments ?? {};
      const id = `ollama_tool_${toolCounter++}`;
      toolCalls.push({ type: 'tool_use', id, name, input });
      yield { type: 'tool_use_delta', id, partial: JSON.stringify(input) };
    }
    if (chunk.done) stopReason = mapOllamaStopReason(chunk.done_reason, toolCalls.length > 0);
  }

  const content: ContentBlock[] = [];
  const text = textParts.join('');
  if (text.length > 0) content.push({ type: 'text', text });
  content.push(...toolCalls);
  const assistant: AssistantMessage = { role: 'assistant', content };
  yield { type: 'message_stop', stop_reason: stopReason };
  yield { type: 'assistant_message', message: assistant };
  return assistant;
}

async function* parseJsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<OllamaChatChunk> {
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
      if (trimmed.length > 0) yield JSON.parse(trimmed) as OllamaChatChunk;
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) yield JSON.parse(tail) as OllamaChatChunk;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function mapOllamaStopReason(reason: string | undefined, hasTools: boolean): StopReason {
  if (hasTools) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (!reason || reason === 'stop') return 'end_turn';
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
