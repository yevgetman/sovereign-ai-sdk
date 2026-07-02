// src/learning-layer/adapters/harness/reasonProvider.ts
// Adapter #1 Reason port — a thin prompt-in/text-out wrapper over the harness
// provider stream. SEAM ONLY (design decision D8): defined + tested now, not
// yet consumed by the synthesizer; that migration is deferred to a later phase.
import type { Message, SystemSegment } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import type { ReasonOptions, ReasonPort } from '../../ports.js';

/** Provider request requires a maxTokens; fall back to this when the caller
 *  does not specify one (reasoning summaries are short). */
const DEFAULT_MAX_TOKENS = 1024;

/** Wrap a harness LLMProvider as a Reason port. `complete(prompt, opts)` runs a
 *  single-user-message turn against `model` and returns the assistant's text. */
export function createProviderReason(provider: LLMProvider, model: string): ReasonPort {
  return {
    async complete(prompt: string, opts?: ReasonOptions): Promise<string> {
      const system: SystemSegment[] = opts?.system ? [{ text: opts.system, cacheable: false }] : [];
      const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
      const req: ProviderRequest = {
        model,
        system,
        messages,
        maxTokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      };
      const parts: string[] = [];
      for await (const event of provider.stream(req)) {
        if (event.type === 'text_delta') parts.push(event.text);
      }
      return parts.join('');
    },
  };
}
