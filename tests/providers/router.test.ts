// RouterProvider tests — the generic model-router lane (apiMode 'router').
// No live API calls: a fake `fetch` captures the outgoing request (url, headers,
// body) and replays a minimal Chat-Completions SSE body plus optional response
// headers. This lets us assert the routing-hint header merge (a hint header can
// never mask auth/content-type), the `onRouteResolved` route-report seam (parsed
// from X-Manifest-* response headers, best-effort), and that the OpenAI SSE/
// tool/usage translation is inherited unchanged.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { type ResolvedRoute, RouterProvider } from '@yevgetman/sov-sdk/providers/router';

/** Build a fake `fetch` that records the request and replays SSE `lines`. The
 *  optional `responseHeaders` ride on the replayed Response so the route-report
 *  seam (X-Manifest-*) can be exercised. */
function fakeFetch(
  lines: string[],
  responseHeaders: Record<string, string> = {},
): {
  fetchImpl: typeof fetch;
  captured: () => { url: string; headers: Record<string, string>; body: string };
} {
  let recordedUrl = '';
  let recordedHeaders: Record<string, string> = {};
  let recordedBody = '';
  const body = `${lines.map((l) => `data: ${l}`).join('\n')}\ndata: [DONE]\n`;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    recordedUrl = String(url);
    recordedHeaders = (init?.headers as Record<string, string>) ?? {};
    recordedBody = typeof init?.body === 'string' ? init.body : '';
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', ...responseHeaders },
    });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    captured: () => ({ url: recordedUrl, headers: recordedHeaders, body: recordedBody }),
  };
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
  model: 'auto',
  system: [],
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  maxTokens: 64,
};

