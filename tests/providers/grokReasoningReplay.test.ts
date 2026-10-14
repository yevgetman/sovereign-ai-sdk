import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@yevgetman/sov-sdk/config/loader';
import type { AssistantMessage, Message } from '@yevgetman/sov-sdk/core/types';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import { GrokSubscriptionProvider } from '@yevgetman/sov-sdk/providers/grok';
import { OllamaProvider } from '@yevgetman/sov-sdk/providers/ollama';
import { OpenAIProvider } from '@yevgetman/sov-sdk/providers/openai';
import { responsesInput } from '@yevgetman/sov-sdk/providers/responses';
import { routeErrorCodeFor } from '@yevgetman/sov-sdk/providers/routes/errors';
import { getRoute, validateRouteSelection } from '@yevgetman/sov-sdk/providers/routes/index';
import { subscriptionAttempt } from '@yevgetman/sov-sdk/providers/subscription/attempt';
import { SessionDb } from '../../src/agent/sessionDb.js';

const first = {
  type: 'reasoning',
  summary: [],
  encrypted_content: 'fixture-ciphertext',
  id: 'rs_first',
  status: 'completed',
  future_field: { nested: [0, false, null, { untouched: 'yes' }] },
};
const last = {
  ...first,
  id: 'rs_last',
  summary: [{ type: 'summary_text', text: 'fixture summary' }],
};
const output = [
  first,
  { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
  last,
];
const port = {
  read: async () => ({
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    expiresAt: Date.now() + 3600000,
  }),
  write: async () => {},
  delete: async () => {},
};
const wire = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));

test('Grok low -> auto resumes full reasoning through DB close/reopen in original output order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-replay-'));
  const path = join(dir, 'sessions.db');
  let db = SessionDb.open({ path });
  const session = db.createSession({ provider: 'grok', model: 'grok-4.7' });
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'fixture prompt' }] },
  ];
  const sent: Record<string, unknown>[] = [];
  const provider = new GrokSubscriptionProvider({
    port,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return wire([{ type: 'response.completed', response: { status: 'completed', output } }]);
    },
  });
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ thinking: { effort: 'low' } }));
    const low = validateRouteSelection(
      getRoute('grok-subscription', loadSettings({ path: configPath })),
      { model: 'grok-4.7', effort: 'auto' },
    );
    if (!history[0]) throw new Error('fixture missing user');
    db.saveMessage(session, history[0]);
    let assistant: AssistantMessage | undefined;
    for await (const event of provider.stream({
      model: 'grok-4.7',
      system: [],
      messages: history,
      maxTokens: 128,
      effort: low.effort,
    })) {
      if (event.type === 'assistant_message') assistant = event.message;
    }
    if (!assistant) throw new Error('missing fixture assistant');
    db.saveMessage(session, assistant);
    db.close();
    db = SessionDb.open({ path });
    const restored = db
      .loadMessages(session)
      .map(({ role, content }) => ({ role, content })) as Message[];
    const replay = responsesInput(
      { model: 'grok-4.7', system: [], messages: restored.slice(1), maxTokens: 128 },
      { replayEncryptedReasoning: true },
    );
    expect(replay).toEqual([
      first,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      last,
    ]);
    writeFileSync(configPath, '{}');
    const auto = validateRouteSelection(
      getRoute('grok-subscription', loadSettings({ path: configPath })),
      { model: 'grok-4.7', effort: 'auto' },
    );
    restored.push({ role: 'user', content: [{ type: 'text', text: 'follow up' }] });
    for await (const _ of provider.stream({
      model: 'grok-4.7',
      system: [],
      messages: restored,
      maxTokens: 128,
      effort: auto.effort,
    })) {
    }
    expect(sent.map((s) => s.reasoning)).toEqual([{ effort: 'low' }, { effort: 'high' }]);
    expect(sent.every((s) => s.store === false)).toBe(true);
    expect((sent[1]?.input as unknown[]).slice(1, 4)).toEqual(replay);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('400 reasoning contract rejection retains only bounded safe upstream diagnostics', async () => {
  let refreshes = 0;
  const error = await subscriptionAttempt({
    provider: 'grok',
    tierBlockedOn403: true,
    deps: { now: Date.now, random: () => 0, sleep: async () => {} },
    refresh: async () => {
      refreshes++;
    },
    send: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_request_error',
            message:
              "Missing required parameter: 'input[1].summary'. Bearer fixture-access; encrypted_content=fixture-ciphertext; request: fixture prompt",
            extra: 'fixture-refresh',
          },
        }),
        { status: 400 },
      ),
  }).catch((e) => e);
  expect(routeErrorCodeFor(error)).toBe('provider_request_rejected');
  expect(error.upstream).toEqual({
    status: 400,
    code: 'invalid_request_error',
    message: 'Missing required reasoning field: summary.',
  });
  expect(refreshes).toBe(0);
  for (const secret of [
    'fixture-access',
    'fixture-refresh',
    'fixture-ciphertext',
    'fixture prompt',
  ]) {
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  }
});

