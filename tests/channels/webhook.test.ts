// Phase F-T4 (keystone) — the generic webhook adapter + its open gateway route.
//
// This is the first end-to-end proof of the whole inbound→turn→outbound arc with
// NO external dependency: a signed HTTP POST verifies via HMAC, runs ONE headless
// channel turn under the safe channel posture (F-T1), and returns the model's
// reply synchronously. The route is mounted OPEN (it authenticates via the
// channel HMAC, not the gateway's bearer/principal auth) and is reachable BEFORE
// the /sessions/* auth — exactly like /health and GET /.
//
// The tests pin the security-load-bearing contracts deterministically against a
// MockProvider runtime (no LLM variance), exercising every status code:
//   - valid signed request → 200 { reply: <MockProvider final text> }; a session
//     was created via buildSessionKey, owned by the webhook's principal, platform
//     'webhook';
//   - bad signature → 401 AND no turn ran (no session row created);
//   - missing signature header → 401;
//   - a [SILENT]-prefixed reply → 200 with no reply (silent verdict);
//   - malformed JSON body (but a VALID signature over the raw bytes) → 400;
//   - unknown / unconfigured :id → 404.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import type { ChannelsConfig } from '../../src/server/routes/channels.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

const SECRET = 'whsec_test_secret';
const PRINCIPAL = 'web-bot';
const CHANNEL_ID = 'default';

/** The channels opt threaded into buildAppWithRuntime. One enabled webhook
 *  channel bound to PRINCIPAL with SECRET. */
const CHANNELS: ChannelsConfig = {
  webhook: {
    enabled: true,
    secret: SECRET,
    principalId: PRINCIPAL,
  },
};

/** The deterministic InboundMessage the route parses from the body below — used
 *  to recompute the session key for the DB assertions. */
const INBOUND: InboundMessage = {
  channel: 'webhook',
  sender: 'u1',
  chatId: 'c1',
  chatType: 'private',
  text: 'hello',
};

/** sha256=<hex hmac-sha256 of `raw` keyed by `secret`>. Matches the header the
 *  route verifies. */
function sign(raw: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.lastMaxTokens = undefined;
  MockProvider.lastSignal = undefined;
  MockProvider.throwOnNext = undefined;
}

async function buildTestRuntime(home: string): Promise<Runtime> {
  return buildRuntime({
    cwd: home,
    harnessHome: home,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
    cronEnabled: false,
  });
}

describe('webhook channel — HMAC-verified open gateway route (F-T4)', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-webhook-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Pin HARNESS_HOME so buildRuntime's sessions.db is isolated per test — the
    // DETERMINISTIC channel session key (agent:main:webhook:…) would otherwise
    // collide across tests and dev runs sharing ~/.harness/sessions.db.
    process.env.HARNESS_HOME = home;
    resetMockProviderStatics();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('valid signed request → 200 { reply } and a session owned by the principal', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'hello', chatId: 'c1' });

    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });

    expect(res.status).toBe(200);
    // Default mock reply is "Hello world." — one stream() call, no tool loop.
    const json = (await res.json()) as { reply?: string };
    expect(json.reply).toBe('Hello world.');

    // The turn created a session via buildSessionKey, owned by the channel
    // principal, stamped platform 'webhook'.
    const sessionId = buildSessionKey(INBOUND);
    const row = runtime.sessionDb.getSession(sessionId);
    expect(row).not.toBeNull();
    expect(row?.ownerId).toBe(PRINCIPAL);
    expect(row?.platform).toBe('webhook');
  });

  test('bad signature → 401 and NO turn ran (no session created)', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'hello', chatId: 'c1' });

    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw, 'wrong-secret') },
      body: raw,
    });

    expect(res.status).toBe(401);
    // Verify BEFORE any side-effect: no session row was created.
    const sessionId = buildSessionKey(INBOUND);
    expect(runtime.sessionDb.getSession(sessionId)).toBeNull();
  });

  test('missing signature header → 401', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'hello', chatId: 'c1' });

    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });

    expect(res.status).toBe(401);
    expect(runtime.sessionDb.getSession(buildSessionKey(INBOUND))).toBeNull();
  });

  test('[SILENT]-prefixed reply → 200 with no reply', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: '[SILENT] internal note' }];
    MockProvider.resetScriptCursor();

    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'hello', chatId: 'c1' });

    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { reply?: string; silent?: boolean };
    expect(json.reply).toBeUndefined();
    expect(json.silent).toBe(true);
  });

  test('malformed JSON body (valid signature over the raw bytes) → 400', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    // Raw bytes are signed correctly, but they are not valid JSON.
    const raw = '{ this is not json';

    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });

    expect(res.status).toBe(400);
  });

  test('unknown / unconfigured channel id → 404', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'hello', chatId: 'c1' });

    const res = await app.request('/channels/webhook/does-not-exist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });

    expect(res.status).toBe(404);
  });

  test('missing required field (text) with a valid signature → 400', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', chatId: 'c1' });

    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });

    expect(res.status).toBe(400);
    expect(runtime.sessionDb.getSession(buildSessionKey(INBOUND))).toBeNull();
  });

  test('a disabled webhook channel is not routable → 404', async () => {
    const app = buildAppWithRuntime(runtime, {
      channels: { webhook: { enabled: false, secret: SECRET, principalId: PRINCIPAL } },
    });
    const raw = JSON.stringify({ sender: 'u1', text: 'hello', chatId: 'c1' });

    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });

    expect(res.status).toBe(404);
  });

  test('route is absent when channels opt is omitted → existing surface unaffected', async () => {
    const app = buildAppWithRuntime(runtime);
    const raw = JSON.stringify({ sender: 'u1', text: 'hello', chatId: 'c1' });

    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });

    // No channels configured ⇒ no route mounted ⇒ Hono 404.
    expect(res.status).toBe(404);
  });
});
