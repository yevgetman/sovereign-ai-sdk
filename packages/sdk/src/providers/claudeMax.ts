import type { AssistantMessage, StreamEvent } from '../core/types.js';
import { ClaudeMaxTermsError } from './errors.js';
import { CLAUDE_MAX_TERMS_MESSAGE } from './subscription/claudeMaxTerms.js';
import type { LLMProvider, ProviderRequest } from './types.js';

/**
 * Claude Max is named so the fence can reject it. The consumer terms checked
 * on 2026-10-06 forbid this HTTP call, so `stream` fails before any request.
 */
export class ClaudeMaxSubscriptionProvider implements LLMProvider {
  readonly name = 'claude-max';

  // biome-ignore lint/correctness/useYield: refusal is the whole body
  async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    throw new ClaudeMaxTermsError(CLAUDE_MAX_TERMS_MESSAGE);
  }
}
