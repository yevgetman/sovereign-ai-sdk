import { expect, test } from 'bun:test';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import { hasNativeRecoveryTarget, nativeRunOutcome } from '../../src/cli/nativeRunOutcome.js';

for (const [reason, expected] of [
  ['completed', 'completed'],
  ['max_tokens', 'needs_continuation'],
  ['max_turns', 'needs_continuation'],
  ['checkin', 'needs_continuation'],
  ['interrupted', 'interrupted'],
  ['error', 'failed'],
] as const)
  test(`native outcome ${reason}`, () => expect(nativeRunOutcome({ reason })).toBe(expected));

function fixture() {
  const store = createInMemorySessionStore();
  const id = store.createSession({ model: 'fixture', provider: 'fixture' });
  return { store, id };
}
test('recovery requires an existing durable user message, never only an id', () => {
  const { store, id } = fixture();
  expect(hasNativeRecoveryTarget(undefined, id)).toBe(false);
  expect(hasNativeRecoveryTarget(store, null)).toBe(false);
  expect(hasNativeRecoveryTarget(store, 'missing')).toBe(false);
  expect(hasNativeRecoveryTarget(store, id)).toBe(false);
  store.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'prompt' }] });
  expect(hasNativeRecoveryTarget(store, id)).toBe(true);
});
for (const state of ['started', 'unknown', 'completed', 'interrupted'] as const) {
  test(`recovery with ${state} tool receipt`, () => {
    const { store, id } = fixture();
    store.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'prompt' }] });
    const assistantMessageId = store.saveMessage(id, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'fixture', input: {} }],
    });
    store.saveToolExecution(id, {
      assistantMessageId,
      toolUseId: 'tool-1',
      state,
      result: { type: 'tool_result', tool_use_id: 'tool-1', content: 'receipt' },
    });
    expect(hasNativeRecoveryTarget(store, id)).toBe(
      state === 'completed' || state === 'interrupted',
    );
    expect(store.loadMessages(id)).toHaveLength(2);
  });
}
test('a missing receipt/result and unreadable storage never authorize recovery', () => {
  const { store, id } = fixture();
  store.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'prompt' }] });
  store.saveMessage(id, {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-1', name: 'fixture', input: {} }],
  });
  expect(hasNativeRecoveryTarget(store, id)).toBe(false);
  store.loadMessages = () => {
    throw new Error('private storage failure');
  };
  expect(hasNativeRecoveryTarget(store, id)).toBe(false);
});

test('a mismatched persisted result cannot certify a missing canonical tool receipt', () => {
  const { store, id } = fixture();
  store.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'prompt' }] });
  const assistantMessageId = store.saveMessage(id, {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-1', name: 'fixture', input: {} }],
  });
  store.loadToolExecutions = () => [
    {
      assistantMessageId,
      toolUseId: 'tool-1',
      state: 'completed',
      result: { type: 'tool_result', tool_use_id: 'foreign-tool', content: 'receipt' },
    },
  ];
  expect(hasNativeRecoveryTarget(store, id)).toBe(false);
});

test('an orphaned in-flight receipt cannot certify a durable plain prompt', () => {
  const { store, id } = fixture();
  store.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'prompt' }] });
  store.loadToolExecutions = () => [
    { assistantMessageId: 999, toolUseId: 'lost-tool', state: 'started' },
  ];
  expect(hasNativeRecoveryTarget(store, id)).toBe(false);
});

test('a completed receipt without its matching assistant tool intent is unsafe', () => {
  const { store, id } = fixture();
  store.saveMessage(id, { role: 'user', content: [{ type: 'text', text: 'prompt' }] });
  const assistantMessageId = store.saveMessage(id, {
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
  });
  store.loadToolExecutions = () => [
    {
      assistantMessageId,
      toolUseId: 'lost-tool',
      state: 'completed',
      result: { type: 'tool_result', tool_use_id: 'lost-tool', content: 'receipt' },
    },
  ];
  expect(hasNativeRecoveryTarget(store, id)).toBe(false);
});
