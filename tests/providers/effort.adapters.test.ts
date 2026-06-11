// Adapter-wiring tests for the /effort reasoning-depth feature. Calls
// buildKwargs directly on each provider and asserts the request body per
// provider per level, including the hard regression guard: off/undefined must
// leave the body byte-identical to today.
//
// No live API calls — buildKwargs is a pure translation; providers are
// constructed with a dummy key / fetch only so the method is reachable.

import { describe, expect, test } from 'bun:test';
import type { Message, SystemSegment } from '../../src/core/types.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { MAX_TOKENS_CEILING } from '../../src/providers/effort.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import { SovProvider } from '../../src/providers/sov.js';
import type { ProviderRequest } from '../../src/providers/types.js';

const MESSAGES: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
const SYSTEM: SystemSegment[] = [{ text: 'be helpful', cacheable: false }];

function baseReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-haiku-4-5-20251001',
    system: SYSTEM,
    messages: MESSAGES,
    maxTokens: 4096,
    temperature: 0.7,
    ...overrides,
  };
}

const noopFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;

describe('Anthropic buildKwargs — effort wiring', () => {
  const provider = new AnthropicProvider({ apiKey: 'test-key' });

  test('regression: effort off ⇒ body byte-identical to undefined-effort body', () => {
    const off = provider.buildKwargs(baseReq({ effort: 'off' }));
    const absent = provider.buildKwargs(baseReq());
    expect(off).toEqual(absent);
    expect('thinking' in off).toBe(false);
    expect(off.max_tokens).toBe(4096);
    expect(off.temperature).toBe(0.7);
  });

  test('regression: undefined effort ⇒ temperature preserved, no thinking, max_tokens unchanged', () => {
    const body = provider.buildKwargs(baseReq());
    expect('thinking' in body).toBe(false);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(4096);
  });

  test('low: thinking enabled, max_tokens raised, temperature dropped', () => {
    const body = provider.buildKwargs(baseReq({ effort: 'low' }));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
    expect(body.max_tokens).toBe(4000 + 8192);
    expect('temperature' in body).toBe(false);
  });

  test('medium / high budgets', () => {
    const medium = provider.buildKwargs(baseReq({ effort: 'medium' }));
    expect(medium.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
    const high = provider.buildKwargs(baseReq({ effort: 'high' }));
    expect(high.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
  });

  test('max on a small max_tokens: budget < max_tokens and both ≤ ceiling', () => {
    const body = provider.buildKwargs(baseReq({ effort: 'max', maxTokens: 2000 }));
    const thinking = body.thinking;
    expect(thinking).toBeDefined();
    if (!thinking || thinking.type !== 'enabled') throw new Error('expected enabled thinking');
    expect(thinking.budget_tokens).toBeLessThan(body.max_tokens);
    expect(thinking.budget_tokens).toBeLessThanOrEqual(MAX_TOKENS_CEILING);
    expect(body.max_tokens).toBeLessThanOrEqual(MAX_TOKENS_CEILING);
  });

  test('thinking-on body never carries a temperature key', () => {
    const body = provider.buildKwargs(baseReq({ effort: 'high', temperature: 0.2 }));
    expect('temperature' in body).toBe(false);
  });

  test('non-reasoning anthropic model (claude-3-5-haiku) + high ⇒ no thinking, temperature kept', () => {
    const body = provider.buildKwargs(baseReq({ model: 'claude-3-5-haiku', effort: 'high' }));
    expect('thinking' in body).toBe(false);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(4096);
  });
});

describe('Anthropic stream() — interleaved-thinking beta header', () => {
  // The beta is attached via the second-arg RequestOptions.headers of
  // client.messages.create. Spy on that call to capture the headers it gets,
  // proving the header is present iff thinking applies. The private `client`
  // field is reached via a structural cast (test-only).
  type CreateSpy = {
    calls: Array<{ options: { headers?: Record<string, string> } }>;
  };

  function spyProvider(): { provider: AnthropicProvider; spy: CreateSpy } {
    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const spy: CreateSpy = { calls: [] };
    const client = (provider as unknown as { client: { messages: { create: unknown } } }).client;
    client.messages.create = (
      _body: unknown,
      options: { headers?: Record<string, string> },
    ): AsyncIterable<never> => {
      spy.calls.push({ options });
      return {
        async *[Symbol.asyncIterator]() {
          // no events — stream() just returns an empty assistant message
        },
      };
    };
    return { provider, spy };
  }

  async function drainStream(provider: AnthropicProvider, req: ProviderRequest): Promise<void> {
    const gen = provider.stream(req);
    for (;;) {
      const step = await gen.next();
      if (step.done) return;
    }
  }

  test('thinking on (effort high, reasoning model) ⇒ anthropic-beta header attached', async () => {
    const { provider, spy } = spyProvider();
    await drainStream(provider, baseReq({ effort: 'high' }));
    expect(spy.calls[0]?.options.headers).toEqual({
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    });
  });

  test('effort off ⇒ no anthropic-beta header', async () => {
    const { provider, spy } = spyProvider();
    await drainStream(provider, baseReq({ effort: 'off' }));
    expect(spy.calls[0]?.options.headers).toBeUndefined();
  });

  test('undefined effort ⇒ no anthropic-beta header', async () => {
    const { provider, spy } = spyProvider();
    await drainStream(provider, baseReq());
    expect(spy.calls[0]?.options.headers).toBeUndefined();
  });

  test('reasoning param set but model is pre-4 ⇒ no header (capability-gated)', async () => {
    const { provider, spy } = spyProvider();
    await drainStream(provider, baseReq({ model: 'claude-3-5-haiku', effort: 'high' }));
    expect(spy.calls[0]?.options.headers).toBeUndefined();
  });
});

describe('OpenAI buildKwargs — effort wiring', () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key', fetchImpl: noopFetch });

  function openaiReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
    return baseReq({ model: 'gpt-5', ...overrides });
  }

  test('regression: effort off ⇒ body byte-identical to undefined-effort body', () => {
    const off = provider.buildKwargs(openaiReq({ effort: 'off' }));
    const absent = provider.buildKwargs(openaiReq());
    expect(off).toEqual(absent);
    expect('reasoning_effort' in off).toBe(false);
    expect('chat_template_kwargs' in off).toBe(false);
    expect(off.temperature).toBe(0.7);
    expect(off.max_tokens).toBe(4096);
  });

  test('low/medium/high pass reasoning_effort straight through; max collapses to high', () => {
    expect(provider.buildKwargs(openaiReq({ effort: 'low' })).reasoning_effort).toBe('low');
    expect(provider.buildKwargs(openaiReq({ effort: 'medium' })).reasoning_effort).toBe('medium');
    expect(provider.buildKwargs(openaiReq({ effort: 'high' })).reasoning_effort).toBe('high');
    expect(provider.buildKwargs(openaiReq({ effort: 'max' })).reasoning_effort).toBe('high');
  });

  test('reasoning model emits max_completion_tokens (not max_tokens) and drops temperature', () => {
    // o1/o3/o4/gpt-5 reject `max_tokens` (require `max_completion_tokens`) and
    // reject a non-default temperature. The body must mirror the Anthropic
    // thinking path: swap the token cap key + drop temperature.
    const body = provider.buildKwargs(openaiReq({ effort: 'high' }));
    expect('max_tokens' in body).toBe(false);
    expect(body.max_completion_tokens).toBe(4096);
    expect('temperature' in body).toBe(false);
  });

  test('non-reasoning model still uses max_tokens + keeps temperature', () => {
    const body = provider.buildKwargs(openaiReq({ model: 'gpt-4o', effort: 'high' }));
    expect(body.max_tokens).toBe(4096);
    expect('max_completion_tokens' in body).toBe(false);
    expect(body.temperature).toBe(0.7);
  });

  test('openai apiMode never sets chat_template_kwargs', () => {
    const body = provider.buildKwargs(openaiReq({ effort: 'high' }));
    expect('chat_template_kwargs' in body).toBe(false);
  });

  test('non-reasoning openai model (gpt-4o) + high ⇒ no reasoning_effort', () => {
    const body = provider.buildKwargs(openaiReq({ model: 'gpt-4o', effort: 'high' }));
    expect('reasoning_effort' in body).toBe(false);
    expect(body.temperature).toBe(0.7);
  });
});

