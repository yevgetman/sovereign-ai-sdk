// Public, authored compatibility fixture for the host-facing SDK contracts.
// This contains no private downstream source or owner data.
import assert from 'node:assert/strict';
import { createAgent, createInMemorySessionStore, buildTool, TreeBudget, TreeBudgetExceededError, budgetProvider } from '@yevgetman/sov-sdk';
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

// Partial counters can prove an overrun even when total usage is unknown.
const budget = new TreeBudget({ maxTotalTokens: 10 });
budget.reserveRequest({ tokens: 10 })({ outputTokens: 11 });
assert.equal(budget.snapshot().accountedTokens, 11);
assert.equal(budget.snapshot().exhausted, true);
assert.equal(budget.snapshot().tokenUsageComplete, false);
assert.throws(() => budget.reserveRequest({ tokens: 0 }), TreeBudgetExceededError);

// Disconnects retain a proved overrun even without a completion marker.
const interruptedBudget = new TreeBudget({ maxTotalTokens: 10, maxEstimatedCostUsd: 0.1 });
const interruptedProvider = budgetProvider({ name: 'openai', async *stream() {
  yield { type: 'usage_delta', usage: { outputTokens: 11 } };
  throw new Error('authored budget disconnect');
} }, interruptedBudget, () => ({ tokens: 10, estimatedCostUsd: 0.1 }));
await assert.rejects(drain(interruptedProvider.stream({ model: 'gpt-4o-mini', system: [], messages: [], maxTokens: 10 })), /authored budget disconnect/);
assert.equal(interruptedBudget.snapshot().accountedTokens, 11);
assert.equal(interruptedBudget.snapshot().accountedEstimatedCostUsd, 0.1);
assert.equal(interruptedBudget.snapshot().tokenUsageComplete, false);
assert.equal(interruptedBudget.snapshot().estimatedCostComplete, false);
assert.equal(interruptedBudget.snapshot().exhausted, true);
assert.throws(() => interruptedBudget.reserveRequest({ tokens: 0, estimatedCostUsd: 0 }), TreeBudgetExceededError);

// Output governance can close a fully billed attempt at its final event.
let guardedCalls = 0;
let finalChecks = 0;
const regeneratedBudget = new TreeBudget({ maxTotalTokens: 107 });
const regenerated = await drain(createAgent({
  model: 'gpt-4o-mini',
  maxTokens: 10,
  provider: budgetProvider({ name: 'openai', async *stream() {
    guardedCalls++;
    const message = { role: 'assistant', content: [{ type: 'text', text: 'guarded answer' }] };
    yield { type: 'message_start' };
    yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 4 } };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    yield { type: 'assistant_message', message };
    return message;
  } }, regeneratedBudget, () => ({ tokens: 100 })),
  contextLimits: { maxHistoryBytes: 1000 },
  contextManager: { async reduce(request) {
    return { messages: [request.messages.at(-1)], usage: { inputTokens: 9, outputTokens: 2 }, estimatedCostUsd: 0.01 };
  } },
  conduct: { outputGuard: { onFinal() {
    return ++finalChecks === 1 ? { action: 'regenerate' } : { action: 'pass' };
  } } },
}).run([
  { role: 'user', content: [{ type: 'text', text: 'old '.repeat(2000) }] },
  { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
  { role: 'user', content: [{ type: 'text', text: 'latest request' }] },
]));
assert.equal(guardedCalls, 2);
assert.equal(regeneratedBudget.snapshot().accountedTokens, 14);
assert.equal(regeneratedBudget.snapshot().tokenUsageComplete, true);
assert.equal(regeneratedBudget.snapshot().unknownRequests, 0);
assert.equal(regenerated.terminal.reason, 'completed');
assert.deepEqual(regenerated.usage, { inputTokens: 24, outputTokens: 12 });
assert.equal(regenerated.usageComplete, true);
assert.ok(Math.abs(regenerated.estimatedCostUsd - 0.0200057) < 1e-9);

console.log('SDK_CONTRACT_OK');