describe('RouterProvider — construction', () => {
  test('reports name/apiMode = router', () => {
    const provider = new RouterProvider({ apiKey: 'mnfst_key' });
    expect(provider.name).toBe('router');
    expect(provider.apiMode).toBe('router');
  });

  test('defaults to the Manifest self-hosted loopback base URL', async () => {
    const { fetchImpl, captured } = fakeFetch([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new RouterProvider({ apiKey: 'mnfst_key', fetchImpl });
    await drain(provider.stream(REQ));
    expect(captured().url).toBe('http://localhost:2099/v1/chat/completions');
  });

  test('respects a baseURL override', async () => {
    const { fetchImpl, captured } = fakeFetch([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new RouterProvider({
      apiKey: 'mnfst_key',
      baseURL: 'https://app.manifest.build/v1',
      fetchImpl,
    });
    await drain(provider.stream(REQ));
    expect(captured().url).toBe('https://app.manifest.build/v1/chat/completions');
  });

  test('throws when no apiKey is provided (key required)', () => {
    expect(() => new RouterProvider({})).toThrow();
  });
});

describe('RouterProvider — routing-hint headers', () => {
  test('sends configured hint headers on the request', async () => {
    const { fetchImpl, captured } = fakeFetch([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new RouterProvider({
      apiKey: 'mnfst_key',
      headers: { 'x-tier': 'cheap', 'x-session-key': 'abc' },
      fetchImpl,
    });
    await drain(provider.stream(REQ));
    const headers = captured().headers;
    expect(headers['x-tier']).toBe('cheap');
    expect(headers['x-session-key']).toBe('abc');
  });

  test('a hint header cannot mask the real authorization or content-type', async () => {
    const { fetchImpl, captured } = fakeFetch([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const provider = new RouterProvider({
      apiKey: 'mnfst_realkey',
      // A malicious hint map trying to override the auth + content-type.
      headers: { authorization: 'Bearer evil', 'content-type': 'text/plain' },
      fetchImpl,
    });
    await drain(provider.stream(REQ));
    const headers = captured().headers;
    // The base headers win: the real key + JSON content-type are never masked.
    expect(headers.authorization).toBe('Bearer mnfst_realkey');
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('RouterProvider — onRouteResolved route report', () => {
  test('fires with the parsed route when X-Manifest-* headers are present', async () => {
    const { fetchImpl } = fakeFetch(['{"choices":[{"delta":{},"finish_reason":"stop"}]}'], {
      'X-Manifest-Model': 'gpt-4o',
      'X-Manifest-Provider': 'openai',
      'X-Manifest-Tier': 'cheap',
      'X-Manifest-Reason': 'complexity',
    });
    let resolved: ResolvedRoute | undefined;
    const provider = new RouterProvider({
      apiKey: 'mnfst_key',
      onRouteResolved: (route) => {
        resolved = route;
      },
      fetchImpl,
    });
    await drain(provider.stream(REQ));
    expect(resolved).toEqual({
      model: 'gpt-4o',
      provider: 'openai',
      tier: 'cheap',
      reason: 'complexity',
    });
  });

  test('omits fields absent from the response headers', async () => {
    const { fetchImpl } = fakeFetch(['{"choices":[{"delta":{},"finish_reason":"stop"}]}'], {
      'X-Manifest-Model': 'gpt-4o',
    });
    let resolved: ResolvedRoute | undefined;
    const provider = new RouterProvider({
      apiKey: 'mnfst_key',
      onRouteResolved: (route) => {
        resolved = route;
      },
      fetchImpl,
    });
    await drain(provider.stream(REQ));
    // Only the model key exists — no provider/tier/reason keys at all.
    expect(resolved).toEqual({ model: 'gpt-4o' });
  });

  test('does NOT invoke the callback when no route headers are present', async () => {
    const { fetchImpl } = fakeFetch(['{"choices":[{"delta":{},"finish_reason":"stop"}]}']);
    let called = 0;
    const provider = new RouterProvider({
      apiKey: 'mnfst_key',
      onRouteResolved: () => {
        called += 1;
      },
      fetchImpl,
    });
    await drain(provider.stream(REQ));
    expect(called).toBe(0);
  });

  test('swallows a throwing callback — the stream still yields text and completes', async () => {
    const { fetchImpl } = fakeFetch(
      [
        '{"choices":[{"delta":{"content":"routed answer"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      ],
      { 'X-Manifest-Model': 'gpt-4o' },
    );
    const provider = new RouterProvider({
      apiKey: 'mnfst_key',
      onRouteResolved: () => {
        throw new Error('callback boom');
      },
      fetchImpl,
    });
    const { yielded, returned } = await drain(provider.stream(REQ));
    const textDelta = yielded.find(
      (e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta',
    );
    expect(textDelta?.text).toBe('routed answer');
    expect(returned.content).toEqual([{ type: 'text', text: 'routed answer' }]);
  });
});

describe('RouterProvider — inherits the OpenAI translation end to end', () => {
  test('a text + tool_call + usage stream translates to the expected events', async () => {
    const { fetchImpl, captured } = fakeFetch([
      '{"choices":[{"delta":{"content":"hello"}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"Echo","arguments":"{\\"text\\":\\"hi\\"}"}}]},"finish_reason":"tool_calls"}]}',
      '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    ]);
    const provider = new RouterProvider({ apiKey: 'mnfst_key', fetchImpl });
    const { yielded, returned } = await drain(provider.stream(REQ));

    // Text delta surfaced.
    const textDelta = yielded.find(
      (e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta',
    );
    expect(textDelta?.text).toBe('hello');

    // The tool call landed as a tool_use block on the returned message.
    const toolUse = returned.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    expect(toolUse?.name).toBe('Echo');
    expect(toolUse?.input).toEqual({ text: 'hi' });

    // The final usage chunk surfaced as a usage_delta.
    const usageDelta = yielded.find(
      (e): e is Extract<StreamEvent, { type: 'usage_delta' }> => e.type === 'usage_delta',
    );
    expect(usageDelta?.usage.inputTokens).toBe(10);
    expect(usageDelta?.usage.outputTokens).toBe(5);

    // The routing alias model reached the wire unchanged.
    expect(captured().body).toContain('"model":"auto"');
  });
});
