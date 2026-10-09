// Public, authored compatibility fixture for the host-facing SDK contracts.
// This contains no private downstream source or owner data.
import assert from 'node:assert/strict';
import { createAgent, createInMemorySessionStore, buildTool } from '@yevgetman/sov-sdk';
import { z } from 'zod';

async function drain(generator) {
  for (;;) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}
function provider(replies) {
  return {
    name: 'contract-fixture',
    async *stream(request) {
      const content = replies ? replies.shift() : [{ type: 'text', text: String(request.messages.length) }];
      assert.ok(content, 'unexpected provider replay');
      const message = { role: 'assistant', content };
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
}

// Named consumer contract: verbatim history rehydration cannot duplicate rows.
const store = createInMemorySessionStore();
const agent = createAgent({ provider: provider(), model: 'fixture', sessionStore: store });
const first = await drain(agent.run('first', { sessionId: 'contract' }));
assert.equal(first.terminal.reason, 'completed');
assert.equal(store.loadMessages('contract').length, 2);
const history = store.loadMessages('contract').map(({ role, content }) => ({ role, content }));
history.push({ role: 'user', content: [{ type: 'text', text: 'second' }] });
const second = await drain(agent.run(history, { sessionId: 'contract' }));
assert.equal(second.terminal.reason, 'completed');
assert.equal(store.loadMessages('contract').length, 4);
assert.deepEqual(store.loadMessages('contract').slice(0, 2).map(({ role, content }) => ({ role, content })), history.slice(0, 2));

// A policy refusal must never invoke the tool, and must return a matching result.
let effects = 0;
const tool = buildTool({
  name: 'ContractTool', description: () => 'A deterministic contract fixture.',
  inputSchema: z.object({ value: z.string() }),
  async call() { effects++; return { data: 'effect' }; },
});
const denied = createAgent({ provider: provider([
  [{ type: 'tool_use', id: 'denied', name: tool.name, input: { value: 'x' } }],
  [{ type: 'text', text: 'refused' }],
]), model: 'fixture', tools: [tool], sessionStore: createInMemorySessionStore() });
const refused = await drain(denied.run('try', { canUseTool: async () => ({ behavior: 'deny', message: 'fixture refusal' }) }));
assert.equal(effects, 0);
assert.ok(refused.messages.some(message => message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'denied' && block.is_error)));

// A cancelled request cannot call inference. No HTTP or disk is involved.
let requests = 0;
const cancelled = createAgent({ model: 'fixture', provider: { name: 'cancel', async *stream() {
  requests++; throw new Error('cancelled provider must not run');
} } });
const controller = new AbortController(); controller.abort();
const interrupted = await drain(cancelled.run('cancel', { signal: controller.signal }));
assert.equal(interrupted.terminal.reason, 'interrupted'); assert.equal(requests, 0);

console.log('SDK_CONTRACT_OK');