describe('Sov buildKwargs — effort wiring (inherits OpenAI + enable_thinking)', () => {
  const provider = new SovProvider({ fetchImpl: noopFetch });

  function sovReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
    return baseReq({ model: 'mlx-community/Qwen3-4B-4bit', ...overrides });
  }

  test('off/undefined ⇒ enable_thinking:false (the real off-switch), no reasoning_effort', () => {
    const off = provider.buildKwargs(sovReq({ effort: 'off' }));
    const absent = provider.buildKwargs(sovReq());
    // off and undefined still produce the same body as each other...
    expect(off).toEqual(absent);
    expect('reasoning_effort' in off).toBe(false);
    // ...but UNLIKE anthropic/openai, sov ALWAYS sends the chat-template flag.
    // Omitting it let Qwen3's chat template default thinking ON, so `/effort
    // off` could never actually disable reasoning (the model reasoned until it
    // exhausted max_tokens and never answered). Sending enable_thinking:false
    // is what makes the off-switch real.
    expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('on: sets BOTH reasoning_effort and chat_template_kwargs.enable_thinking', () => {
    const body = provider.buildKwargs(sovReq({ effort: 'medium' }));
    expect(body.reasoning_effort).toBe('medium');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test('sov supports reasoning for any model id (engine gates it itself)', () => {
    const body = provider.buildKwargs(
      sovReq({ model: 'some-arbitrary-local-model', effort: 'low' }),
    );
    expect(body.reasoning_effort).toBe('low');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});
