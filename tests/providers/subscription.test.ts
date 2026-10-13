// Subscription logins: fake HTTP and a fake Keychain. No live OAuth.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChatGptSubscriptionProvider } from '@yevgetman/sov-sdk/providers/chatgpt';
import { assertCodexUrl } from '@yevgetman/sov-sdk/providers/chatgpt';
import { ClaudeMaxSubscriptionProvider } from '@yevgetman/sov-sdk/providers/claudeMax';
import {
  ClaudeMaxTermsError,
  CredentialUnavailableError,
  SubscriptionAuthExpiredError,
  SubscriptionTierBlockedError,
} from '@yevgetman/sov-sdk/providers/errors';
import { GrokSubscriptionProvider } from '@yevgetman/sov-sdk/providers/grok';
import { resolveProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { AttemptDeps } from '@yevgetman/sov-sdk/providers/subscription/attempt';
import { macKeychainPort } from '@yevgetman/sov-sdk/providers/subscription/keychain';
import { loadSubscriptionProvider } from '@yevgetman/sov-sdk/providers/subscription/load';
import {
  advanceCredentialGeneration,
  withCredentialLock,
} from '@yevgetman/sov-sdk/providers/subscription/lock';
import {
  loginSubscription,
  logoutSubscription,
} from '@yevgetman/sov-sdk/providers/subscription/login';
import { KEYCHAIN_SERVICE } from '@yevgetman/sov-sdk/providers/subscription/names';
import type {
  SubscriptionCredentialPort,
  SubscriptionFetch,
  SubscriptionRecord,
} from '@yevgetman/sov-sdk/providers/subscription/port';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

const NOW = 1_800_000_000_000;
const SECRET = 'super-secret-access';

function record(): SubscriptionRecord {
  return { accessToken: SECRET, refreshToken: 'refresh-token', expiresAt: NOW + 3_600_000 };
}

function memoryPort(initial?: SubscriptionRecord): SubscriptionCredentialPort & { reads: number } {
  let current = initial ? { ...initial } : null;
  const port = {
    reads: 0,
    async read() {
      port.reads += 1;
      return current ? { ...current } : null;
    },
    async write(_service: string, next: SubscriptionRecord) {
      current = { ...next };
    },
    async delete() {
      current = null;
    },
  };
  return port;
}

function deps(sleeps: number[]): AttemptDeps {
  return {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    now: () => NOW,
  };
}

const req: ProviderRequest = {
  model: 'gpt-5.3-codex',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 16,
};

function orderedPort(
  order: string[],
  initial: SubscriptionRecord | null,
): SubscriptionCredentialPort {
  let current = initial ? { ...initial } : null;
  return {
    async read() {
      return current ? { ...current } : null;
    },
    async write(_service, next) {
      order.push('write');
      current = { ...next };
    },
    async delete() {
      order.push('delete');
      current = null;
    },
  };
}

function silentLoginIo(fetchImpl: SubscriptionFetch) {
  return {
    stdout: () => {},
    stderr: () => {},
    openUrl: () => {},
    sleep: async () => {},
    now: () => NOW,
    fetchImpl,
  };
}

function chatgptLoginIo() {
  let step = 0;
  return silentLoginIo(async () => {
    step += 1;
    if (step === 1) {
      return jsonResponse(200, { user_code: 'ABCD-EFGH', device_auth_id: 'dev1', interval: 1 });
    }
    if (step === 2) return new Response('pending', { status: 404 });
    if (step === 3) {
      return jsonResponse(200, { authorization_code: 'code1', code_verifier: 'ver1' });
    }
    return jsonResponse(200, {
      access_token: SECRET,
      refresh_token: 'refresh-token',
      expires_in: 3600,
    });
  });
}

function grokLoginIo() {
  let step = 0;
  return silentLoginIo(async () => {
    step += 1;
    if (step === 1) {
      return jsonResponse(200, { token_endpoint: 'https://auth.x.ai/oauth2/token' });
    }
    if (step === 2) {
      return jsonResponse(200, {
        device_code: 'device1',
        user_code: 'GROK-CODE',
        verification_uri: 'https://auth.x.ai/device',
        interval: 1,
        expires_in: 60,
      });
    }
    return jsonResponse(200, {
      access_token: SECRET,
      refresh_token: 'grok-refresh',
      expires_in: 3600,
    });
  });
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseOk(): Response {
  const raw = [
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
    '',
  ].join('\n');
  return new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(provider: ChatGptSubscriptionProvider | GrokSubscriptionProvider) {
  const events = [];
  for await (const event of provider.stream(req)) events.push(event);
  return events;
}

describe('subscription fence', () => {
  test('resolveProvider(chatgpt) does no HTTP without the flag', async () => {
    let called = false;
    const fetchImpl: SubscriptionFetch = async () => {
      called = true;
      throw new Error('http');
    };
    expect(() => resolveProvider('chatgpt', 'gpt-5.3-codex', { settings: {}, fetchImpl })).toThrow(
      CredentialUnavailableError,
    );
    expect(called).toBe(false);
  });

  test('a gateway principal does not read the port', async () => {
    const port = memoryPort(record());
    expect(() => loadSubscriptionProvider('chatgpt', port, { principal: 'gateway' })).toThrow(
      CredentialUnavailableError,
    );
    expect(port.reads).toBe(0);
  });

  test('claude-max refuses before the port and before HTTP', async () => {
    const port = memoryPort(record());
    let called = false;
    expect(() =>
      loadSubscriptionProvider('claude-max', port, {
        fetchImpl: async () => {
          called = true;
          throw new Error('http');
        },
      }),
    ).toThrow(ClaudeMaxTermsError);
    expect(port.reads).toBe(0);
    expect(called).toBe(false);
    const provider = new ClaudeMaxSubscriptionProvider();
    await expect(provider.stream(req).next()).rejects.toBeInstanceOf(ClaudeMaxTermsError);
  });

  test('allowSubscriptionAuth metadata has no token', () => {
    const port = memoryPort(record());
    const resolved = resolveProvider('chatgpt', undefined, {
      settings: {},
      allowSubscriptionAuth: true,
      subscriptionPort: port,
    });
    expect(resolved.authType).toBe('oauth');
    expect(resolved.metadata.auth).toBe('subscription');
    expect(JSON.stringify(resolved.metadata)).not.toContain(SECRET);
    expect(resolved.model).toBe('gpt-5.3-codex');
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
  });
});

describe('chatgpt provider', () => {
  test('never requests api.openai.com', async () => {
    const urls: string[] = [];
    const fetchImpl: SubscriptionFetch = async (input) => {
      const url = String(input);
      urls.push(url);
      return sseOk();
    };
    const provider = new ChatGptSubscriptionProvider({
      port: memoryPort(record()),
      fetchImpl,
      deps: deps([]),
    });
    await drain(provider);
    expect(urls).toEqual(['https://chatgpt.com/backend-api/codex/responses']);
    expect(urls.some((url) => url.includes('api.openai.com'))).toBe(false);
  });

  test('429 then 200 retries once', async () => {
    const urls: string[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl: SubscriptionFetch = async (input) => {
      urls.push(String(input));
      n += 1;
      if (n === 1) return new Response('busy', { status: 429 });
      return sseOk();
    };
    const provider = new ChatGptSubscriptionProvider({
      port: memoryPort(record()),
      fetchImpl,
      deps: deps(sleeps),
    });
    await drain(provider);
    expect(urls.length).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  test('401 with a failed refresh does not call the model again', async () => {
    const urls: string[] = [];
    const fetchImpl: SubscriptionFetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('oauth/token')) return jsonResponse(500, { error: 'nope' });
      return new Response('no', { status: 401 });
    };
    const provider = new ChatGptSubscriptionProvider({
      port: memoryPort(record()),
      fetchImpl,
      deps: deps([]),
    });
    await expect(drain(provider)).rejects.toBeInstanceOf(SubscriptionAuthExpiredError);
    expect(urls.filter((url) => url.includes('codex/responses')).length).toBe(1);
    expect(urls.filter((url) => url.includes('oauth/token')).length).toBe(1);
    expect(urls.some((url) => url.includes('api.openai.com'))).toBe(false);
  });

  test('abort during backoff makes no further attempt', async () => {
    const urls: string[] = [];
    const fetchImpl: SubscriptionFetch = async (input) => {
      urls.push(String(input));
      return new Response('busy', { status: 429 });
    };
    const provider = new ChatGptSubscriptionProvider({
      port: memoryPort(record()),
      fetchImpl,
      deps: {
        sleep: async () => {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
        random: () => 0,
        now: () => NOW,
      },
    });
    await expect(
      provider.stream({ ...req, signal: new AbortController().signal }).next(),
    ).rejects.toThrow(/abort/i);
    expect(urls.length).toBe(1);
  });

  test('Retry-After over 10 seconds does not wait', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: SubscriptionFetch = async () => {
      calls += 1;
      return new Response('busy', { status: 429, headers: { 'retry-after': '11' } });
    };
    const provider = new ChatGptSubscriptionProvider({
      port: memoryPort(record()),
      fetchImpl,
      deps: deps(sleeps),
    });
    await expect(drain(provider)).rejects.toThrow(/HTTP 429/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('an empty stream is retried', async () => {
    let n = 0;
    const fetchImpl: SubscriptionFetch = async () => {
      n += 1;
      if (n === 1) return new Response(null, { status: 200, headers: { 'content-length': '0' } });
      return sseOk();
    };
    const provider = new ChatGptSubscriptionProvider({
      port: memoryPort(record()),
      fetchImpl,
      deps: deps([]),
    });
    await drain(provider);
    expect(n).toBe(2);
  });

  test('assertCodexUrl rejects the API host', () => {
    expect(() => assertCodexUrl('https://api.openai.com/v1/responses')).toThrow(/chatgpt.com/);
  });
});

describe('grok provider', () => {
  test('HTTP 403 does not send a second request', async () => {
    const urls: string[] = [];
    const fetchImpl: SubscriptionFetch = async (input, init) => {
      urls.push(String(input));
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
      expect(JSON.stringify(init)).not.toContain('XAI_API_KEY');
      return new Response('no', { status: 403 });
    };
    const provider = new GrokSubscriptionProvider({
      port: memoryPort(record()),
      fetchImpl,
      deps: deps([]),
    });
    const error = await provider
      .stream({ ...req, model: 'grok-4.6' })
      .next()
      .then(
        () => {
          throw new Error('expected a throw');
        },
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(SubscriptionTierBlockedError);
    expect((error as Error).message).toBe(
      'This login tier cannot use the HTTP path. An API-key provider is a separate explicit choice.',
    );
    expect(urls).toEqual(['https://api.x.ai/v1/responses']);
  });
});

describe('keychain adapter', () => {
  test('a write failure does not include the secret', async () => {
    const port = macKeychainPort({
      account: 'julie',
      exec: async () => ({ stdout: SECRET, code: 1 }),
    });
    await expect(port.write('SOV_SUB_CHATGPT', record())).rejects.toThrow(
      'keychain write failed for SOV_SUB_CHATGPT',
    );
  });

  test('a missing item is null', async () => {
    const port = macKeychainPort({
      account: 'julie',
      exec: async () => ({ stdout: '', code: 44 }),
    });
    expect(await port.read('SOV_SUB_GROK')).toBeNull();
  });
});

describe('login and logout', () => {
  test('chatgpt login writes the record and prints no token', async () => {
    const port = memoryPort();
    const urls: string[] = [];
    let step = 0;
    const stdout: string[] = [];
    const opened: string[] = [];
    const code = await loginSubscription('chatgpt', port, {
      stdout: (text) => stdout.push(text),
      stderr: () => {},
      openUrl: (url) => opened.push(url),
      sleep: async () => {},
      now: () => NOW,
      fetchImpl: async (input) => {
        urls.push(String(input));
        step += 1;
        if (step === 1) {
          return jsonResponse(200, { user_code: 'ABCD-EFGH', device_auth_id: 'dev1', interval: 1 });
        }
        if (step === 2) return new Response('pending', { status: 404 });
        if (step === 3) {
          return jsonResponse(200, { authorization_code: 'code1', code_verifier: 'ver1' });
        }
        return jsonResponse(200, {
          access_token: SECRET,
          refresh_token: 'refresh-token',
          expires_in: 3600,
        });
      },
    });
    expect(code).toBe(0);
    expect(opened).toEqual(['https://auth.openai.com/codex/device']);
    expect(stdout.join('')).not.toContain(SECRET);
    expect(urls.some((url) => url.includes('api.openai.com'))).toBe(false);
    const saved = await port.read('SOV_SUB_CHATGPT');
    expect(saved?.accessToken).toBe(SECRET);
  });

  test('a throwing identity hook does not roll back a committed chatgpt or grok credential', async () => {
    const order: string[] = [];
    const port = orderedPort(order, {
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      expiresAt: NOW + 1000,
    });
    const code = await loginSubscription('chatgpt', port, chatgptLoginIo(), {
      onIdentityChanged() {
        order.push('hook');
        throw new Error('catalog clear failed');
      },
    });
    expect(code).toBe(1);
    expect(order).toEqual(['write', 'hook']);
    expect((await port.read('SOV_SUB_CHATGPT'))?.accessToken).toBe(SECRET);

    const grokOrder: string[] = [];
    const grokPort = orderedPort(grokOrder, {
      accessToken: 'old-grok',
      refreshToken: 'old-grok-refresh',
      expiresAt: NOW + 1000,
    });
    const grokCode = await loginSubscription('grok', grokPort, grokLoginIo(), {
      onIdentityChanged() {
        grokOrder.push('hook');
        throw new Error('catalog clear failed');
      },
    });
    expect(grokCode).toBe(1);
    expect(grokOrder).toEqual(['write', 'hook']);
    expect((await grokPort.read('SOV_SUB_GROK'))?.accessToken).toBe(SECRET);
  });

  test('a generation change before the login write commits does not clear the catalog', async () => {
    const port = memoryPort({
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      expiresAt: NOW + 1000,
    });
    const catalog = { id: 'gpt-5.3-codex', cleared: false };
    let step = 0;
    let hookCalls = 0;
    const code = await loginSubscription(
      'chatgpt',
      port,
      silentLoginIo(async () => {
        step += 1;
        if (step === 1) {
          return jsonResponse(200, {
            user_code: 'ABCD-EFGH',
            device_auth_id: 'dev1',
            interval: 1,
          });
        }
        if (step === 2) return new Response('pending', { status: 404 });
        if (step === 3) {
          return jsonResponse(200, { authorization_code: 'code1', code_verifier: 'ver1' });
        }
        // A refresh advances the generation under the credential lock before this write.
        await withCredentialLock(KEYCHAIN_SERVICE.chatgpt, port, () =>
          advanceCredentialGeneration(port, KEYCHAIN_SERVICE.chatgpt),
        );
        return jsonResponse(200, {
          access_token: SECRET,
          refresh_token: 'rotated',
          expires_in: 3600,
        });
      }),
      {
        onIdentityChanged() {
          hookCalls += 1;
          catalog.cleared = true;
        },
      },
    );
    expect(code).toBe(1);
    expect(hookCalls).toBe(0);
    expect(catalog.cleared).toBe(false);
    expect(catalog.id).toBe('gpt-5.3-codex');
    expect((await port.read(KEYCHAIN_SERVICE.chatgpt))?.accessToken).toBe('old-token');
  });

  test('a credential write failure after device approval does not clear the catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-login-catalog-'));
    const catalogFile = join(
      root,
      'model-catalog',
      'subscription',
      'chatgpt-subscription',
      'seed.json',
    );
    mkdirSync(dirname(catalogFile), { recursive: true });
    writeFileSync(catalogFile, '{"id":"gpt-5.3-codex"}\n');
    const backing = memoryPort({
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      expiresAt: NOW + 1000,
    });
    let writes = 0;
    let hookCalls = 0;
    const port: SubscriptionCredentialPort = {
      read: (key) => backing.read(key),
      delete: (key) => backing.delete(key),
      write: async () => {
        writes += 1;
        throw new Error('keychain write failed');
      },
    };
    try {
      const code = await loginSubscription('chatgpt', port, chatgptLoginIo(), {
        onIdentityChanged() {
          hookCalls += 1;
          rmSync(dirname(catalogFile), { recursive: true, force: true });
        },
      });
      expect(writes).toBe(1);
      expect(code).toBe(1);
      expect(hookCalls).toBe(0);
      expect(existsSync(catalogFile)).toBe(true);
      expect((await port.read(KEYCHAIN_SERVICE.chatgpt))?.accessToken).toBe('old-token');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('logout during attended login prevents a late approval from restoring credentials', async () => {
    const port = memoryPort();
    let announce: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const approved = new Promise<void>((resolve) => {
      release = resolve;
    });
    let step = 0;
    const io = {
      stdout: () => {},
      stderr: () => {},
      openUrl: () => {},
      sleep: async () => {},
      now: () => NOW,
      fetchImpl: async () => {
        step += 1;
        if (step === 1)
          return jsonResponse(200, { user_code: 'ABCD', device_auth_id: 'dev1', interval: 1 });
        if (step === 2) {
          announce();
          await approved;
          return jsonResponse(200, { authorization_code: 'code1', code_verifier: 'ver1' });
        }
        return jsonResponse(200, {
          access_token: SECRET,
          refresh_token: 'rotated',
          expires_in: 3600,
        });
      },
    };
    const login = loginSubscription('chatgpt', port, io);
    await started;
    expect(await logoutSubscription('chatgpt', port, io)).toBe(0);
    release();
    expect(await login).toBe(1);
    expect(await port.read('SOV_SUB_CHATGPT')).toBeNull();
  });

  test('claude-max login does no HTTP and writes nothing', async () => {
    const port = memoryPort();
    let called = false;
    const stderr: string[] = [];
    const code = await loginSubscription('claude-max', port, {
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      openUrl: () => {},
      sleep: async () => {},
      now: () => NOW,
      fetchImpl: async () => {
        called = true;
        throw new Error('http');
      },
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(port.reads).toBe(0);
    expect(stderr.join('')).toContain('Claude Max');
  });

  test('logout deletes the item', async () => {
    const deleted: string[] = [];
    const port: SubscriptionCredentialPort = {
      read: async () => record(),
      write: async () => {},
      delete: async (service) => {
        deleted.push(service);
      },
    };
    const code = await logoutSubscription('grok', port, {
      stdout: () => {},
      stderr: () => {},
      openUrl: () => {},
      sleep: async () => {},
      now: () => NOW,
      fetchImpl: fetch,
    });
    expect(code).toBe(0);
    expect(deleted).toEqual(['SOV_SUB_GROK']);
  });
});
