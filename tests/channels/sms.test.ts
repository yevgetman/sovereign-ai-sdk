// SMS channel (Twilio) — the open gateway route + the pure adapter pieces.
//
// SMS is the Slack adapter's shape (open webhook + signature verify + ack-fast-
// then-async reply via an injected transport) PLUS the SMS-specific security
// model: a phone number is PUBLICLY TEXTABLE, so the Twilio signature only
// authenticates the TRANSPORT — an inbound only drives a turn if its `From` is
// in an explicit sender→principal ALLOW-LIST (D4, the security gate). These
// tests pin the security-load-bearing contracts deterministically against a
// MockProvider runtime + an INJECTED mock SmsTransport:
//   - valid signature + ALLOWED sender → 200 ACK; the background turn runs and
//     transport.sendMessage(<from>, <reply>) is called; a session owned by the
//     sender's mapped principal exists (platform 'sms');
//   - bad/missing signature → 403, no turn, no send (the #1 transport gate);
//   - UNLISTED sender (valid signature) → no turn / no session / no reply (the
//     #1 sender gate — an unknown number never drives a turn);
//   - per-sender→principal isolation (distinct principals own distinct sessions);
//   - STOP/UNSUBSCRIBE → opt-out recorded, no turn, subsequent messages not
//     delivered until START; HELP → static helpText, no turn; START → re-opt-in;
//   - unsafe `From` (not E.164-ish) → rejected, no turn;
//   - ack-fast confirmed (200 returns before the turn completes).
//
// The verified Twilio signature scheme is also pinned with a KNOWN TEST VECTOR
// taken from Twilio's official security docs so the verify impl can't drift.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SmsTransport } from '../../src/channels/adapters/sms.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import type { ChannelsConfig, ChannelsDeps } from '../../src/server/routes/channels.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

const AUTH_TOKEN = 'twilio_auth_tok_never_logged';
const ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const FROM_NUMBER = '+15550009999';
const ALLOWED = '+15551234567';
const ALLOWED_2 = '+15557654321';
const UNLISTED = '+15550000000';
const PRINCIPAL = 'sms-owner';
const PRINCIPAL_2 = 'sms-owner-2';

const CHANNELS: ChannelsConfig = {
  sms: {
    enabled: true,
    provider: 'twilio',
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    fromNumber: FROM_NUMBER,
    senders: { [ALLOWED]: PRINCIPAL, [ALLOWED_2]: PRINCIPAL_2 },
    helpText: 'Reply with a question. STOP to unsubscribe.',
  },
};

/** Recompute the deterministic session key for a given From — SMS maps both
 *  sender and chatId to the From number, chatType 'private'. */
function inboundFor(from: string): InboundMessage {
  return { channel: 'sms', sender: from, chatId: from, chatType: 'private', text: 'hi' };
}

/** A controllable mock SmsTransport. Records every sendMessage. */
function makeMockTransport(): {
  transport: SmsTransport;
  sent: Array<{ to: string; body: string }>;
} {
  const sent: Array<{ to: string; body: string }> = [];
  const transport: SmsTransport = {
    async sendMessage(to: string, body: string): Promise<void> {
      sent.push({ to, body });
    },
  };
  return { transport, sent };
}

/** Collect in-flight background promises so the test can deterministically await
 *  the async send the route schedules after the fast ACK. */
function makeBackgroundCollector(): {
  onBackgroundTask: (p: Promise<void>) => void;
  drain: () => Promise<void>;
} {
  const inflight: Array<Promise<void>> = [];
  return {
    onBackgroundTask: (p: Promise<void>) => {
      inflight.push(p);
    },
    drain: async () => {
      await Promise.all(inflight.splice(0));
    },
  };
}

/** The base URL Hono's test harness uses for a path-only request. The route
 *  reconstructs the public URL Twilio signed; in the test harness c.req.url is
 *  `http://localhost<path>`, so the signature is computed over that. */
const TEST_URL = 'http://localhost/channels/sms';

/** Compute the Twilio `X-Twilio-Signature` for a form-encoded POST: base64 of
 *  HMAC-SHA1(authToken, url + sorted(key+value)). Mirrors the documented +
 *  SDK-confirmed scheme. `params` is the decoded field map. */
