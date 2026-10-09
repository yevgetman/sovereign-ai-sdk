import { describe, expect, test } from 'bun:test';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import { GrokSubscriptionProvider } from '@yevgetman/sov-sdk/providers/grok';
import {
  codexReasoning,
  responsesInput,
  translateResponsesSse,
} from '@yevgetman/sov-sdk/providers/responses';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

const req: ProviderRequest = {
  model: 'gpt-5.3-codex',
  system: [{ text: 'trusted', cacheable: false }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  maxTokens: 100,
  effort: 'high',
};
const port = {
  read: async () => ({
    accessToken: 'fake',
    refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 3600000,
  }),
  write: async () => {},
  delete: async () => {},
};
const wire = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
async function collect(response: Response) {
  const events = [];
  const gen = translateResponsesSse(response, 'test');
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, message: step.value };
    events.push(step.value);
  }
}

describe('subscription Responses wire', () => {
  test('emits text while the network response is still open', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const gen = translateResponsesSse(new Response(body), 'test');
    expect((await gen.next()).value).toEqual({ type: 'message_start' });
    controller.enqueue(
      new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"live"}\n\n'),
    );
    expect((await gen.next()).value).toEqual({ type: 'text_delta', text: 'live' });
    controller.enqueue(
      new TextEncoder().encode('data: {"type":"response.completed","response":{}}\n\n'),
    );
    controller.close();
    for (;;) {
      if ((await gen.next()).done) break;
    }
  });
  test('completion alone retains final text and tools with original ids', async () => {
    const { message } = await collect(
      wire([
        {
          type: 'response.completed',
          response: {
            output: [
              { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
              { type: 'function_call', call_id: 'call1', name: 'Read', arguments: '{"path":"a"}' },
            ],
          },
        },
      ]),
    );
    expect(message.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'call1', name: 'Read', input: { path: 'a' } },
    ]);
  });
  test('truncated, failed and invalid tool streams fail instead of completing', async () => {
    await expect(
      collect(wire([{ type: 'response.output_text.delta', delta: 'partial' }])),
    ).rejects.toThrow('terminal');
    await expect(
      collect(
        wire([
          {
            type: 'response.failed',
            response: { error: { code: 'internal', message: 'secret-do-not-show' } },
          },
        ]),
      ),
    ).rejects.toThrow('subscription response failed');
    await expect(
      collect(
        wire([
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'c', name: 'Read', arguments: 'bad' },
          },
        ]),
      ),
    ).rejects.toThrow('tool arguments');
  });
  test('incomplete pending or done tool calls cannot reach execution', async () => {
    await expect(
      collect(
        wire([
          { type: 'response.output_item.added', item: { type: 'function_call', id: 'i' } },
          {
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'max_output_tokens' } },
          },
        ]),
      ),
    ).rejects.toThrow('tool response incomplete');
    await expect(
      collect(
        wire([
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'c', name: 'Read', arguments: '{}' },
          },
          {
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'max_output_tokens' } },
          },
        ]),
      ),
    ).rejects.toThrow('tool response incomplete');
  });
  test('completed cannot hide an unfinished function call or malformed response', async () => {
    await expect(
      collect(
        wire([
          { type: 'response.output_item.added', item: { type: 'function_call', id: 'pending' } },
          { type: 'response.completed', response: { status: 'completed', output: [] } },
        ]),
      ),
    ).rejects.toThrow('unfinished tool calls');
    await expect(collect(wire([{ type: 'response.completed' }]))).rejects.toThrow(
      'invalid subscription terminal',
    );
    await expect(
      collect(wire([{ type: 'response.completed', response: { status: 'failed' } }])),
    ).rejects.toThrow('invalid subscription terminal');
  });
  test('native image order survives text and tool boundaries', () => {
    const input = responsesInput({
      ...req,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQ==' } },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Ag==' } },
          ],
        },
      ],
    });
    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'first' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,Ag==' },
        ],
      },
    ]);
  });
  test('ChatGPT sends supported reasoning and omits unsupported API controls', async () => {
    let sent: Record<string, unknown> = {};
    const provider = new ChatGptSubscriptionProvider({
      port,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return wire([{ type: 'response.completed', response: {} }]);
      },
    });
    for await (const _ of provider.stream({ ...req, temperature: 0.2 })) {
    }
    expect(sent.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(sent).not.toHaveProperty('max_output_tokens');
    expect(sent).not.toHaveProperty('temperature');
    expect(codexReasoning('max').effort).toBe('xhigh');
    expect(() => codexReasoning('off')).toThrow('does not support off effort');
  });
  test('Grok subscription uses Responses with function-call/result serialization', async () => {
    let url = '';
    let sent: Record<string, unknown> = {};
    const provider = new GrokSubscriptionProvider({
      port,
      fetchImpl: async (value, init) => {
        url = String(value);
        sent = JSON.parse(String(init?.body));
        return wire([{ type: 'response.completed', response: {} }]);
      },
    });
    for await (const _ of provider.stream({
      ...req,
      model: 'grok-4.6',
      effort: 'off',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'id1', name: 'Read', input: { path: 'a' } }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'id1', content: 'found' }] },
      ],
    })) {
    }
    expect(url).toBe('https://api.x.ai/v1/responses');
    expect(sent.input).toEqual([
      { type: 'function_call', call_id: 'id1', name: 'Read', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'id1', output: 'found' },
    ]);
    expect(sent).not.toHaveProperty('messages');
  });
});