test('legacy lossy encrypted history is refused instead of inventing missing summary', () => {
  expect(() =>
    responsesInput(
      {
        model: 'grok-4.7',
        system: [],
        maxTokens: 128,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'encrypted_reasoning', encryptedContent: 'old-cipher' }],
          },
        ],
      },
      { replayEncryptedReasoning: true },
    ),
  ).toThrow(/Start a new session/);
});

test('authoritative terminal output never resurrects omitted streamed reasoning', async () => {
  const provider = new GrokSubscriptionProvider({
    port,
    fetchImpl: async () =>
      wire([
        { type: 'response.output_item.done', output_index: 0, item: first },
        { type: 'response.output_text.delta', output_index: 1, delta: 'answer' },
        { type: 'response.completed', response: { status: 'completed', output: [output[1]] } },
      ]),
  });
  let message: AssistantMessage | undefined;
  for await (const event of provider.stream({
    model: 'grok-4.7',
    system: [],
    maxTokens: 128,
    messages: [],
  })) {
    if (event.type === 'assistant_message') message = event.message;
  }
  expect(message?.content).toEqual([{ type: 'text', text: 'answer' }]);
});

test('reasoning requires terminal output to establish the original order', async () => {
  const provider = new GrokSubscriptionProvider({
    port,
    fetchImpl: async () =>
      wire([
        { type: 'response.output_text.delta', output_index: 1, delta: 'answer' },
        { type: 'response.output_item.done', output_index: 0, item: first },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
  });
  let stopped = false;
  await expect(
    (async () => {
      for await (const event of provider.stream({
        model: 'grok-4.7',
        system: [],
        maxTokens: 128,
        messages: [],
      })) {
        stopped ||= event.type === 'assistant_message';
      }
    })(),
  ).rejects.toThrow(/reasoning output order unavailable/);
  expect(stopped).toBe(false);
});

test('HTTP rejection diagnostics discard unknown codes, arbitrary message, malformed and huge bodies', async () => {
  for (const body of [
    JSON.stringify({
      error: {
        code: 'fixture-ciphertext',
        message: 'fixture prompt fixture-access fixture-refresh',
      },
    }),
    'fixture-access malformed HTML',
    JSON.stringify({
      error: { code: 'invalid_request_error', message: 'fixture-ciphertext'.repeat(20000) },
    }),
  ]) {
    const error = await subscriptionAttempt({
      provider: 'grok',
      tierBlockedOn403: true,
      deps: { now: Date.now, random: () => 0, sleep: async () => {} },
      refresh: async () => {},
      send: async () => new Response(body, { status: 422 }),
    }).catch((e) => e);
    expect(error.upstream).toEqual({
      status: 422,
      message: 'Upstream request failed; unsafe details were redacted.',
    });
    expect(JSON.stringify(error).length).toBeLessThan(400);
    expect(routeErrorCodeFor(error)).toBe('provider_request_rejected');
    expect(JSON.stringify(error)).not.toContain('fixture');
  }
});

test('HTTP mapped model errors retain actual upstream status and final 429 retains sanitized code', async () => {
  for (const [status, body, routeCode, upstreamCode] of [
    [
      400,
      { error: { code: 'model_not_found', message: 'model not found' } },
      'model_unsupported',
      'model_not_found',
    ],
    [
      429,
      { error: { code: 'rate_limit_exceeded', message: 'fixture prompt' } },
      'rate_limited',
      'rate_limit_exceeded',
    ],
  ] as const) {
    const error = await subscriptionAttempt({
      provider: 'grok',
      tierBlockedOn403: true,
      deps: { now: Date.now, random: () => 0, sleep: async () => {} },
      refresh: async () => {},
      send: async () => new Response(JSON.stringify(body), { status }),
    }).catch((e) => e);
    expect(routeErrorCodeFor(error)).toBe(routeCode);
    expect(error.upstream.status).toBe(status);
    expect(error.upstream.code).toBe(upstreamCode);
    expect(JSON.stringify(error)).not.toContain('fixture');
  }
});

test('direct SDK transports refuse Grok reasoning on every foreign authentication route before fetch', async () => {
  let fetches = 0;
  const fetchImpl = Object.assign(
    async () => {
      fetches++;
      throw new Error('foreign route must not fetch');
    },
    { preconnect: () => {} },
  );
  const history: Message[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'encrypted_reasoning',
          routeId: 'grok-subscription',
          encryptedContent: first.encrypted_content,
          item: first,
        },
      ],
    },
  ];
  for (const provider of [
    new OpenAIProvider({ apiKey: 'fixture', name: 'openai', fetchImpl }),
    new OpenAIProvider({ apiKey: 'fixture', name: 'xai', fetchImpl }),
    new OpenAIProvider({ apiKey: 'fixture', name: 'openrouter', fetchImpl }),
    new OllamaProvider({ fetchImpl }),
    new ChatGptSubscriptionProvider({ port, fetchImpl }),
  ]) {
    await expect(
      provider
        .stream({ model: 'gpt-5.3-codex', system: [], messages: history, maxTokens: 128 })
        .next(),
    ).rejects.toMatchObject({ code: 'unsupported_input' });
  }
  expect(fetches).toBe(0);
  expect(() =>
    responsesInput(
      {
        model: 'grok-4.7',
        system: [],
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'encrypted_reasoning',
                encryptedContent: first.encrypted_content,
                item: first,
              },
            ],
          },
        ],
        maxTokens: 128,
      },
      { replayEncryptedReasoning: true },
    ),
  ).toThrow(/incomplete/);
});

