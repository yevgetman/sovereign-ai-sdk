// Provider interfaces. The core harness talks to LLMProvider.stream();
// concrete transports additionally expose translation hooks so provider-
// specific message/tool/response quirks stay quarantined under src/providers/.
//
// Source of pattern: Claude Code src/providers/ (inferred — see
// harness-build-plan.md § 0.4).

import type { AssistantMessage, Message, StreamEvent, SystemSegment } from '../core/types.js';
import type { ReasoningEffort } from './effort.js';

/** Provider-neutral JSON-schema-ish tool description published to model APIs. */
export type ToolSchema = {
  name: string;
  description: string;
  input_schema: unknown; // JSONSchema
};

/** Provider-neutral request for automatic, forced-any, or named-tool selection. */
export type ToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };

/** Internal provider request; adapters translate this to provider wire formats. */
export type ProviderRequest = {
  model: string;
  system: SystemSegment[];
  messages: Message[];
  tools?: ToolSchema[];
  toolChoice?: ToolChoice;
  maxTokens: number;
  temperature?: number;
  /**
   * Reasoning-depth level. When set and not `off`, the adapter attaches the
   * provider-specific thinking/reasoning parameters (subject to the model's
   * reasoning capability). Absent or `off` ⇒ a byte-identical request.
   */
  effort?: ReasoningEffort;
  signal?: AbortSignal;
  cacheEnabled?: boolean;
};

/** Minimal interface the core turn loop needs from any model provider. */
export interface LLMProvider {
  readonly name: string;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage>;
}

export type ApiMode = 'anthropic' | 'openai' | 'ollama' | 'sov';

export type AuthType = 'api_key' | 'oauth' | 'bedrock_sig_v4' | 'none';

/** Optional richer adapter contract for providers with explicit translation hooks. */
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
