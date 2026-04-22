// LLMProvider interface. Thin normalisation layer — internal shape is
// Anthropic-native (content blocks), providers translate in and out.
//
// Source of pattern: Claude Code src/providers/ (inferred — see
// harness-build-plan.md § 0.4).

import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
} from '../core/types.js';

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: unknown; // JSONSchema
};

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

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
};

export interface LLMProvider {
  readonly name: string;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage>;
}
