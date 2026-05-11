import { describe, expect, test } from 'bun:test';
import { buildSessionKey } from '../../src/channels/sessionKey.js';

describe('buildSessionKey', () => {
  test('private DM without threadId', () => {
    const key = buildSessionKey({
      sender: 'user1',
      channel: 'local',
      chatId: 'chat123',
      chatType: 'private',
      text: 'hello',
    });
    expect(key).toBe('agent:main:local:private:chat123');
  });

  test('includes threadId when present', () => {
    const key = buildSessionKey({
      sender: 'user1',
      channel: 'telegram',
      chatId: 'chat456',
      chatType: 'group',
      threadId: 'thread789',
      text: 'hi',
    });
    expect(key).toBe('agent:main:telegram:group:chat456:thread789');
  });

  test('chatType distinguishes keys for same chatId', () => {
    const base = { sender: 'u', channel: 'slack', chatId: 'c', text: 't' };
    expect(buildSessionKey({ ...base, chatType: 'private' })).not.toBe(
      buildSessionKey({ ...base, chatType: 'channel' }),
    );
  });
});
