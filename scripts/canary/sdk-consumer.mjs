// Runtime-agnostic external consumer of @yevgetman/sov-sdk (spec §9.3 — the
// headline acceptance gate). Imports ONLY via the public package entry (no
// deep paths) so it exercises the exports map exactly as an external app
// would: bun resolves the "bun" condition (TypeScript src), node resolves the
// "import" condition (compiled dist). Runs under BOTH. NO bun:test, NO
// import.meta.main — a plain script.
//
// Ports the echoProvider pattern from examples/embed/embed.ts (types
// stripped): a scripted no-network LLMProvider replaying a tool_use turn then
// a final text turn, driven through createAgent() with the IN-MEMORY session
// store — a full agent turn (including tool dispatch) with no API key and no
// disk writes. Deliberately self-contained: an external consumer cannot reach
// repo test helpers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { buildTool, createAgent, createInMemorySessionStore, CapabilityProfileRegistry, TreeBudget, SubagentScheduler, LaneSemaphores, PathLockManager } from '@yevgetman/sov-sdk';
// The one deliberate deep-subpath import in this otherwise barrel-only consumer:
// the F17/F18/F19 regression guard (asserted at the end) needs VERSION, which
// lives at the `./version` public subpath, not on the frozen `./sdk` barrel.
import { VERSION } from '@yevgetman/sov-sdk/version';
import { z } from 'zod';

/** The one user turn this canary runs. */
const QUESTION = 'echo this please';

/** The deterministic sentinel the scripted provider ends the turn with. */
const SENTINEL = `Echoed: ${QUESTION}`;

// ── Resolution probe: pin which exports condition THIS runtime resolved ─────
// Guarded because import.meta.resolve is unflagged only on node >= 20.6 (the
// package engines allow >= 20). Where available, the dual-condition contract
// is asserted, not assumed.
if (typeof import.meta.resolve === 'function') {
  const resolved = import.meta.resolve('@yevgetman/sov-sdk');
  const isBun = typeof process.versions.bun === 'string';
  const expectedSuffix = isBun ? '/src/sdk.ts' : '/dist/sdk.js';
  assert.ok(
    resolved.endsWith(expectedSuffix),
    `expected ${isBun ? 'bun' : 'node'} to resolve the '${isBun ? 'bun' : 'import'}' condition (…${expectedSuffix}), got ${resolved}`,
  );
  console.log(`resolved entry (${isBun ? 'bun' : 'node'}): ${resolved}`);
}

// ── No-disk assertion setup: snapshot the scratch cwd before the turn ───────
const filesBefore = readdirSync('.').sort();

/** A trivial tool: echoes its `text` input straight back. Wired into the agent
 *  so the canary exercises the full tool-dispatch path (no disk, no real I/O). */
const echoTool = buildTool({
  name: 'Echo',
  description: () => 'Echo the given text back to the caller.',
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    return { data: { echoed: input.text } };
  },
});

/** Build a fresh mock LLMProvider that replays one scripted turn per
 *  successive `stream()` call (generators are single-use). Turn 1 requests the
 *  Echo tool; turn 2 emits the final assistant text. No network, no key. */
