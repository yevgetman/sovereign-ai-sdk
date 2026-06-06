// Phase F-T6 — the Slack Events API adapter + its open gateway route.
//
// Slack POSTs every event to a single public endpoint and authenticates each
// request with an HMAC-SHA256 signature over the RAW body keyed by the app's
// signing secret (NOT a per-message token). The endpoint must ACK fast (Slack
// retries after ~3s) and reply asynchronously, dedupe Slack's at-least-once
// retries by `event_id`, answer the one-time url_verification handshake, and
// never re-run on the bot's own messages.
//
// These tests pin the security-load-bearing contracts deterministically against
// a MockProvider runtime (no LLM variance) + an INJECTED mock SlackTransport,
// exercising every status code + the verify-before-side-effect order:
//   - valid event_callback message (correct v0= signature, fresh ts) → 200 ACK;
//     the background turn runs and transport.postMessage(<channel>, <reply>) is
//     called with the MockProvider reply; a session owned by the slack principal
//     exists (platform 'slack');
//   - url_verification (correctly signed) → 200 { challenge }, NO turn ran;
//   - bad signature → 403, no turn, no post;
//   - stale timestamp (> 300s old, otherwise valid) → 403 (replay rejected);
//   - retry dedupe: two POSTs with the same event_id → the turn runs ONCE,
//     postMessage called ONCE (the retry ACKs 200 without re-running);
//   - the bot's own message (bot_id set) → 200 ACK, no turn, no post.
//
// Deterministic background await: the route schedules the turn + post as a
// background task and returns 200 immediately (ack-fast-then-async). The test
// injects an `onBackgroundTask` hook through the channels deps that collects
// each in-flight promise so the test can await them before asserting the post.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SlackTransport } from '../../src/channels/adapters/slack.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import type { ChannelsConfig, ChannelsDeps } from '../../src/server/routes/channels.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

const SIGNING_SECRET = 'slacksec_test_secret';
const BOT_TOKEN = 'xoxb-never-logged';
const PRINCIPAL = 'slack-bot';

const CHANNELS: ChannelsConfig = {
  slack: {
    enabled: true,
    signingSecret: SIGNING_SECRET,
    botToken: BOT_TOKEN,
    principalId: PRINCIPAL,
  },
};

/** The InboundMessage the route derives from the message-event body below —
 *  used to recompute the deterministic session key for the DB assertions. The
 *  Slack channel maps chatId = event.channel, sender = event.user. */
const INBOUND: InboundMessage = {
  channel: 'slack',
  sender: 'U123',
  chatId: 'C999',
  chatType: 'channel',
  text: 'hello there',
};

/** A controllable mock SlackTransport. Records every postMessage. */
function makeMockTransport(): {
  transport: SlackTransport;
  posted: Array<{ channel: string; text: string }>;
} {
  const posted: Array<{ channel: string; text: string }> = [];
  const transport: SlackTransport = {
    async postMessage(channel: string, text: string): Promise<void> {
      posted.push({ channel, text });
    },
  };
  return { transport, posted };
}

/** Collect in-flight background promises so the test can deterministically
 *  await the async post the route schedules after the fast ACK. */
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

/** Build the Slack `X-Slack-Signature` header: `v0=<hex>` where hex =
 *  HMAC-SHA256(signingSecret, `v0:${ts}:${rawBody}`). */
