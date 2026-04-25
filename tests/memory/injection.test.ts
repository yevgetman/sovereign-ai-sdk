// Memory fencing tests. The snapshot should be visibly background context
// and prepend to the current user text only.

import { describe, expect, test } from 'bun:test';
import type { Message } from '../../src/core/types.js';
import {
  FENCE_PREAMBLE,
  formatMemorySnapshot,
  injectMemoryIntoLatestUserMessage,
} from '../../src/memory/injection.js';

describe('memory injection', () => {
  test('formats fenced memory context', () => {
    const snapshot = formatMemorySnapshot({ user: 'prefers terse', memory: 'project note' });
    expect(snapshot).toContain(FENCE_PREAMBLE);
    expect(snapshot).toContain('<memory-context>');
    expect(snapshot).toContain('<USER.md>');
    expect(snapshot).toContain('<MEMORY.md>');
  });

  test('injects into latest user message without mutating input array', async () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'current' }] },
    ];
    const injected = await injectMemoryIntoLatestUserMessage(messages, {
      async prefetchSnapshot() {
        return formatMemorySnapshot({ user: 'prefers terse' });
      },
    });
    const latest = injected[2];
    expect(latest?.role).toBe('user');
    expect(latest?.content[0]?.type).toBe('text');
    if (latest?.content[0]?.type === 'text') {
      expect(latest.content[0].text).toContain('prefers terse');
      expect(latest.content[0].text).toContain('current');
    }
    expect(messages[2]?.content[0]).toEqual({ type: 'text', text: 'current' });
  });
});