function echoProvider() {
  const toolUseTurn = [
    { type: 'message_start' },
    { type: 'tool_use_delta', id: 't1', partial: `{"text":"${QUESTION}"}` },
    { type: 'message_stop', stop_reason: 'tool_use' },
    {
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: QUESTION } }],
      },
    },
  ];
  const finalTurn = [
    { type: 'message_start' },
    { type: 'text_delta', text: SENTINEL },
    { type: 'usage_delta', usage: { inputTokens: 8, outputTokens: 4 } },
    { type: 'message_stop', stop_reason: 'end_turn' },
    {
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: SENTINEL }] },
    },
  ];
  const queue = [toolUseTurn, finalTurn];
  return {
    name: 'echo',
    async *stream() {
      const events = queue.shift();
      if (events === undefined) {
        throw new Error('echoProvider: no scripted turn left');
      }
      let last;
      for (const ev of events) {
        if (ev.type === 'assistant_message') {
          last = ev.message;
        }
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

// ── One full agent turn, in-memory persistence only ──────────────────────────
const agent = createAgent({
  provider: echoProvider(),
  model: 'echo-model',
  systemPrompt: 'You echo what you are given.',
  maxTokens: 256,
  tools: [echoTool],
  // In-memory: nothing is written to disk (no bun:sqlite SessionDb).
  sessionStore: createInMemorySessionStore(),
});

const gen = agent.run(QUESTION);
let result;
for (;;) {
  const step = await gen.next();
  if (step.done) {
    result = step.value;
    break;
  }
}

const finalText = (result.finalAssistant?.content ?? [])
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('');
assert.ok(
  finalText.includes(SENTINEL),
  `final assistant text should contain '${SENTINEL}', got: ${JSON.stringify(finalText)}`,
);

// Public child-policy and shared-budget behavior against the installed package.
const profiles = new CapabilityProfileRegistry([{ name: 'echo-only', tools: ['Echo'] }]);
assert.deepEqual(profiles.filter('echo-only', [echoTool], 'chat'), []);
assert.equal(profiles.filter('echo-only', [echoTool]).length, 1);
const treeBudget = new TreeBudget({ maxDepth: 1, maxTotalChildren: 1, maxTotalTokens: 5000 });
const childDefinition = {
  name: 'echo-child', description: 'offline child', systemPrompt: 'echo',
  allowedTools: ['Echo'], capabilityProfile: 'echo-only', maxTurns: 3, readOnly: true,
  supportsMissionState: false, inheritParentTools: false, allowedSubagents: [],
  path: '/unused', realpath: '/unused', dir: '/', source: 'bundle', trustTier: 'builtin',
};
const childScheduler = new SubagentScheduler({
  agents: { agents: [childDefinition], byName: new Map([[childDefinition.name, childDefinition]]) },
  laneSemaphores: new LaneSemaphores({ frontier: 1 }), pathLock: new PathLockManager(),
  resolveProvider: () => ({ transport: echoProvider(), client: {}, model: 'echo-model',
    contextLength: 32000, authType: 'none', baseUrl: 'offline://', metadata: {} }),
  createChildSession: () => 'consumer-child', defaultProvider: 'openai', defaultModel: 'echo-model', maxTokens: 256,
  childPolicy: { capabilityProfiles: profiles, profile: 'coding', treeBudget,
    estimateRequestBudget: () => ({ tokens: 1000 }) },
});
const childInput = { agentName: 'echo-child', prompt: QUESTION, parentSessionId: 'consumer-parent',
  parentToolPool: [echoTool], parentToolContext: { cwd: process.cwd(), sessionId: 'consumer-parent' } };
const child = await childScheduler.delegate(childInput);
assert.equal(child.terminal.reason, 'completed');
assert.equal(child.summary, SENTINEL);
assert.equal(child.usage.inputTokens, 8);
assert.equal(child.usageStatus, 'partial'); // The first provider call reported no usage.
assert.equal(child.estimatedCostUsd, undefined); // An unknown price is not free.
assert.equal(treeBudget.snapshot().unknownRequests, 2);
assert.equal(treeBudget.snapshot().activeChildren, 0);
assert.equal(treeBudget.snapshot().estimatedCostComplete, false);
await assert.rejects(childScheduler.delegate(childInput), /total children/);

// ── No-disk assertion: the scratch cwd gained NO files (.db/.sqlite/session
// artifacts would show up here) ──────────────────────────────────────────────
const filesAfter = readdirSync('.').sort();
assert.deepEqual(filesAfter, filesBefore, 'the agent turn must not create files in the consumer cwd');

// ── F17/F18/F19 regression guard: an installed SDK must report its OWN bare
// version, never a suffix derived from the CONSUMER's git HEAD. The canary runs
// this script from inside a scratch *git repo* (see run-consumer-canary), so a
// regressed version.ts ownership gate would surface here as `<pkgVersion>-<consumerSHA>`
// — the exact leak that reaches remote MCP servers and on-disk transcripts. The
// expected value is the installed package's OWN package.json version (read from
// node_modules), so this guard tracks every release bump instead of pinning a
// literal: a leaked `-<sha>` suffix still fails the equality.
const bareVersion = createRequire(import.meta.url)('@yevgetman/sov-sdk/package.json').version;
assert.equal(
  VERSION,
  bareVersion,
  `installed SDK VERSION must be the bare package version with no consumer-SHA suffix, got: ${VERSION}`,
);

console.log('SDK_OK');
