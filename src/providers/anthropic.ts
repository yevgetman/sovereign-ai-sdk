// Anthropic provider. Phase 0: stub that throws on use (just enough for
// type-checking and imports). Phase 1: implement stream() against
// @anthropic-ai/sdk, translate BetaRawMessageStreamEvent → StreamEvent.
//
// Source of pattern: harness-build-plan.md § 1.

import type { AssistantMessage, StreamEvent } from '../core/types.js';
import type { LLMProvider, ProviderRequest } from './types.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(private readonly config: { apiKey: string }) {
    if (!config.apiKey) {
      throw new Error('AnthropicProvider requires apiKey');
    }
  }

  // biome-ignore lint/correctness/useYield: Phase 0 stub; functional in Phase 1.
  async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    throw new Error(
      'AnthropicProvider.stream() not implemented in Phase 0 — see harness-build-plan.md § 1',
    );
  }
}
