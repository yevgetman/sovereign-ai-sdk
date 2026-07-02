// tests/learning-layer/reasonProvider.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { createProviderReason } from '../../src/learning-layer/adapters/harness/reasonProvider.js';

// The MockProvider's only sanctioned way to emit an arbitrary canned string
// (rather than the default "Hello world.") is its scripted-entry path: a
// single `{ kind: 'text' }` entry yields one text_delta + assistant_message —
// the exact event shape query.ts consumes. Reset the static script + cursor
// after each test so no state bleeds into the rest of the suite.
afterEach(() => {
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
});

describe('createProviderReason', () => {
  test('complete() returns the model text for a prompt', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: 'lesson: prefer bun test' }];
    const provider = new MockProvider();
    const reason = createProviderReason(provider, 'mock-model');
    expect(await reason.complete('summarize')).toContain('prefer bun test');
  });

  test('complete() forwards prompt, model, and maxTokens to the provider', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: 'ok' }];
    const provider = new MockProvider();
    const reason = createProviderReason(provider, 'mock-model');

    // stream() snapshots these statics on every call, so reading them after
    // the await reflects this turn's request. Asserting on a copy keeps
    // TypeScript from narrowing the `| undefined` statics to literal undefined.
    const out = await reason.complete('do the thing', { maxTokens: 512 });
    const sentMaxTokens = MockProvider.lastMaxTokens;
    const sentMessages = MockProvider.lastMessages;

    expect(out).toBe('ok');
    expect(sentMaxTokens).toBe(512);
    expect(sentMessages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    ]);
  });
});
