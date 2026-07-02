// Provider preflight tests. Uses fake providers so no live API is required.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { ProviderHttpError } from '@yevgetman/sov-sdk/providers/errors';
import {
  classifyProviderPreflightError,
  preflightProvider,
  preflightToolCalling,
} from '@yevgetman/sov-sdk/providers/preflight';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

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

  test('tool preflight publishes a no-op tool schema', async () => {
    let seen: ProviderRequest | undefined;
    const ok = provider(async function* (req) {
      seen = req;
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
      };
      yield { type: 'assistant_message', message: assistant };
      return assistant;
    });

    const result = await preflightToolCalling({
      provider: ok,
      providerName: 'ollama',
      model: 'tool-model',
    });

    expect(result.ok).toBe(true);
    expect(seen?.tools?.[0]?.name).toBe('preflight_noop');
  });

  test('classifies unsupported tool models clearly', () => {
    const result = classifyProviderPreflightError(
      'ollama',
      'dolphin-llama3:latest',
      new ProviderHttpError(
        'ollama',
        400,
        'registry.ollama.ai/library/dolphin-llama3:latest does not support tools',
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.kind : '').toBe('tool_support');
    expect(result.ok === false ? result.message : '').toContain('does not support tool calls');
  });
});
