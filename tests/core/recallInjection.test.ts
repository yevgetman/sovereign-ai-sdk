// tests/core/recallInjection.test.ts
import { describe, expect, test } from 'bun:test';
import { injectRecallIntoLatestUserMessage } from '@yevgetman/sov-sdk/core/recallInjection';
import type { Message } from '@yevgetman/sov-sdk/core/types';

const userMsg = (text: string): Message =>
  ({ role: 'user', content: [{ type: 'text', text }] }) as Message;

describe('injectRecallIntoLatestUserMessage', () => {
  test('empty injection text returns history unchanged (same ref)', () => {
    const h = [userMsg('hello')];
    expect(injectRecallIntoLatestUserMessage(h, '')).toBe(h);
  });
  test('prepends snapshot to the latest user message without mutating the input', () => {
    const h = [userMsg('older'), userMsg('run the tests')];
    const out = injectRecallIntoLatestUserMessage(h, 'SNAP');
    expect(JSON.stringify(out[1])).toContain('SNAP');
    expect(JSON.stringify(out[1])).toContain('run the tests');
    expect(JSON.stringify(h[1])).not.toContain('SNAP'); // original untouched
  });
});
