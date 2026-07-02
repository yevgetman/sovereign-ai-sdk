// Phase F-T7 — wire the channel adapters into the gateway lifecycle.
//
// Three load-bearing contracts are pinned here:
//
//   1. buildChannelListeners(runtime, channels, deps?) — the holder for the
//      channel BACKGROUND WORKERS (today: the Telegram poll loop; webhook + Slack
//      are HTTP routes, not workers). With telegram enabled and a mock transport
//      injected via deps, start() begins polling (the mock getUpdates is called)
//      and stop() halts it (no further getUpdates after stop).
//
//   2. resolveChannelsConfig(rawChannels, env) — env-first secret resolution over
//      the RAW (pre-parse) channels object. A missing secret field is filled from
//      its env var (SOV_TELEGRAM_BOT_TOKEN / SOV_SLACK_SIGNING_SECRET /
//      SOV_SLACK_BOT_TOKEN / SOV_WEBHOOK_SECRET). An ENABLED channel with NEITHER
//      a config secret NOR an env secret throws a clear boot error naming the
//      channel + the missing field + its env var. Disabled / enabled-omitted
//      channels are untouched. The schema↔env reconciliation: this merge runs
//      BEFORE SettingsSchema.parse (the schema stays pure / requires the secret in
//      config), so an env-sourced secret merged in here passes the schema.
//
//   3. Gateway app mounting — the channel routes mount ONLY when channels are
//      configured. POST /channels/webhook/default is reachable (401 on a bad sig,
//      NOT 404-route-missing) when a webhook channel is configured, and 404 (no
//      route) when channels are absent.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import type { TelegramTransport, TelegramUpdate } from '../../src/channels/adapters/telegram.js';
import { buildChannelListeners, resolveChannelsConfig } from '../../src/channels/listeners.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

const PRINCIPAL = 'tg-bot';
const TOKEN = 'bot-token-never-logged';

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

/** A canned private-DM update from user 42 in chat 42. */
function privateUpdate(updateId: number, text = 'hi'): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: 42, username: 'alice' },
      chat: { id: 42, type: 'private' },
      text,
    },
  };
}

/** A controllable mock transport recording every getUpdates offset + send. */
function makeMockTransport(queues: TelegramUpdate[][]): {
  transport: TelegramTransport;
  getUpdatesOffsets: number[];
  sent: Array<{ chatId: string | number; text: string }>;
} {
  const getUpdatesOffsets: number[] = [];
  const sent: Array<{ chatId: string | number; text: string }> = [];
  let call = 0;
  const transport: TelegramTransport = {
    async getUpdates(offset: number): Promise<TelegramUpdate[]> {
      getUpdatesOffsets.push(offset);
      const batch = queues[call] ?? [];
      call += 1;
      return batch;
    },
    async sendMessage(chatId: string | number, text: string): Promise<void> {
      sent.push({ chatId, text });
    },
  };
  return { transport, getUpdatesOffsets, sent };
}

describe('buildChannelListeners — channel background workers holder', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-listeners-'));
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

  test('telegram enabled → start() begins polling; stop() halts it', async () => {
    const { transport, getUpdatesOffsets } = makeMockTransport([[privateUpdate(700)], [], []]);
    const listeners = buildChannelListeners(
      runtime,
      {
        telegram: {
          enabled: true,
          botToken: TOKEN,
          principalId: PRINCIPAL,
        },
      },
      { telegramTransport: transport, pollIntervalMs: 5 },
    );

    listeners.start();
    // Poll loop is armed: getUpdates is called at least once within a few ticks.
    const deadline = Date.now() + 1_000;
    while (getUpdatesOffsets.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(getUpdatesOffsets.length).toBeGreaterThan(0);

    await listeners.stop();
    // After stop() no further getUpdates accrue — record the count, wait past a
    // few would-be ticks, and assert it is unchanged.
    const countAfterStop = getUpdatesOffsets.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(getUpdatesOffsets.length).toBe(countAfterStop);
  });

  test('no telegram channel → start()/stop() are no-ops (nothing polled)', async () => {
    const { transport, getUpdatesOffsets } = makeMockTransport([[privateUpdate(701)]]);
    const listeners = buildChannelListeners(
      runtime,
      { webhook: { enabled: true, secret: 's', principalId: PRINCIPAL } },
      { telegramTransport: transport, pollIntervalMs: 5 },
    );
    listeners.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(getUpdatesOffsets.length).toBe(0);
    await listeners.stop();
  });

  test('a disabled telegram channel is NOT polled', async () => {
    const { transport, getUpdatesOffsets } = makeMockTransport([[privateUpdate(702)]]);
    const listeners = buildChannelListeners(
      runtime,
      { telegram: { enabled: false, botToken: TOKEN, principalId: PRINCIPAL } },
      { telegramTransport: transport, pollIntervalMs: 5 },
    );
    listeners.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(getUpdatesOffsets.length).toBe(0);
    await listeners.stop();
  });
});

