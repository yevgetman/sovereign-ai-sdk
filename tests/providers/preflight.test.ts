// Provider preflight tests. Uses fake providers so no live API is required.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import { ProviderHttpError } from '../../src/providers/errors.js';
import {
  classifyProviderPreflightError,
  preflightProvider,
} from '../../src/providers/preflight.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';

function provider(
  fn: (req: ProviderRequest) => AsyncGenerator<StreamEvent, AssistantMessage>,
): LLMProvider {
  return { name: 'fake', stream: fn };
}

describe('preflightProvider', () => {
  test('drains a cheap provider request successfully', async () => {
    let seen: ProviderRequest | undefined;
    const ok = provider(async function* (req) {
      seen = req;
      yield { type: 'message_start' };
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
      };
      yield { type: 'assistant_message', message: assistant };
      return assistant;
    });

    const result = await preflightProvider({
      provider: ok,
      providerName: 'fake',
      model: 'fake-model',
    });

    expect(result.ok).toBe(true);
    expect(seen?.maxTokens).toBe(8);
    expect(seen?.tools).toBeUndefined();
    expect(seen?.cacheEnabled).toBe(false);
  });

  test('classifies low-credit provider errors as billing failures', () => {
    const result = classifyProviderPreflightError(
      'anthropic',
      'claude-sonnet-4-6',
      new ProviderHttpError(
        'anthropic',
        400,
        'Your credit balance is too low to access the Anthropic API.',
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.kind : '').toBe('billing');
    expect(result.ok === false ? result.message : '').toContain('billing or credit balance');
  });

  test('classifies unauthorized provider errors as credential failures', () => {
    const result = classifyProviderPreflightError(
      'openai',
      'gpt-4o-mini',
      new ProviderHttpError('openai', 401, 'invalid api key'),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.kind : '').toBe('credential');
  });
});
