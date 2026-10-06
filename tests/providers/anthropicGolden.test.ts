// Locks one API-key Anthropic request to today's bytes.
// A missing subscription login must not change this request.

import { describe, expect, test } from 'bun:test';
import { AnthropicProvider } from '@yevgetman/sov-sdk/providers/anthropic';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

const GOLDEN =
  '{"model":"claude-haiku-4-5-20251001","max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}],"stream":true}';

const req: ProviderRequest = {
  model: 'claude-haiku-4-5-20251001',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 16,
};

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return '';
}

describe('anthropic API-key request', () => {
  test('the HTTP body matches the frozen bytes', async () => {
    let captured = '';
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = bodyText(init?.body);
      return new Response('data: {"type":"error"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test', fetch: fetchImpl });
    expect(JSON.stringify(provider.buildKwargs(req))).toBe(GOLDEN);
    try {
      await provider.stream(req).next();
    } catch {
      // The fake stream is only here to force the HTTP call.
    }
    expect(captured).toBe(GOLDEN);
  });
});
