import { describe, expect, test } from 'bun:test';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import { GrokSubscriptionProvider } from '@yevgetman/sov-sdk/providers/grok';
import {
  codexReasoning,
  responsesInput,
  translateResponsesSse,
} from '@yevgetman/sov-sdk/providers/responses';
import { RouteError } from '@yevgetman/sov-sdk/providers/routes/errors';
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
  const gen = translateResponsesSse(response, 'grok');
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
      effort: 'high',
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
    expect(sent.reasoning).toEqual({ effort: 'high' });
    expect(sent.include).toEqual(['reasoning.encrypted_content']);
    expect(sent.store).toBe(false);
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(sent).not.toHaveProperty('previous_response_id');
  });

  test('Grok captures encrypted reasoning and replays it in output order', async () => {
    const ciphertext = 'cipher-value';
    const response = wire([
      {
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: ciphertext,
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'do not store this' }],
        },
      },
      {
        type: 'response.output_text.delta',
        delta: 'hello',
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              encrypted_content: ciphertext,
              status: 'completed',
              summary: [{ type: 'summary_text', text: 'still not ciphertext' }],
            },
            {
              type: 'reasoning',
              id: 'rs_empty',
              encrypted_content: '',
            },
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'hello' }],
            },
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'Read',
              arguments: '{"path":"a"}',
            },
          ],
        },
      },
    ]);
    const { message } = await collect(response);
    const reasoning = message.content.filter((block) => block.type === 'encrypted_reasoning');
    expect(reasoning).toEqual([
      {
        type: 'encrypted_reasoning',
        encryptedContent: ciphertext,
        routeId: 'grok-subscription',
        id: 'rs_1',
        status: 'completed',
        item: {
          type: 'reasoning',
          encrypted_content: ciphertext,
          id: 'rs_1',
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'still not ciphertext' }],
        },
      },
    ]);
    expect(JSON.stringify(message)).not.toContain('do not store this');
    const replay = responsesInput(
      {
        ...req,
        model: 'grok-4.7',
        messages: [message],
      },
      { replayEncryptedReasoning: true },
    );
    expect(replay).toEqual([
      {
        type: 'reasoning',
        encrypted_content: ciphertext,
        id: 'rs_1',
        status: 'completed',
        summary: [{ type: 'summary_text', text: 'still not ciphertext' }],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a"}' },
    ]);
    expect(() => responsesInput({ ...req, messages: [message] })).toThrow(RouteError);
    const chatgpt = new ChatGptSubscriptionProvider({
      port,
      fetchImpl: async () => {
        throw new Error('chatgpt must not fetch encrypted reasoning');
      },
    });
    await expect(chatgpt.stream({ ...req, messages: [message] }).next()).rejects.toMatchObject({
      code: 'unsupported_input',
    });
    expect(() =>
      responsesInput(
        {
          ...req,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'secret', signature: 'sig' }],
            },
          ],
        },
        { replayEncryptedReasoning: true },
      ),
    ).toThrow(/signed reasoning/);
    expect(() =>
      responsesInput(
        {
          ...req,
          messages: [
            { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] },
          ],
        },
        { replayEncryptedReasoning: true },
      ),
    ).toThrow(/encrypted reasoning history cannot be replayed/);
  });

  test('Grok subscription body maps max to xhigh and refuses off before fetch', async () => {
    let fetches = 0;
    let sent: Record<string, unknown> = {};
    const provider = new GrokSubscriptionProvider({
      port,
      fetchImpl: async (_url, init) => {
        fetches += 1;
        sent = JSON.parse(String(init?.body));
        return wire([{ type: 'response.completed', response: { status: 'completed' } }]);
      },
    });
    for await (const _ of provider.stream({ ...req, model: 'grok-4.7', effort: 'max' })) {
    }
    expect(sent.reasoning).toEqual({ effort: 'xhigh' });
    expect(sent.include).toEqual(['reasoning.encrypted_content']);
    expect(sent.store).toBe(false);
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(JSON.stringify(sent)).not.toContain('summary');
    for await (const _ of provider.stream({ ...req, model: 'grok-4.7' })) {
    }
    expect(sent.reasoning).toEqual({ effort: 'high' });
    const before = fetches;
    await expect(
      provider.stream({ ...req, model: 'grok-4.7', effort: 'off' }).next(),
    ).rejects.toMatchObject({ code: 'effort_unsupported' });
    for (const model of ['grok-4.7-build-fast', 'grok-4.5', 'grok-foo', 'not-a-grok']) {
      await expect(provider.stream({ ...req, model, effort: 'high' }).next()).rejects.toMatchObject(
        { code: 'model_unsupported' },
      );
    }
    expect(fetches).toBe(before);
  });
});
