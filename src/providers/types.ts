// Provider interfaces. The core harness talks to LLMProvider.stream();
// concrete transports additionally expose translation hooks so provider-
// specific message/tool/response quirks stay quarantined under src/providers/.
//
// Source of pattern: Claude Code src/providers/ (inferred — see
// harness-build-plan.md § 0.4).

import type { AssistantMessage, Message, StreamEvent, SystemSegment } from '../core/types.js';

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: unknown; // JSONSchema
};

export type ToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };

export type ProviderRequest = {
  model: string;
  system: SystemSegment[];
  messages: Message[];
  tools?: ToolSchema[];
  toolChoice?: ToolChoice;
  maxTokens: number;
  temperature?: number;
  thinking?: { budgetTokens?: number };
  signal?: AbortSignal;
  cacheEnabled?: boolean;
};

export interface LLMProvider {
  readonly name: string;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage>;
}

export type ApiMode = 'anthropic' | 'openai' | 'ollama';

export type AuthType = 'api_key' | 'oauth' | 'bedrock_sig_v4' | 'none';

export interface Transport<
  ProviderMessage = unknown,
  ProviderTool = unknown,
  ProviderKwargs = unknown,
  RawResponse = unknown,
> extends LLMProvider {
  readonly apiMode: ApiMode;
  toProviderMessages(messages: Message[], system?: SystemSegment[]): ProviderMessage[];
  toProviderTools(tools?: ToolSchema[]): ProviderTool[] | undefined;
  buildKwargs(req: ProviderRequest): ProviderKwargs;
  normalizeResponse(raw: AsyncIterable<RawResponse>): AsyncGenerator<StreamEvent, AssistantMessage>;
}