describe('resolveChannelsConfig — env-first secret resolution (pre-parse)', () => {
  test('fills a missing telegram botToken from SOV_TELEGRAM_BOT_TOKEN', () => {
    const resolved = resolveChannelsConfig(
      { telegram: { enabled: true, principalId: 'tg' } },
      { SOV_TELEGRAM_BOT_TOKEN: 'env-bot-token' },
    );
    expect(resolved).toEqual({
      telegram: { enabled: true, principalId: 'tg', botToken: 'env-bot-token' },
    });
  });

  test('fills missing slack secrets from SOV_SLACK_SIGNING_SECRET + SOV_SLACK_BOT_TOKEN', () => {
    const resolved = resolveChannelsConfig(
      { slack: { enabled: true, principalId: 'sl' } },
      { SOV_SLACK_SIGNING_SECRET: 'env-ss', SOV_SLACK_BOT_TOKEN: 'env-bt' },
    );
    expect(resolved).toEqual({
      slack: { enabled: true, principalId: 'sl', signingSecret: 'env-ss', botToken: 'env-bt' },
    });
  });

  test('fills a missing webhook secret from SOV_WEBHOOK_SECRET', () => {
    const resolved = resolveChannelsConfig(
      { webhook: { enabled: true, principalId: 'wh' } },
      { SOV_WEBHOOK_SECRET: 'env-whsec' },
    );
    expect(resolved).toEqual({
      webhook: { enabled: true, principalId: 'wh', secret: 'env-whsec' },
    });
  });

  test('fills missing sms creds from SOV_TWILIO_ACCOUNT_SID + SOV_TWILIO_AUTH_TOKEN', () => {
    const resolved = resolveChannelsConfig(
      {
        sms: {
          enabled: true,
          provider: 'twilio',
          fromNumber: '+15550001111',
          senders: { '+15551234567': 'sms' },
        },
      },
      { SOV_TWILIO_ACCOUNT_SID: 'env-sid', SOV_TWILIO_AUTH_TOKEN: 'env-tok' },
    );
    expect(resolved).toEqual({
      sms: {
        enabled: true,
        provider: 'twilio',
        fromNumber: '+15550001111',
        senders: { '+15551234567': 'sms' },
        accountSid: 'env-sid',
        authToken: 'env-tok',
      },
    });
  });

  test('an enabled sms missing authToken throws naming SOV_TWILIO_AUTH_TOKEN', () => {
    expect(() =>
      resolveChannelsConfig(
        {
          sms: {
            enabled: true,
            provider: 'twilio',
            accountSid: 'AC1',
            fromNumber: '+15550001111',
            senders: { '+1': 'sms' },
          },
        },
        {},
      ),
    ).toThrow(/sms[\s\S]*authToken[\s\S]*SOV_TWILIO_AUTH_TOKEN/);
  });

  test('config secret takes precedence over env (config wins)', () => {
    const resolved = resolveChannelsConfig(
      { telegram: { enabled: true, principalId: 'tg', botToken: 'config-token' } },
      { SOV_TELEGRAM_BOT_TOKEN: 'env-token' },
    );
    expect((resolved as { telegram: { botToken: string } }).telegram.botToken).toBe('config-token');
  });

  test('an enabled telegram with NEITHER config nor env botToken throws naming channel + env var', () => {
    expect(() =>
      resolveChannelsConfig({ telegram: { enabled: true, principalId: 'tg' } }, {}),
    ).toThrow(/telegram[\s\S]*botToken[\s\S]*SOV_TELEGRAM_BOT_TOKEN/);
  });

  test('an enabled webhook with no secret anywhere throws naming channel + env var', () => {
    expect(() =>
      resolveChannelsConfig({ webhook: { enabled: true, principalId: 'wh' } }, {}),
    ).toThrow(/webhook[\s\S]*secret[\s\S]*SOV_WEBHOOK_SECRET/);
  });

  test('an enabled slack missing signingSecret throws naming SOV_SLACK_SIGNING_SECRET', () => {
    expect(() =>
      resolveChannelsConfig({ slack: { enabled: true, principalId: 'sl', botToken: 'bt' } }, {}),
    ).toThrow(/slack[\s\S]*signingSecret[\s\S]*SOV_SLACK_SIGNING_SECRET/);
  });

  test('a disabled channel is NOT validated and NOT env-filled', () => {
    const resolved = resolveChannelsConfig(
      { telegram: { enabled: false, principalId: 'tg' } },
      { SOV_TELEGRAM_BOT_TOKEN: 'env-token' },
    );
    // No throw; disabled channel left untouched (no env injection).
    expect(resolved).toEqual({ telegram: { enabled: false, principalId: 'tg' } });
  });

  test('a channel with enabled omitted (disabled by default) is NOT validated', () => {
    const resolved = resolveChannelsConfig({ webhook: { principalId: 'wh' } }, {});
    expect(resolved).toEqual({ webhook: { principalId: 'wh' } });
  });

  test('undefined raw channels returns undefined (no-channels path)', () => {
    expect(resolveChannelsConfig(undefined, {})).toBeUndefined();
  });

  test('does not mutate the input raw object (immutable)', () => {
    const raw = { telegram: { enabled: true, principalId: 'tg' } };
    const resolved = resolveChannelsConfig(raw, { SOV_TELEGRAM_BOT_TOKEN: 'env-token' });
    // Input untouched; output is a fresh object carrying the env secret.
    expect(raw).toEqual({ telegram: { enabled: true, principalId: 'tg' } });
    expect(resolved).not.toBe(raw);
  });
});

describe('gateway app — channel routes mount only when channels configured', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-mount-'));
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

  test('channels configured → POST /channels/webhook/default is reachable (401 bad sig, not 404)', async () => {
    const app = buildAppWithRuntime(runtime, {
      channels: { webhook: { enabled: true, secret: 'whsec', principalId: PRINCIPAL } },
    });
    const res = await app.request('/channels/webhook/default', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' },
      body: JSON.stringify({ sender: 'u1', text: 'hi' }),
    });
    // Route exists + verifies → bad signature is 401, NOT 404-route-missing.
    expect(res.status).toBe(401);
  });

  test('channels absent → POST /channels/webhook/default is 404 (no route mounted)', async () => {
    const app = buildAppWithRuntime(runtime);
    const res = await app.request('/channels/webhook/default', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' },
      body: JSON.stringify({ sender: 'u1', text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});
