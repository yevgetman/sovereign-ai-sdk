import { expect, test } from 'bun:test';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import { GrokSubscriptionProvider } from '@yevgetman/sov-sdk/providers/grok';
import { routeErrorCodeFor } from '@yevgetman/sov-sdk/providers/routes/errors';
import type { SubscriptionRecord } from '@yevgetman/sov-sdk/providers/subscription/port';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

const now = 1_800_000_000_000;
const secret = 'refresh-secret-do-not-report';
const initial = (proactive: boolean): SubscriptionRecord => ({
  accessToken: 'access-secret',
  refreshToken: secret,
  expiresAt: now + (proactive ? 1 : 3_600_000),
  accountBinding: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
});
const req: ProviderRequest = {
  model: 'gpt-5.3-codex',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 16,
};
async function capture(run: () => Promise<unknown>) {
  try {
    await run();
    throw new Error('expected refresh failure');
  } catch (err) {
    return err;
  }
}
for (const providerName of ['chatgpt', 'grok'] as const) {
  for (const proactive of [true, false]) {
    for (const scenario of [
      {
        name: 'rate limit',
        status: 429,
        body: { error: secret },
        code: 'rate_limited',
        reason: 'rate_limited',
        calls: 3,
      },
      {
        name: 'unavailable',
        status: 503,
        body: { error: secret },
        code: 'provider_unavailable',
        reason: 'provider_unavailable',
        calls: 3,
      },
      {
        name: 'connection',
        status: 0,
        body: {},
        code: 'provider_unavailable',
        reason: 'connection_failure',
        calls: 3,
      },
      {
        name: 'response connection',
        status: -2,
        body: {},
        code: 'provider_unavailable',
        reason: 'connection_failure',
        calls: 3,
      },
      {
        name: 'timeout',
        status: -1,
        body: {},
        code: 'provider_timeout',
        reason: 'timeout',
        calls: 1,
      },
      {
        name: 'invalid grant',
        status: 400,
        body: { error: 'invalid_grant', error_description: secret },
        code: 'auth_expired',
        reason: undefined,
        calls: 1,
      },
      {
        name: 'malformed',
        status: 200,
        body: { arbitrary: secret },
        code: 'provider_response_invalid',
        reason: 'malformed_response',
        calls: 1,
      },
    ] as const) {
      test(`${providerName} ${proactive ? 'proactive' : '401'} refresh preserves ${scenario.name}`, async () => {
        let record = initial(proactive);
        let writes = 0;
        let refreshCalls = 0;
        let modelCalls = 0;
        const sleeps: number[] = [];
        const Provider =
          providerName === 'chatgpt' ? ChatGptSubscriptionProvider : GrokSubscriptionProvider;
        const provider = new Provider({
          port: {
            async read() {
              return record;
            },
            async write(_key, next) {
              writes++;
              record = next;
            },
            async delete() {},
          },
          deps: {
            now: () => now,
            random: () => 0,
            sleep: async (ms) => {
              sleeps.push(ms);
            },
          },
          fetchImpl: async (url) => {
            if (!String(url).includes('/token')) {
              modelCalls++;
              return new Response('', { status: 401 });
            }
            refreshCalls++;
            if (scenario.status === -1) throw new DOMException(secret, 'TimeoutError');
            if (scenario.status === -2)
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(new TypeError(secret));
                  },
                }),
              );
            if (!scenario.status) throw new TypeError(secret);
            return new Response(JSON.stringify(scenario.body), { status: scenario.status });
          },
        });
        const err = await capture(async () => {
          for await (const _event of provider.stream({
            ...req,
            model: providerName === 'grok' ? 'grok-4.7' : req.model,
          })) {
          }
        });
        expect(routeErrorCodeFor(err)).toBe(scenario.code);
        if (scenario.reason)
          expect(err).toMatchObject({ name: 'SubscriptionRefreshError', reason: scenario.reason });
        expect(String(err)).not.toContain(secret);
        expect(refreshCalls).toBe(scenario.calls);
        expect(modelCalls).toBe(proactive ? 0 : 1);
        expect(writes).toBe(0);
        expect(record).toEqual(initial(proactive));
        expect(sleeps).toEqual(scenario.calls === 3 ? [500, 1500] : []);
      });
    }
  }
}