function twilioSign(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/** Build a form-urlencoded inbound SMS body + its matching signature. */
function inboundForm(opts: {
  from: string;
  body: string;
  to?: string;
  messageSid?: string;
  authToken?: string;
  url?: string;
}): { raw: string; signature: string; params: Record<string, string> } {
  const params: Record<string, string> = {
    From: opts.from,
    To: opts.to ?? FROM_NUMBER,
    Body: opts.body,
    MessageSid: opts.messageSid ?? 'SM00000000000000000000000000000001',
    AccountSid: ACCOUNT_SID,
  };
  const raw = new URLSearchParams(params).toString();
  const signature = twilioSign(opts.url ?? TEST_URL, params, opts.authToken ?? AUTH_TOKEN);
  return { raw, signature, params };
}

function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.streamCalls = 0;
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

function postSms(
  app: ReturnType<typeof buildAppWithRuntime>,
  raw: string,
  signature: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (signature !== undefined) headers['X-Twilio-Signature'] = signature;
  return Promise.resolve(app.request('/channels/sms', { method: 'POST', headers, body: raw }));
}

describe('sms channel — Twilio-signature-verified webhook route', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-sms-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
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

  test('valid signature + allowed sender → 200 ACK, async send, session owned by mapped principal', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const { raw, signature } = inboundForm({ from: ALLOWED, body: 'hello there' });
    const res = await postSms(app, raw, signature);

    // ACK fast (TwiML/empty 200).
    expect(res.status).toBe(200);

    // The scheduled background turn + send resolves.
    await drain();

    // MockProvider default reply is "Hello world." — sent back to the From.
    expect(sent).toEqual([{ to: ALLOWED, body: 'Hello world.' }]);

    // The turn created a session via buildSessionKey, owned by the mapped
    // principal, stamped platform 'sms'.
    const row = runtime.sessionDb.getSession(buildSessionKey(inboundFor(ALLOWED)));
    expect(row).not.toBeNull();
    expect(row?.ownerId).toBe(PRINCIPAL);
    expect(row?.platform).toBe('sms');
    expect(MockProvider.streamCalls).toBe(1);
  });

  test('bad signature → 403, no turn, no send', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const { raw } = inboundForm({ from: ALLOWED, body: 'hello there' });
    // Sign with the WRONG token.
    const badSig = twilioSign(TEST_URL, { From: ALLOWED, Body: 'hello there' }, 'wrong-token');
    const res = await postSms(app, raw, badSig);

    expect(res.status).toBe(403);
    await drain();
    expect(sent).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
    expect(runtime.sessionDb.getSession(buildSessionKey(inboundFor(ALLOWED)))).toBeNull();
  });

  test('missing signature → 403, no turn, no send', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const { raw } = inboundForm({ from: ALLOWED, body: 'hi' });
    const res = await postSms(app, raw, undefined);

    expect(res.status).toBe(403);
    await drain();
    expect(sent).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
  });

  test('unlisted sender (valid signature) → no turn, no session, no reply', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const { raw, signature } = inboundForm({ from: UNLISTED, body: 'let me in' });
    const res = await postSms(app, raw, signature);

    // Acked (no existence leak — same 200 as a handled inbound), but NO turn.
    expect(res.status).toBe(200);
    await drain();
    expect(sent).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
    expect(runtime.sessionDb.getSession(buildSessionKey(inboundFor(UNLISTED)))).toBeNull();
  });

  test('per-sender isolation — two allowed senders own sessions under their own principals', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const a = inboundForm({ from: ALLOWED, body: 'from a', messageSid: 'SMaaa' });
    const b = inboundForm({ from: ALLOWED_2, body: 'from b', messageSid: 'SMbbb' });
    await postSms(app, a.raw, a.signature);
    await postSms(app, b.raw, b.signature);
    await drain();

    const rowA = runtime.sessionDb.getSession(buildSessionKey(inboundFor(ALLOWED)));
    const rowB = runtime.sessionDb.getSession(buildSessionKey(inboundFor(ALLOWED_2)));
    expect(rowA?.ownerId).toBe(PRINCIPAL);
    expect(rowB?.ownerId).toBe(PRINCIPAL_2);
    // Distinct sessions (distinct memory/learning namespaces, per Phase E).
    expect(rowA?.sessionId).not.toBe(rowB?.sessionId);
    expect(sent).toContainEqual({ to: ALLOWED, body: 'Hello world.' });
    expect(sent).toContainEqual({ to: ALLOWED_2, body: 'Hello world.' });
  });

  test('STOP → opt-out recorded, no turn; subsequent messages not delivered until START', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    // STOP — recorded as opt-out, no turn.
    const stop = inboundForm({ from: ALLOWED, body: 'STOP', messageSid: 'SMstop' });
    const stopRes = await postSms(app, stop.raw, stop.signature);
    expect(stopRes.status).toBe(200);
    await drain();
    expect(MockProvider.streamCalls).toBe(0);
    // No session created by a STOP.
    expect(runtime.sessionDb.getSession(buildSessionKey(inboundFor(ALLOWED)))).toBeNull();

    // A subsequent normal message from the opted-out sender → not delivered.
    const after = inboundForm({ from: ALLOWED, body: 'are you there', messageSid: 'SMafter' });
    const afterRes = await postSms(app, after.raw, after.signature);
    expect(afterRes.status).toBe(200);
    await drain();
    expect(MockProvider.streamCalls).toBe(0);
    expect(sent).toEqual([]);
  });

  test('lowercase stop + UNSUBSCRIBE are also opt-outs', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const lower = inboundForm({ from: ALLOWED, body: '  stop  ', messageSid: 'SMl' });
    await postSms(app, lower.raw, lower.signature);
    const unsub = inboundForm({ from: ALLOWED_2, body: 'Unsubscribe', messageSid: 'SMu' });
    await postSms(app, unsub.raw, unsub.signature);
    await drain();
    expect(MockProvider.streamCalls).toBe(0);
    expect(sent).toEqual([]);
  });

  test('HELP → returns the configured helpText, no turn', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const help = inboundForm({ from: ALLOWED, body: 'help', messageSid: 'SMhelp' });
    const res = await postSms(app, help.raw, help.signature);
    expect(res.status).toBe(200);
    await drain();
    expect(MockProvider.streamCalls).toBe(0);
    expect(sent).toEqual([{ to: ALLOWED, body: 'Reply with a question. STOP to unsubscribe.' }]);
  });

  test('START re-opts-in a previously opted-out sender', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    // Opt out, then opt back in.
    const stop = inboundForm({ from: ALLOWED, body: 'STOP', messageSid: 'SMs1' });
    await postSms(app, stop.raw, stop.signature);
    await drain();
    const start = inboundForm({ from: ALLOWED, body: 'START', messageSid: 'SMs2' });
    const startRes = await postSms(app, start.raw, start.signature);
    expect(startRes.status).toBe(200);
    await drain();
    // START itself runs no turn.
    expect(MockProvider.streamCalls).toBe(0);

    // Now a normal message IS delivered again.
    const normal = inboundForm({ from: ALLOWED, body: 'hello again', messageSid: 'SMs3' });
    await postSms(app, normal.raw, normal.signature);
    await drain();
    expect(MockProvider.streamCalls).toBe(1);
    expect(sent).toEqual([{ to: ALLOWED, body: 'Hello world.' }]);
  });

  test('unsafe From (not E.164-ish) → rejected, no turn', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    // A From that isn't E.164-shaped (path-traversal-ish) → 400, no turn.
    const evil = inboundForm({ from: '../../etc/passwd', body: 'hi', messageSid: 'SMevil' });
    const res = await postSms(app, evil.raw, evil.signature);
    expect(res.status).toBe(400);
    await drain();
    expect(MockProvider.streamCalls).toBe(0);
    expect(sent).toEqual([]);
  });

  test('ack-fast — the route returns 200 before the turn completes', async () => {
    // A transport whose send blocks until we release it. If the route awaited the
    // whole turn before ACKing, this would deadlock the request; ack-fast means
    // the 200 returns immediately and the send happens out of band.
    let releaseSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sent: Array<{ to: string; body: string }> = [];
    const transport: SmsTransport = {
      async sendMessage(to: string, body: string): Promise<void> {
        await sendGate;
        sent.push({ to, body });
      },
    };
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const { raw, signature } = inboundForm({ from: ALLOWED, body: 'hi' });
    const res = await postSms(app, raw, signature);
    // 200 returned even though the send is still gated.
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);

    // Release the send + drain the background work.
    releaseSend?.();
    await drain();
    expect(sent).toEqual([{ to: ALLOWED, body: 'Hello world.' }]);
  });

  test('a disabled sms channel is not routable → 404', async () => {
    const { transport } = makeMockTransport();
    const deps: ChannelsDeps = { smsTransport: transport };
    const app = buildAppWithRuntime(
      runtime,
      {
        channels: {
          sms: {
            enabled: false,
            provider: 'twilio',
            accountSid: ACCOUNT_SID,
            authToken: AUTH_TOKEN,
            fromNumber: FROM_NUMBER,
            senders: { [ALLOWED]: PRINCIPAL },
          },
        },
      },
      deps,
    );

    const { raw, signature } = inboundForm({ from: ALLOWED, body: 'hi' });
    const res = await postSms(app, raw, signature);
    expect(res.status).toBe(404);
  });

  test('opt-out store persists to <harnessHome>/channels/sms/optouts.json', async () => {
    const { transport } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const stop = inboundForm({ from: ALLOWED, body: 'STOP', messageSid: 'SMpersist' });
    await postSms(app, stop.raw, stop.signature);
    await drain();

    const optoutPath = join(home, 'channels', 'sms', 'optouts.json');
    const parsed = JSON.parse(readFileSync(optoutPath, 'utf-8')) as { optedOut?: string[] };
    expect(parsed.optedOut).toContain(ALLOWED);
  });

  // L1 — a prototype-key `From` must never resolve to a principal even if it
  // somehow reached the sender gate. (At the route it is already rejected by the
  // E.164 parse — a signed `From=__proto__` 400s with no turn — but the gate's
  // own lookup must be self-evidently prototype-safe too; see the unit test.)
  test('prototype-key From (valid signature) → no turn, no session', async () => {
    const { transport, sent } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { smsTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    for (const proto of ['__proto__', 'constructor', 'toString']) {
      const { raw, signature } = inboundForm({ from: proto, body: 'let me in' });
      const res = await postSms(app, raw, signature);
      // Rejected before any turn (400 at the E.164 source boundary).
      expect(res.status).toBe(400);
    }
    await drain();
    expect(sent).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
  });
});

