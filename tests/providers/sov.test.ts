// SovProvider tests — the keyless local lane for the Sovereign L1 engine.
// No live API calls: a fake `fetch` captures the outgoing request headers
// and replays a minimal Chat-Completions SSE body so we can assert both the
// auth posture (keyless ⇒ no Authorization header) and that the reasoning
// channel surfaces as `thinking` (proving translateOpenAIStream reuse).

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import { SovProvider } from '../../src/providers/sov.js';

/** Build a fake `fetch` that records the request and replays SSE `lines`. */
function fakeFetch(lines: string[]): {
  fetchImpl: typeof fetch;
  captured: () => { url: string; headers: Record<string, string> };
} {
  let recordedUrl = '';
  let recordedHeaders: Record<string, string> = {};
  const body = `${lines.map((l) => `data: ${l}`).join('\n')}\ndata: [DONE]\n`;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    recordedUrl = String(url);
    recordedHeaders = (init?.headers as Record<string, string>) ?? {};
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured: () => ({ url: recordedUrl, headers: recordedHeaders }) };
}

async function drain(
  gen: AsyncGenerator<StreamEvent, AssistantMessage>,
): Promise<{ yielded: StreamEvent[]; returned: AssistantMessage }> {
  const yielded: StreamEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { yielded, returned: step.value };
    yielded.push(step.value);
  }
}

const REQ = {
  model: 'mlx-community/Qwen3-4B-4bit',
  system: [],
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  maxTokens: 64,
};

describe('SovProvider — keyless posture', () => {
  test('constructs without an apiKey and reports name/apiMode = sov', () => {
    const provider = new SovProvider({});
    expect(provider.name).toBe('sov');
    expect(provider.apiMode).toBe('sov');
  });

  test('defaults to the loopback base URL', () => {
    const { fetchImpl, captured } = fakeFetch([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new SovProvider({ fetchImpl });
    return drain(provider.stream(REQ)).then(() => {
      expect(captured().url).toBe('http://127.0.0.1:8000/v1/chat/completions');
    });
  });

  test('omits the Authorization header when no key is set', async () => {
    const { fetchImpl, captured } = fakeFetch([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new SovProvider({ fetchImpl });
    await drain(provider.stream(REQ));
    const headers = captured().headers;
    // No bearer token on the keyless local lane.
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    // The content-type header is still sent.
    expect(headers['content-type']).toBe('application/json');
  });

  test('sends a Bearer Authorization header when a key IS provided', async () => {
    const { fetchImpl, captured } = fakeFetch([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new SovProvider({ apiKey: 'sk-local-secret', fetchImpl });
    await drain(provider.stream(REQ));
    expect(captured().headers.authorization).toBe('Bearer sk-local-secret');
  });
});

describe('SovProvider — reuses the OpenAI translation', () => {
  test('thinking ON (effort set): a reasoning_content chunk surfaces as a thinking block', async () => {
    const { fetchImpl } = fakeFetch([
      '{"choices":[{"delta":{"reasoning_content":"let me think"}}]}',
      '{"choices":[{"delta":{"content":"the answer is 42"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new SovProvider({ fetchImpl });
    // effort set ⇒ thinking on ⇒ reasoning_content is genuine CoT.
    const { yielded, returned } = await drain(provider.stream({ ...REQ, effort: 'high' }));

    // The reasoning text rode the thinking channel, not the text channel.
    const thinkingDelta = yielded.find(
      (e): e is Extract<StreamEvent, { type: 'thinking_delta' }> => e.type === 'thinking_delta',
    );
    expect(thinkingDelta?.thinking).toBe('let me think');

    // Final message: a thinking block (ordered first) then the text block.
    expect(returned.content).toEqual([
      { type: 'thinking', thinking: 'let me think' },
      { type: 'text', text: 'the answer is 42' },
    ]);
  });

  test('thinking OFF (default): reasoning_content is the ANSWER, surfaced as text', async () => {
    // Mirrors the live vllm-mlx behavior with enable_thinking:false — the whole
    // answer lands on the reasoning channel and `content` stays empty. Without
    // the fix it rendered as dim "thinking" and no assistant response appeared.
    const { fetchImpl } = fakeFetch([
      '{"choices":[{"delta":{"reasoning_content":"Paris."}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new SovProvider({ fetchImpl });
    // REQ has no effort ⇒ thinking off ⇒ the reasoning channel carries the answer.
    const { yielded, returned } = await drain(provider.stream(REQ));

    // It must NOT be a thinking block — it's the answer, surfaced as text.
    expect(yielded.some((e) => e.type === 'thinking_delta')).toBe(false);
    const textDelta = yielded.find(
      (e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta',
    );
    expect(textDelta?.text).toBe('Paris.');
    expect(returned.content).toEqual([{ type: 'text', text: 'Paris.' }]);
  });

  test('preserves an engine-supplied tool-call id end to end', async () => {
    const { fetchImpl } = fakeFetch([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"Echo","arguments":"{\\"text\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}',
    ]);
    const provider = new SovProvider({ fetchImpl });
    const { returned } = await drain(provider.stream(REQ));
    const toolUse = returned.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    expect(toolUse?.id).toBe('call_abc123');
    expect(toolUse?.input).toEqual({ text: 'x' });
  });
});
