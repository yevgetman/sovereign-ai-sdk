import { expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import { SubscriptionStreamError } from '@yevgetman/sov-sdk/providers/errors';
import { GrokSubscriptionProvider } from '@yevgetman/sov-sdk/providers/grok';
import type { AttemptDeps } from '@yevgetman/sov-sdk/providers/subscription/attempt';
import type { SubscriptionFetch } from '@yevgetman/sov-sdk/providers/subscription/port';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';

const req: ProviderRequest = {
  model: 'gpt-5.3-codex',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 16,
};
const encoder = new TextEncoder();
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const terminal = { type: 'response.completed', response: {} };
function ok() {
  return new Response(frame({ type: 'response.output_text.delta', delta: 'ok' }) + frame(terminal));
}
function provider(
  fetchImpl: SubscriptionFetch,
  sleeps: number[],
  kind: 'chatgpt' | 'grok' = 'chatgpt',
  overrides: Partial<AttemptDeps> = {},
) {
  const options = {
    port: {
      read: async () => ({
        accessToken: 'fake-secret',
        refreshToken: 'fake-refresh',
        expiresAt: 1e15,
      }),
      write: async () => {},
      delete: async () => {},
    },
    fetchImpl,
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0,
      now: () => 0,
      ...overrides,
    },
  };
  return kind === 'grok'
    ? new GrokSubscriptionProvider(options)
    : new ChatGptSubscriptionProvider(options);
}
async function drain(p: ReturnType<typeof provider>, request = req) {
  const events = [];
  for await (const event of p.stream(request)) events.push(event);
  return events;
}
for (const kind of ['chatgpt', 'grok'] as const) {
  for (const fault of ['eof', 'reset', 'nested-reset', 'malformed'] as const) {
    test(`${kind} HTTP 200 ${fault} before delivery retries without duplicate output`, async () => {
      let calls = 0;
      const sleeps: number[] = [];
      const p = provider(
        async () => {
          calls++;
          if (calls > 1) return ok();
          if (fault === 'eof') return new Response(': keepalive\n\n');
          if (fault === 'malformed') return new Response('data: invalid-json\n\n');
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(
                  fault === 'nested-reset'
                    ? new TypeError('terminated fake-secret', {
                        cause: Object.assign(new Error('fake-secret'), { code: 'UND_ERR_SOCKET' }),
                      })
                    : Object.assign(new Error('socket hang up fake-secret'), {
                        code: 'ECONNRESET',
                      }),
                );
              },
            }),
          );
        },
        sleeps,
        kind,
      );
      const events = await drain(p, { ...req, model: kind === 'grok' ? 'grok-4.7' : req.model });
      expect(calls).toBe(2);
      expect(sleeps).toEqual([500]);
      expect(events.filter((e) => e.type === 'message_start')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'text_delta')).toEqual([
        { type: 'text_delta', text: 'ok' },
      ]);
    });
  }
}

for (const semantic of [
  { type: 'response.refusal.delta', delta: 'fixture refusal' },
  { type: 'response.refusal.done', refusal: 'fixture refusal' },
  { type: 'response.content_part.done', part: { type: 'refusal', refusal: 'fixture refusal' } },
  { type: 'response.output_text.delta', delta: 'partial' },
  { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{' },
  {
    type: 'response.output_item.added',
    item: { type: 'reasoning', encrypted_content: 'fake-ciphertext' },
  },
  {
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: 'call1', name: 'echo', arguments: '{}' },
  },
  {
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: 'malformed', name: 'echo', arguments: 'invalid' },
  },
  { type: 'response.usage', usage: { output_tokens: 1 } },
  terminal,
]) {
  test(`never retry semantic ${semantic.type} then reset`, async () => {
    let calls = 0;
    let pulls = 0;
    const sleeps: number[] = [];
    const p = provider(async () => {
      calls++;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(encoder.encode(frame(semantic)));
            else
              controller.error(
                Object.assign(new Error('fake-secret socket hang up'), { code: 'ECONNRESET' }),
              );
          },
        }),
      );
    }, sleeps);
    let caught: unknown;
    try {
      await drain(p);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SubscriptionStreamError);
    expect((caught as SubscriptionStreamError).phase).toBe('incomplete_delivery');
    expect(String(caught)).not.toContain('fake-secret');
    expect(JSON.stringify(caught)).not.toContain('fake-secret');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
}