for (const proactive of [true, false]) {
  for (const mode of [
    'retry-success',
    'retry-after',
    'over-limit',
    'cancel',
    'store-read',
    'store-write',
    'malformed-json',
    'large-body',
  ] as const) {
    test(`${proactive ? 'proactive' : '401'} refresh ${mode}`, async () => {
      const before = { ...initial(proactive), accountBinding: undefined };
      const { accountBinding: _binding, ...legacy } = before;
      let record: SubscriptionRecord = legacy;
      let exchanges = 0;
      let writes = 0;
      const waits: number[] = [];
      const controller = new AbortController();
      const provider = new ChatGptSubscriptionProvider({
        port: {
          async read() {
            if (mode === 'store-read') throw new Error(secret);
            return record;
          },
          async write(_key, next) {
            if (mode === 'store-write') throw new Error(secret);
            record = next;
            writes++;
          },
          async delete() {},
        },
        deps: {
          now: () => now,
          random: () => 0,
          sleep: async (ms) => {
            waits.push(ms);
            if (mode === 'cancel') controller.abort();
          },
        },
        fetchImpl: async (url) => {
          if (!String(url).includes('/token')) {
            if (exchanges)
              return new Response(
                'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
              );
            return new Response('', { status: 401 });
          }
          exchanges++;
          if (mode === 'large-body')
            return new Response(JSON.stringify({ access_token: secret.repeat(4000) }));
          if (mode === 'malformed-json') return new Response(secret);
          if (mode === 'over-limit')
            return new Response(secret, { status: 429, headers: { 'retry-after': '11' } });
          if (
            mode === 'cancel' ||
            ((mode === 'retry-success' || mode === 'retry-after') && exchanges === 1)
          )
            return new Response(secret, {
              status: 429,
              headers: mode === 'retry-after' ? { 'retry-after': '2' } : {},
            });
          return new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
          );
        },
      });
      if (mode === 'retry-success' || mode === 'retry-after') {
        for await (const _event of provider.stream({ ...req, signal: controller.signal })) {
        }
        expect(exchanges).toBe(2);
        expect(waits).toEqual([mode === 'retry-after' ? 2000 : 500]);
        expect(writes).toBe(proactive ? 1 : 2);
        expect(record.accessToken).toBe('new-access');
        expect(record.accountBinding).toBeDefined();
      } else {
        const err = await capture(async () => {
          for await (const _event of provider.stream({ ...req, signal: controller.signal })) {
          }
        });
        const code =
          mode === 'cancel'
            ? 'interrupted'
            : mode.startsWith('store-')
              ? 'credential_unavailable'
              : mode === 'over-limit'
                ? 'rate_limited'
                : 'provider_response_invalid';
        expect(routeErrorCodeFor(err)).toBe(code);
        expect(String(err)).not.toContain(secret);
        // A fresh legacy record must acquire its binding before inference;
        // proactive failures must leave even that legacy record unchanged.
        if (proactive || mode === 'store-read' || mode === 'store-write') expect(writes).toBe(0);
        if (proactive) expect(record).toEqual(legacy);
        expect(exchanges).toBe(
          mode.startsWith('store-') && !proactive ? 0 : mode === 'store-read' ? 0 : 1,
        );
        expect(waits).toEqual(mode === 'cancel' ? [500] : []);
      }
    });
  }
}

test('one 20s refresh deadline covers all attempts and a hung response in both paths', async () => {
  await Promise.all(
    [true, false].map(async (proactive) => {
      const Provider = proactive ? ChatGptSubscriptionProvider : GrokSubscriptionProvider;
      const before = initial(proactive);
      let writes = 0;
      let exchanges = 0;
      let aborted = false;
      const started = Date.now();
      const provider = new Provider({
        port: {
          async read() {
            return before;
          },
          async write() {
            writes++;
          },
          async delete() {},
        },
        deps: { now: () => now, random: () => 0, sleep: async () => {} },
        fetchImpl: async (url, options) => {
          if (!String(url).includes('/token')) return new Response('', { status: 401 });
          exchanges++;
          if (exchanges === 1) return new Response('', { status: 503 });
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          return new Promise<Response>(() => {});
        },
      });
      const err = await capture(async () => {
        for await (const _event of provider.stream({
          ...req,
          model: proactive ? req.model : 'grok-4.7',
        })) {
        }
      });
      expect(err).toMatchObject({ name: 'SubscriptionRefreshError', reason: 'timeout' });
      expect(routeErrorCodeFor(err)).toBe('provider_timeout');
      expect(Date.now() - started).toBeLessThan(22_000);
      expect(aborted).toBe(true);
      expect(writes).toBe(0);
      expect(exchanges).toBe(2);
    }),
  );
}, 25_000);
