// Channel adapter contract — the shape every channel (Telegram / Slack /
// webhook, Phase F-T4/5/6) implements. This test pins the verify → run →
// deliver contract and the tiny in-process registry, so the concrete adapters
// have a stable target.

import { describe, expect, test } from 'bun:test';
import {
  type ChannelAdapter,
  clearChannelAdapters,
  getChannelAdapter,
  registerChannelAdapter,
} from '../../src/channels/adapter.js';
import type { DeliveryResult, InboundMessage } from '../../src/channels/types.js';

function makeMsg(text: string): InboundMessage {
  return {
    sender: 'u1',
    channel: 'test',
    chatId: 'c1',
    chatType: 'private',
    text,
  };
}

function makeAdapter(id: string): ChannelAdapter<{ token: string }> {
  return {
    id,
    async verify(input) {
      const ok = input.headers['x-token'] === 'good';
      if (!ok) return { ok: false, status: 401 };
      return { ok: true, message: makeMsg(String(input.rawBody)) };
    },
    async deliver(reply, _msg, transport): Promise<DeliveryResult> {
      return { ok: reply.length > 0 && transport.token.length > 0 };
    },
  };
}

describe('ChannelAdapter contract', () => {
  test('verify rejects with ok:false + status when verification fails', async () => {
    const adapter = makeAdapter('a1');
    const result = await adapter.verify({ rawBody: 'hi', headers: {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toBeUndefined();
  });

  test('verify accepts with a parsed InboundMessage on success', async () => {
    const adapter = makeAdapter('a1');
    const result = await adapter.verify({ rawBody: 'hello', headers: { 'x-token': 'good' } });
    expect(result.ok).toBe(true);
    expect(result.message?.text).toBe('hello');
  });

  test('deliver returns a DeliveryResult using the typed transport', async () => {
    const adapter = makeAdapter('a1');
    const result = await adapter.deliver('reply', makeMsg('hi'), { token: 't' });
    expect(result.ok).toBe(true);
  });
});

describe('channel adapter registry', () => {
  test('register then get returns the same adapter', () => {
    clearChannelAdapters();
    const adapter = makeAdapter('telegram');
    registerChannelAdapter(adapter as ChannelAdapter);
    expect(getChannelAdapter('telegram')).toBe(adapter as ChannelAdapter);
  });

  test('get returns undefined for an unknown id', () => {
    clearChannelAdapters();
    expect(getChannelAdapter('nope')).toBeUndefined();
  });

  test('registering a duplicate id throws', () => {
    clearChannelAdapters();
    registerChannelAdapter(makeAdapter('dup') as ChannelAdapter);
    expect(() => registerChannelAdapter(makeAdapter('dup') as ChannelAdapter)).toThrow();
  });
});