function slackSign(rawBody: string, ts: string, secret: string): string {
  const base = `v0:${ts}:${rawBody}`;
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

/** Current unix seconds as a string (Slack sends seconds, not ms). */
function nowSecs(): string {
  return String(Math.floor(Date.now() / 1000));
}

function eventCallbackBody(opts: {
  eventId?: string;
  text?: string;
  botId?: string;
}): string {
  const event: Record<string, unknown> = {
    type: 'message',
    user: 'U123',
    channel: 'C999',
    text: opts.text ?? 'hello there',
    channel_type: 'channel',
  };
  if (opts.botId !== undefined) event.bot_id = opts.botId;
  return JSON.stringify({
    type: 'event_callback',
    event_id: opts.eventId ?? 'Ev0001',
    event,
  });
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

describe('slack channel — signing-secret-verified Events API route (F-T6)', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-slack-'));
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

  test('valid event_callback message → 200 ACK, async post, session owned by principal', async () => {
    const { transport, posted } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { slackTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const ts = nowSecs();
    const raw = eventCallbackBody({});
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': slackSign(raw, ts, SIGNING_SECRET),
      },
      body: raw,
    });

    // ACK fast.
    expect(res.status).toBe(200);

    // Now the scheduled background turn + post resolves.
    await drain();

    // The MockProvider default reply is "Hello world." — posted to the channel.
    expect(posted).toEqual([{ channel: 'C999', text: 'Hello world.' }]);

    // The turn created a session via buildSessionKey, owned by the slack
    // principal, stamped platform 'slack'.
    const row = runtime.sessionDb.getSession(buildSessionKey(INBOUND));
    expect(row).not.toBeNull();
    expect(row?.ownerId).toBe(PRINCIPAL);
    expect(row?.platform).toBe('slack');
  });

  test('url_verification (correctly signed) → 200 { challenge }, no turn', async () => {
    const { transport, posted } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { slackTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const ts = nowSecs();
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': slackSign(raw, ts, SIGNING_SECRET),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge?: string };
    expect(json.challenge).toBe('abc');

    await drain();
    expect(posted).toEqual([]);
    // No session created for the handshake.
    expect(runtime.sessionDb.getSession(buildSessionKey(INBOUND))).toBeNull();
  });

  test('bad signature → 403, no turn, no post', async () => {
    const { transport, posted } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { slackTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const ts = nowSecs();
    const raw = eventCallbackBody({});
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': slackSign(raw, ts, 'wrong-secret'),
      },
      body: raw,
    });

    expect(res.status).toBe(403);
    await drain();
    expect(posted).toEqual([]);
    expect(runtime.sessionDb.getSession(buildSessionKey(INBOUND))).toBeNull();
  });

  test('stale timestamp (> 300s) → 403 (replay rejected)', async () => {
    const { transport, posted } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { slackTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    // 301 seconds in the past — outside the replay window — but otherwise a
    // correctly-computed signature over that stale timestamp.
    const staleTs = String(Math.floor(Date.now() / 1000) - 301);
    const raw = eventCallbackBody({});
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': staleTs,
        'X-Slack-Signature': slackSign(raw, staleTs, SIGNING_SECRET),
      },
      body: raw,
    });

    expect(res.status).toBe(403);
    await drain();
    expect(posted).toEqual([]);
    expect(runtime.sessionDb.getSession(buildSessionKey(INBOUND))).toBeNull();
  });

  test('retry dedupe — same event_id twice → turn runs once, post once', async () => {
    const { transport, posted } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { slackTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const sendOnce = async (): Promise<Response> => {
      const ts = nowSecs();
      const raw = eventCallbackBody({ eventId: 'EvDUP' });
      return app.request('/channels/slack/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Request-Timestamp': ts,
          'X-Slack-Signature': slackSign(raw, ts, SIGNING_SECRET),
          'X-Slack-Retry-Num': '1',
        },
        body: raw,
      });
    };

    // First delivery: ACK + schedule the turn. Await it to completion so the
    // dedupe set is definitely populated before the retry arrives.
    const res1 = await sendOnce();
    expect(res1.status).toBe(200);
    await drain();

    // Retry of the SAME event_id: ACK 200 but no re-run, no second post.
    const res2 = await sendOnce();
    expect(res2.status).toBe(200);
    await drain();

    expect(posted).toEqual([{ channel: 'C999', text: 'Hello world.' }]);
    expect(MockProvider.streamCalls).toBe(1);
  });

  test("bot's own message (bot_id set) → 200 ACK, no turn, no post", async () => {
    const { transport, posted } = makeMockTransport();
    const { onBackgroundTask, drain } = makeBackgroundCollector();
    const deps: ChannelsDeps = { slackTransport: transport, onBackgroundTask };
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS }, deps);

    const ts = nowSecs();
    const raw = eventCallbackBody({ eventId: 'EvBOT', botId: 'B100' });
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': slackSign(raw, ts, SIGNING_SECRET),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    await drain();
    expect(posted).toEqual([]);
    expect(runtime.sessionDb.getSession(buildSessionKey(INBOUND))).toBeNull();
  });

  test('a disabled slack channel is not routable → 404', async () => {
    const { transport } = makeMockTransport();
    const deps: ChannelsDeps = { slackTransport: transport };
    const app = buildAppWithRuntime(
      runtime,
      {
        channels: {
          slack: {
            enabled: false,
            signingSecret: SIGNING_SECRET,
            botToken: BOT_TOKEN,
            principalId: PRINCIPAL,
          },
        },
      },
      deps,
    );

    const ts = nowSecs();
    const raw = eventCallbackBody({});
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': slackSign(raw, ts, SIGNING_SECRET),
      },
      body: raw,
    });

    expect(res.status).toBe(404);
  });
});