test('all subscription 4xx diagnostics stay safe without changing authentication/context semantics', async () => {
  for (const [status, code, routeCode] of [
    [401, 'authentication_error', 'auth_expired'],
    [403, 'permission_denied', 'tier_blocked'],
    [413, 'context_length_exceeded', 'context_overflow'],
  ] as const) {
    let refreshes = 0;
    const error = await subscriptionAttempt({
      provider: 'grok',
      tierBlockedOn403: true,
      deps: { now: Date.now, random: () => 0, sleep: async () => {} },
      refresh: async () => {
        refreshes++;
      },
      send: async () =>
        new Response(
          JSON.stringify({ error: { code, message: 'fixture-secret private prompt' } }),
          { status },
        ),
    }).catch((e) => e);
    expect(routeErrorCodeFor(error)).toBe(routeCode);
    expect(error.upstream).toMatchObject({ status, code });
    expect(JSON.stringify(error)).not.toContain('fixture-secret');
    expect(JSON.stringify(error)).not.toContain('private prompt');
    expect(refreshes).toBe(status === 401 ? 1 : 0);
  }
});

test('an unreadable upstream error body retains HTTP diagnostics without leaking the read error', async () => {
  const error = await subscriptionAttempt({
    provider: 'grok',
    tierBlockedOn403: true,
    deps: { now: Date.now, random: () => 0, sleep: async () => {} },
    refresh: async () => {},
    send: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('fixture-secret private prompt'));
          },
        }),
        { status: 400 },
      ),
  }).catch((e) => e);
  expect(routeErrorCodeFor(error)).toBe('provider_request_rejected');
  expect(error.upstream).toEqual({
    status: 400,
    message: 'Upstream request failed; unsafe details were redacted.',
  });
  expect(String(error)).not.toContain('fixture');
});

test('owner cancellation during an upstream failure body read remains interrupted', async () => {
  const controller = new AbortController();
  const error = await subscriptionAttempt({
    provider: 'grok',
    signal: controller.signal,
    tierBlockedOn403: true,
    deps: { now: Date.now, random: () => 0, sleep: async () => {} },
    refresh: async () => {},
    send: async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            controller.abort();
            stream.error(new DOMException('Aborted', 'AbortError'));
          },
        }),
        { status: 400 },
      ),
  }).catch((e) => e);
  expect(routeErrorCodeFor(error)).toBe('interrupted');
  expect(error.name).toBe('AbortError');
  expect(error).not.toHaveProperty('upstream');
});
