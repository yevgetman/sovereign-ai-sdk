import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
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
import { macKeychainPort } from '@yevgetman/sov-sdk/providers/subscription/keychain';
import { recordFromTokenJson } from '@yevgetman/sov-sdk/providers/subscription/oauth';
import type { SubscriptionRecord } from '@yevgetman/sov-sdk/providers/subscription/port';
import {
  exchangeUnderLock,
  loadFreshRecord,
} from '@yevgetman/sov-sdk/providers/subscription/tokens';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';
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
const provenance = {
  version: 1 as const,
  routeId: 'grok-subscription' as const,
  modelId: 'grok-4.7',
  accountBinding: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const port = {
  read: async () => ({
    accountBinding: provenance.accountBinding,
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
      { replayEncryptedReasoning: true, provenance },
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
    [401, 'authentication_error', 'provider_request_rejected'],
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

test.each(['model', 'account'] as const)(
  'Grok reasoning refuses %s changes before inference',
  async (changed) => {
    let record = {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3600000,
      accountBinding: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    let fetches = 0;
    const provider = new GrokSubscriptionProvider({
      port: {
        read: async () => record,
        write: async (_service, next) => {
          record = next as typeof record;
        },
        delete: async () => {},
      },
      fetchImpl: async () => {
        fetches++;
        return wire([{ type: 'response.completed', response: { status: 'completed', output } }]);
      },
    });
    let assistant: AssistantMessage | undefined;
    const request = { model: 'grok-4.7', system: [], messages: [], maxTokens: 128 };
    for await (const event of provider.stream(request)) {
      if (event.type === 'assistant_message') assistant = event.message;
    }
    if (!assistant) throw new Error('missing fixture assistant');
    const continuation = { ...request, messages: [assistant] };
    if (changed === 'model') continuation.model = 'grok-4.6';
    else record = { ...record, accountBinding: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    await expect(provider.stream(continuation).next()).rejects.toMatchObject({
      code: 'unsupported_input',
    });
    expect(fetches).toBe(1);
  },
);

test('Grok complete reasoning survives a real agent tool continuation', async () => {
  const sent: Record<string, unknown>[] = [];
  let calls = 0;
  const toolOutput = [
    first,
    {
      type: 'function_call',
      id: 'fc_fixture',
      call_id: 'call_fixture',
      name: 'FixtureRead',
      arguments: '{}',
    },
    last,
  ];
  const provider = new GrokSubscriptionProvider({
    port,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return wire([
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: sent.length === 1 ? toolOutput : output,
          },
        },
      ]);
    },
  });
  const agent = createAgent({
    provider,
    model: 'grok-4.7',
    effort: 'low',
    maxTurns: 2,
    tools: [
      buildTool({
        name: 'FixtureRead',
        description: () => 'Fixture read',
        inputSchema: z.object({}),
        isReadOnly: () => true,
        async call() {
          calls++;
          return { data: { value: 'fixture result' } };
        },
      }),
    ],
  });
  const gen = agent.run('fixture prompt');
  let terminal: string | undefined;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      terminal = step.value.terminal.reason;
      break;
    }
  }
  expect(terminal).toBe('completed');
  expect(calls).toBe(1);
  expect(sent).toHaveLength(2);
  expect((sent[1]?.input as unknown[]).slice(1, 4)).toEqual([
    first,
    { type: 'function_call', call_id: 'call_fixture', name: 'FixtureRead', arguments: '{}' },
    last,
  ]);
  expect((sent[1]?.input as { type: string }[])[4]?.type).toBe('function_call_output');
  expect(sent.every((request) => request.store === false)).toBe(true);
});

test('legacy credential lineage initializes once under lock and survives token refresh', async () => {
  let record: SubscriptionRecord = {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    expiresAt: Date.now() + 3600000,
  };
  let writes = 0;
  const memory = {
    read: async () => ({ ...record }),
    write: async (_service: string, next: SubscriptionRecord) => {
      writes++;
      record = next;
    },
    delete: async () => {},
  };
  const load = () =>
    loadFreshRecord(
      'grok',
      'fixture-grok',
      memory,
      Date.now,
      async () => {
        throw new Error('fresh tokens must not refresh');
      },
      { ensureAccountBinding: true },
    );
  const [a, b] = await Promise.all([load(), load()]);
  expect(writes).toBe(1);
  expect(a.accountBinding).toMatch(/^[a-f0-9-]{36}$/);
  expect(b.accountBinding).toBe(a.accountBinding);
  const refreshed = await exchangeUnderLock(
    'grok',
    'fixture-grok',
    memory,
    async () => ({
      accessToken: 'fixture-new-access',
      refreshToken: 'fixture-new-refresh',
      expiresAt: Date.now() + 3600000,
      accountBinding: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
    a,
  );
  expect(refreshed.accountBinding).toBe(a.accountBinding);
  expect(record.accountBinding).toBe(a.accountBinding);
  const parsed = await macKeychainPort({
    account: 'fixture',
    exec: async () => ({ stdout: JSON.stringify(record), code: 0 }),
  }).read('fixture-grok');
  expect(parsed?.accountBinding).toBe(a.accountBinding);
  const loginA = recordFromTokenJson(
    'grok',
    { access_token: 'fixture-a', refresh_token: 'fixture-b' },
    Date.now(),
    '',
  );
  const loginB = recordFromTokenJson(
    'grok',
    { access_token: 'fixture-a', refresh_token: 'fixture-b' },
    Date.now(),
    '',
  );
  expect(loginA.accountBinding).toMatch(/^[a-f0-9-]{36}$/);
  expect(loginB.accountBinding).not.toBe(loginA.accountBinding);
});

test('unpersistable or invalid credential lineage fails closed before inference', async () => {
  for (const invalid of [undefined, 'fixture-secret']) {
    let fetches = 0;
    const provider = new GrokSubscriptionProvider({
      port: {
        read: async () => ({
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          expiresAt: Date.now() + 3600000,
          ...(invalid ? { accountBinding: invalid } : {}),
        }),
        write: async () => {
          throw new Error('fixture failed write');
        },
        delete: async () => {},
      },
      fetchImpl: async () => {
        fetches++;
        throw new Error('must not fetch');
      },
    });
    await expect(
      provider.stream({ model: 'grok-4.7', system: [], messages: [], maxTokens: 128 }).next(),
    ).rejects.toThrow();
    expect(fetches).toBe(0);
  }
});

test('legacy reasoning without provenance refuses replay even with a complete item', () => {
  expect(() =>
    responsesInput(
      {
        model: 'grok-4.7',
        system: [],
        maxTokens: 128,
        messages: [
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
        ],
      },
      { replayEncryptedReasoning: true, provenance },
    ),
  ).toThrow(/Start a new session/);
});