describe('slack adapter pure pieces (F-T6)', () => {
  test('verifySlackSignature — valid v0= over v0:ts:body within window', async () => {
    const { verifySlackSignature } = await import('../../src/channels/adapters/slack.js');
    const ts = nowSecs();
    const rawBody = '{"hi":"there"}';
    const signature = slackSign(rawBody, ts, SIGNING_SECRET);
    expect(
      verifySlackSignature({ rawBody, timestamp: ts, signature, signingSecret: SIGNING_SECRET }),
    ).toBe(true);
  });

  test('verifySlackSignature — false on wrong secret / missing / malformed / stale', async () => {
    const { verifySlackSignature } = await import('../../src/channels/adapters/slack.js');
    const ts = nowSecs();
    const rawBody = '{"hi":"there"}';
    const good = slackSign(rawBody, ts, SIGNING_SECRET);

    // wrong secret
    expect(
      verifySlackSignature({
        rawBody,
        timestamp: ts,
        signature: slackSign(rawBody, ts, 'nope'),
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
    // missing signature
    expect(
      verifySlackSignature({
        rawBody,
        timestamp: ts,
        signature: undefined,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
    // malformed (no v0= prefix)
    expect(
      verifySlackSignature({
        rawBody,
        timestamp: ts,
        signature: 'deadbeef',
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
    // missing timestamp
    expect(
      verifySlackSignature({
        rawBody,
        timestamp: undefined,
        signature: good,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
    // stale timestamp (> 300s) — even with a signature correct for that ts
    const staleTs = String(Math.floor(Date.now() / 1000) - 301);
    expect(
      verifySlackSignature({
        rawBody,
        timestamp: staleTs,
        signature: slackSign(rawBody, staleTs, SIGNING_SECRET),
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test('parseSlackBody — challenge / message → InboundMessage / ignore', async () => {
    const { parseSlackBody } = await import('../../src/channels/adapters/slack.js');

    expect(parseSlackBody({ type: 'url_verification', challenge: 'xyz' })).toEqual({
      kind: 'challenge',
      challenge: 'xyz',
    });

    const eventResult = parseSlackBody({
      type: 'event_callback',
      event_id: 'Ev1',
      event: { type: 'message', user: 'U1', channel: 'C1', text: 'hi', channel_type: 'im' },
    });
    expect(eventResult.kind).toBe('event');
    if (eventResult.kind === 'event') {
      expect(eventResult.eventId).toBe('Ev1');
      expect(eventResult.message.channel).toBe('slack');
      expect(eventResult.message.sender).toBe('U1');
      expect(eventResult.message.chatId).toBe('C1');
      expect(eventResult.message.chatType).toBe('private');
      expect(eventResult.message.text).toBe('hi');
    }

    // bot message → ignore
    expect(
      parseSlackBody({
        type: 'event_callback',
        event_id: 'Ev2',
        event: { type: 'message', user: 'U1', channel: 'C1', text: 'hi', bot_id: 'B1' },
      }).kind,
    ).toBe('ignore');

    // bot_message subtype → ignore
    expect(
      parseSlackBody({
        type: 'event_callback',
        event_id: 'Ev3',
        event: { type: 'message', subtype: 'bot_message', channel: 'C1', text: 'hi' },
      }).kind,
    ).toBe('ignore');

    // non-message event → ignore
    expect(
      parseSlackBody({
        type: 'event_callback',
        event_id: 'Ev4',
        event: { type: 'reaction_added', user: 'U1' },
      }).kind,
    ).toBe('ignore');

    // Fix F7 — defense-in-depth source hardening: an event whose channel/user is
    // not a safe path segment (separators / `..`) is ignored (no turn), matching
    // the webhook adapter's source-level validation.
    expect(
      parseSlackBody({
        type: 'event_callback',
        event_id: 'Ev5',
        event: { type: 'message', user: 'U1', channel: '../evil', text: 'hi', channel_type: 'im' },
      }).kind,
    ).toBe('ignore');
    expect(
      parseSlackBody({
        type: 'event_callback',
        event_id: 'Ev6',
        event: { type: 'message', user: 'a/b', channel: 'C1', text: 'hi', channel_type: 'im' },
      }).kind,
    ).toBe('ignore');
  });

  test('createSlackDedupe — marks once, reports seen', async () => {
    const { createSlackDedupe } = await import('../../src/channels/adapters/slack.js');
    const dedupe = createSlackDedupe();
    expect(dedupe.seen('Ev1')).toBe(false);
    dedupe.mark('Ev1');
    expect(dedupe.seen('Ev1')).toBe(true);
    expect(dedupe.seen('Ev2')).toBe(false);
  });
});