describe('sms adapter pure pieces', () => {
  test('verifySmsSignature — KNOWN TEST VECTOR from Twilio docs', async () => {
    const { verifySmsSignature } = await import('../../src/channels/adapters/sms.js');
    // Verbatim from twilio.com/docs/usage/security: url + these params + authToken
    // '12345' → this exact base64 signature. Pins the verify impl to the
    // documented HMAC-SHA1/base64 scheme.
    const url = 'https://example.com/myapp.php?foo=1&bar=2';
    const params = {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675310',
      Digits: '1234',
      From: '+14158675310',
      To: '+18005551212',
    };
    const expected = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';
    expect(verifySmsSignature({ url, params, signatureHeader: expected, authToken: '12345' })).toBe(
      true,
    );
    // A tampered signature fails.
    expect(verifySmsSignature({ url, params, signatureHeader: 'AAAA', authToken: '12345' })).toBe(
      false,
    );
    // The wrong auth token fails.
    expect(verifySmsSignature({ url, params, signatureHeader: expected, authToken: 'nope' })).toBe(
      false,
    );
  });

  test('verifySmsSignature — false on missing/empty signature or token', async () => {
    const { verifySmsSignature } = await import('../../src/channels/adapters/sms.js');
    const url = 'https://x.test/c';
    const params = { From: '+1', Body: 'hi' };
    const good = twilioSign(url, params, 'tok');
    expect(verifySmsSignature({ url, params, signatureHeader: undefined, authToken: 'tok' })).toBe(
      false,
    );
    expect(verifySmsSignature({ url, params, signatureHeader: '', authToken: 'tok' })).toBe(false);
    expect(verifySmsSignature({ url, params, signatureHeader: good, authToken: '' })).toBe(false);
  });

  test('verifySmsSignature — param order does not matter (sorted before signing)', async () => {
    const { verifySmsSignature } = await import('../../src/channels/adapters/sms.js');
    const url = 'https://x.test/c';
    // Sign with one key order; verify passes a different insertion order.
    const sig = twilioSign(url, { B: '2', A: '1' }, 'tok');
    expect(
      verifySmsSignature({
        url,
        params: { A: '1', B: '2' },
        signatureHeader: sig,
        authToken: 'tok',
      }),
    ).toBe(true);
  });

  test('parseSmsBody — maps From/Body → InboundMessage, validates E.164', async () => {
    const { parseSmsBody } = await import('../../src/channels/adapters/sms.js');
    const ok = parseSmsBody({ From: '+15551234567', Body: 'hello', To: FROM_NUMBER });
    expect(ok).not.toBeNull();
    expect(ok?.channel).toBe('sms');
    expect(ok?.sender).toBe('+15551234567');
    expect(ok?.chatId).toBe('+15551234567');
    expect(ok?.chatType).toBe('private');
    expect(ok?.text).toBe('hello');

    // Bare digits (no +) are E.164-safe too.
    expect(parseSmsBody({ From: '15551234567', Body: 'x' })).not.toBeNull();

    // Missing From / non-string Body → null.
    expect(parseSmsBody({ Body: 'x' })).toBeNull();
    expect(parseSmsBody({ From: '+1', Body: 123 })).toBeNull();
    expect(parseSmsBody('nope')).toBeNull();

    // Unsafe From (separators / traversal / non-numeric) → null.
    expect(parseSmsBody({ From: '../evil', Body: 'x' })).toBeNull();
    expect(parseSmsBody({ From: 'a/b', Body: 'x' })).toBeNull();
    expect(parseSmsBody({ From: '+1 555 1234', Body: 'x' })).toBeNull();
    expect(parseSmsBody({ From: '', Body: 'x' })).toBeNull();
  });

  test('classifyKeyword — STOP/START/HELP families, case-insensitive + trimmed', async () => {
    const { classifyKeyword } = await import('../../src/channels/adapters/sms.js');
    for (const k of ['STOP', 'stop', '  Stop  ', 'UNSUBSCRIBE', 'cancel', 'END', 'quit']) {
      expect(classifyKeyword(k)).toBe('stop');
    }
    for (const k of ['START', 'start', 'UNSTOP', ' unstop ']) {
      expect(classifyKeyword(k)).toBe('start');
    }
    for (const k of ['HELP', 'help', 'INFO', ' info ']) {
      expect(classifyKeyword(k)).toBe('help');
    }
    for (const k of ['hello', 'what is the weather', '', '   ']) {
      expect(classifyKeyword(k)).toBeNull();
    }
  });

  test('opt-out store — read/write round-trips, robust to a missing file', async () => {
    const { readOptOuts, writeOptOut, clearOptOut } = await import(
      '../../src/channels/adapters/sms.js'
    );
    const dir = mkdtempSync(join(tmpdir(), 'sov-sms-optout-'));
    try {
      // Missing file → empty set, no throw.
      expect(readOptOuts(dir).has('+1')).toBe(false);
      await writeOptOut(dir, '+15551234567');
      expect(readOptOuts(dir).has('+15551234567')).toBe(true);
      // Idempotent.
      await writeOptOut(dir, '+15551234567');
      expect([...readOptOuts(dir)]).toEqual(['+15551234567']);
      // Clear.
      await clearOptOut(dir, '+15551234567');
      expect(readOptOuts(dir).has('+15551234567')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // L1 — the sender gate's allow-list lookup is prototype-safe: a `From` equal to
  // a prototype property name (`__proto__`/`constructor`/`toString`) is NEVER
  // treated as allow-listed, regardless of the regex upstream. `Object.hasOwn`
  // (not `senders[from] !== undefined`) is the self-evidently-safe gate.
  test('resolveSenderPrincipal — prototype keys never resolve to a principal', async () => {
    const { resolveSenderPrincipal } = await import('../../src/channels/adapters/sms.js');
    const senders = { '+15551234567': 'owner-a' };
    // A real allow-listed sender resolves.
    expect(resolveSenderPrincipal(senders, '+15551234567')).toBe('owner-a');
    // Prototype property names do NOT resolve (would be truthy with a naive
    // `senders[from]` lookup since they exist on Object.prototype).
    expect(resolveSenderPrincipal(senders, '__proto__')).toBeUndefined();
    expect(resolveSenderPrincipal(senders, 'constructor')).toBeUndefined();
    expect(resolveSenderPrincipal(senders, 'toString')).toBeUndefined();
    expect(resolveSenderPrincipal(senders, 'hasOwnProperty')).toBeUndefined();
    // An ordinary unlisted number does not resolve.
    expect(resolveSenderPrincipal(senders, '+19999999999')).toBeUndefined();
  });

  // L2 — concurrent writes for DIFFERENT numbers must both persist. A naive
  // read-modify-write last-writer-wins: each STOP reads the file before the other
  // wrote, so one opt-out is lost. Serializing writes through a single in-process
  // chain (+ atomic temp-file rename) guarantees both land.
  test('writeOptOut — two concurrent writes for different numbers both persist', async () => {
    const { writeOptOut, readOptOuts } = await import('../../src/channels/adapters/sms.js');
    const dir = mkdtempSync(join(tmpdir(), 'sov-sms-optout-concurrent-'));
    try {
      // Kick off both writes WITHOUT awaiting between them — they race.
      await Promise.all([writeOptOut(dir, '+15550000001'), writeOptOut(dir, '+15550000002')]);
      const set = readOptOuts(dir);
      expect(set.has('+15550000001')).toBe(true);
      expect(set.has('+15550000002')).toBe(true);
      expect(set.size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