test('malformed reader is cancelled and unlocked before Retry-After backoff', async () => {
  let calls = 0;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: bad\n\n'));
    },
    cancel() {
      cancelled++;
    },
  });
  const sleeps: number[] = [];
  const p = provider(
    async () => {
      calls++;
      return calls === 1 ? new Response(body, { headers: { 'retry-after': '2' } }) : ok();
    },
    sleeps,
    'chatgpt',
    {
      sleep: async (ms) => {
        expect(cancelled).toBe(1);
        expect(body.locked).toBe(false);
        sleeps.push(ms);
      },
    },
  );
  await drain(p);
  expect(calls).toBe(2);
  expect(sleeps).toEqual([2000]);
});

test('one three-request budget spans fetch, HTTP and stream failures', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const p = provider(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    if (calls === 2) return new Response('busy', { status: 503 });
    return new Response(': keepalive\n\n');
  }, sleeps);
  await expect(drain(p)).rejects.toBeInstanceOf(SubscriptionStreamError);
  expect(calls).toBe(3);
  expect(sleeps).toEqual([500, 1500]);
});

test('repeated malformed first events exhaust with safe pre-delivery diagnostic', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const p = provider(async () => {
    calls++;
    return new Response('data: fake-secret\n\n');
  }, sleeps);
  let caught: unknown;
  try {
    await drain(p);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SubscriptionStreamError);
  expect((caught as SubscriptionStreamError).phase).toBe('before_delivery');
  expect((caught as SubscriptionStreamError).reason).toBe('invalid_event');
  expect(JSON.stringify(caught)).not.toContain('fake-secret');
  expect(calls).toBe(3);
  expect(sleeps).toEqual([500, 1500]);
});

for (const retryAfter of ['11', '2']) {
  test(`stream Retry-After ${retryAfter} respects cap or cancellation`, async () => {
    let calls = 0;
    const controller = new AbortController();
    const p = provider(
      async () => {
        calls++;
        return new Response(': heartbeat\n\n', { headers: { 'retry-after': retryAfter } });
      },
      [],
      'chatgpt',
      {
        sleep: async (_ms, signal) => {
          controller.abort();
          expect(signal?.aborted).toBe(true);
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      },
    );
    await expect(drain(p, { ...req, signal: controller.signal })).rejects.toThrow(
      retryAfter === '11' ? /before_delivery/ : /aborted/,
    );
    expect(calls).toBe(1);
  });
}

for (const code of [
  'invalid_prompt',
  'invalid_image',
  'data_residency_mismatch',
  'future_unknown_failure',
  'rate_limit_exceeded',
  'server_error',
  'context_length_exceeded',
  'model_not_found',
]) {
  test(`provider first-frame failure ${code} only retries when eligible`, async () => {
    let calls = 0;
    const p = provider(async () => {
      calls++;
      return calls === 1
        ? new Response(
            frame({
              type: 'response.failed',
              response: { error: { code, message: 'fake-secret' } },
            }),
          )
        : ok();
    }, []);
    if (code === 'rate_limit_exceeded' || code === 'server_error') {
      await drain(p);
      expect(calls).toBe(2);
    } else {
      await expect(drain(p)).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
}

test('local HTTP fault proxy closes first stream before delivery; exactly one tool execution survives retry', async () => {
  let proxyCalls = 0;
  const urls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch() {
      proxyCalls++;
      if (proxyCalls >= 3) return ok();
      if (proxyCalls === 1)
        return new Response(': heartbeat\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      return new Response(
        frame({
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: 'call1', name: 'echo', arguments: '{}' },
        }) + frame(terminal),
      );
    },
  });
  try {
    const p = provider(async (input, init) => {
      urls.push(String(input));
      return fetch(server.url, init);
    }, []);
    let toolRuns = 0;
    const agent = createAgent({
      provider: p,
      model: req.model,
      maxTurns: 2,
      tools: [
        buildTool({
          name: 'echo',
          description: () => 'Read only fixture',
          inputSchema: z.object({}),
          isReadOnly: () => true,
          async call() {
            toolRuns++;
            return { data: { value: 'fixture' } };
          },
        }),
      ],
    });
    const stream = agent.run('fixture');
    const events = [];
    let completed = false;
    while (true) {
      const step = await stream.next();
      if (step.done) {
        completed = step.value.terminal.reason === 'completed';
        break;
      }
      events.push(step.value);
    }
    expect(completed).toBe(true);
    expect(proxyCalls).toBe(3);
    expect(new Set(urls)).toEqual(new Set(['https://chatgpt.com/backend-api/codex/responses']));
    expect(events.filter((e) => 'type' in e && e.type === 'tool_use_delta')).toHaveLength(1);
    expect(events.filter((e) => 'type' in e && e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'ok' },
    ]);
    expect(toolRuns).toBe(1);
  } finally {
    await server.stop(true);
  }
});
