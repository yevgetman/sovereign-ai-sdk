// Phase F channel-pipeline defect fixes (holistic-review follow-up).
//
// Four correctness/UX defects in `runChannelTurn`, each pinned here TDD-style:
//
//   Fix 1 — channel turns get NO recall + NO MEMORY.md. The pipeline built its
//     AgentRunner without memoryManager/recall, so a channel turn never injected
//     MEMORY.md, never ran recall, never wrote memory back. These tests prove a
//     channel turn now injects the owner-scoped MEMORY.md AND the recalled
//     `<learned-context>` block into the provider request.
//
//   Fix 2 — context overflow permanently bricks a channel conversation, silently.
//     (a) the seeded history is capped to a bounded tail (so a long conversation
//     never overflows) with pairing-safe truncation (no leading orphan
//     tool_result); (b) a non-completed terminal yields a NON-silent fallback
//     reply instead of pure silence.
//
//   Fix 3 — concurrent messages from the same sender race on the shared
//     SessionContext (double-dispose). Two concurrent runChannelTurn on the SAME
//     sessionId now serialize: exactly one trajectory write per turn, the second
//     turn sees the first's persisted reply, no "disposed context" error.
//
//   Fix 4 — empty/whitespace inbound text runs a billable turn. A central guard
//     returns { silent: true } BEFORE persisting / calling the provider.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChannelTurn } from '../../src/channels/pipeline.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
import type { Message } from '../../src/core/types.js';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import type { Instinct } from '../../src/learning/types.js';
import { replaceMemoryFile } from '../../src/memory/bounded.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';
import { resolveSubagentArtifactsRoot } from '../../src/server/runtime.js';

const TG_MSG: InboundMessage = {
  channel: 'telegram',
  sender: 'u1',
  chatId: 'c1',
  chatType: 'private',
  text: 'hello',
};

const PRINCIPAL = 'tg-bot';

function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.lastMaxTokens = undefined;
  MockProvider.lastSignal = undefined;
  MockProvider.throwOnNext = undefined;
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

/** Flatten every text block the provider received into one searchable string. */
function flattenProviderText(messages: Message[] | undefined): string {
  if (messages === undefined) return '';
  return messages
    .flatMap((m) => m.content)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

describe('runChannelTurn — Fix 1: recall + MEMORY.md threaded into the channel turn', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-fix1-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_HOME = home;
    __test_resetProjectIdCache();
    resetMockProviderStatics();
  });

  afterEach(async () => {
    if (runtime) await runtime.dispose();
    resetMockProviderStatics();
    __test_resetProjectIdCache();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    // biome-ignore lint/performance/noDelete: config override must be unset, not assigned undefined.
    delete process.env.HARNESS_CONFIG;
    rmSync(home, { recursive: true, force: true });
  });

  test('MEMORY.md (owner-scoped) is injected into the provider request', async () => {
    // Seed MEMORY.md under the CHANNEL PRINCIPAL namespace (the owner the
    // pipeline stamps) so the owner-scoped memory manager reads it.
    replaceMemoryFile('MEMORY.md', 'CHANNEL-OWNER-MEMORY-BODY', home, PRINCIPAL);
    runtime = await buildTestRuntime(home);

    MockProvider.lastMessages = undefined;
    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    const seenText = flattenProviderText(MockProvider.lastMessages);
    // The route now threads sessionCtx.memoryManager into query() so MEMORY.md
    // injects on the channel surface too (was omitted → this was the bug).
    expect(seenText).toContain('<memory-context>');
    expect(seenText).toContain('CHANNEL-OWNER-MEMORY-BODY');
  });

  test('recall fires — a recalled lesson reaches the provider request', async () => {
    // Recall is ON by default, but make it explicit so the test is robust to a
    // future default flip. Seed a global instinct whose trigger overlaps the
    // user text and prove the rendered <learned-context> reaches the provider.
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ learning: { recall: { enabled: true } } }));
    process.env.HARNESS_CONFIG = configPath;

    // Seed a global instinct under the channel principal's learning namespace.
    const { createFsPersist } = await import(
      '../../src/learning-layer/adapters/harness/persistFs.js'
    );
    const { serializeInstinct } = await import('../../src/learning/instinctSerde.js');
    const instinct: Instinct = {
      id: 'chcmd',
      trigger: 'reply to the user',
      action: 'keep replies short and friendly',
      confidence: 0.9,
      evidence_count: 3,
      domain: 'workflow',
      scope: 'global',
      project_id: null,
      project_name: null,
      created_at: '2026-06-03T00:00:00.000Z',
      last_evidence_at: '2026-06-03T00:00:00.000Z',
      observation_ids: ['o1', 'o2', 'o3'],
    };
    const persist = createFsPersist(home);
    // The channel principal scopes recall under users/{principal}/learning/_global.
    await persist.write(
      `users/${PRINCIPAL}/learning/_global/instincts/chcmd.md`,
      serializeInstinct(instinct, ''),
    );

    runtime = await buildTestRuntime(home);

    const recallMsg: InboundMessage = { ...TG_MSG, text: 'please reply to the user now' };
    MockProvider.lastMessages = undefined;
    await runChannelTurn({ runtime, msg: recallMsg, principalId: PRINCIPAL });

    const seenText = flattenProviderText(MockProvider.lastMessages);
    expect(seenText).toContain('<learned-context>');
    expect(seenText).toContain('keep replies short and friendly');
  });

  test('memory write-back fires — the turn syncs the exchange into MEMORY history', async () => {
    // query() only calls memoryManager.syncTurn when memoryManager is passed.
    // Spy on the live session context's memory manager to prove the write-back
    // path is reached on a channel turn (was silently skipped pre-fix).
    runtime = await buildTestRuntime(home);
    const sessionId = buildSessionKey(TG_MSG);
    const ctx = runtime.getSessionContext(sessionId);
    let syncCalls = 0;
    const realSync = ctx.memoryManager.syncTurn.bind(ctx.memoryManager);
    ctx.memoryManager.syncTurn = async (u, a) => {
      syncCalls += 1;
      return realSync(u, a);
    };

    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    expect(syncCalls).toBeGreaterThan(0);
  });
});

describe('runChannelTurn — Fix 2: history cap + non-silent error on bad terminal', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-fix2-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_HOME = home;
    __test_resetProjectIdCache();
    resetMockProviderStatics();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    __test_resetProjectIdCache();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('(a) a long history is capped to a bounded tail before seeding', async () => {
    const sessionId = buildSessionKey(TG_MSG);
    // Pre-seed a LONG history directly into the DB: 200 alternating user/
    // assistant messages. The pipeline must NOT seed all of them.
    runtime.sessionDb.upsertSession({
      sessionId,
      owner: PRINCIPAL,
      platform: TG_MSG.channel,
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      systemPrompt: runtime.systemSegments,
      metadata: { kind: 'channel', channel: TG_MSG.channel, sender: TG_MSG.sender },
      title: `${TG_MSG.channel}:${TG_MSG.sender}`,
    });
    for (let i = 0; i < 100; i++) {
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: `old user message ${i}` }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: `old assistant reply ${i}` }],
      });
    }
    const persistedBefore = runtime.sessionDb.loadMessages(sessionId).length;
    expect(persistedBefore).toBe(200);

    MockProvider.lastMessages = undefined;
    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    const seen = MockProvider.lastMessages ?? [];
    // The provider request must be bounded well below the full 201-message
    // history (200 prior + the new user message). The cap is ~40 messages;
    // assert a generous upper bound so the exact constant can move.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(60);
    expect(seen.length).toBeLessThan(persistedBefore);
  });

  test('(a) pairing-safe — the seed never starts with an orphan tool_result', async () => {
    const sessionId = buildSessionKey(TG_MSG);
    runtime.sessionDb.upsertSession({
      sessionId,
      owner: PRINCIPAL,
      platform: TG_MSG.channel,
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      systemPrompt: runtime.systemSegments,
      metadata: { kind: 'channel', channel: TG_MSG.channel, sender: TG_MSG.sender },
      title: `${TG_MSG.channel}:${TG_MSG.sender}`,
    });
    // Build a long history where, AT the cap boundary, a tool_result would be
    // the first seeded message unless the truncation drops the orphan. Fill
    // with enough messages that the tail starts mid tool_use/tool_result pair.
    for (let i = 0; i < 60; i++) {
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [
          { type: 'text', text: `turn ${i}` },
          { type: 'tool_use', id: `tu-${i}`, name: 'Bash', input: { command: 'echo hi' } },
        ],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu-${i}`, content: 'hi', is_error: false }],
      });
    }

    MockProvider.lastMessages = undefined;
    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    const seen: Message[] = MockProvider.lastMessages ?? [];
    expect(seen.length).toBeGreaterThan(0);
    // The FIRST seeded message must not be a user message whose first block is
    // a tool_result with no preceding assistant tool_use in the seed — a
    // provider would reject a dangling tool_result.
    const first = seen[0];
    const firstIsOrphanToolResult =
      first?.role === 'user' &&
      Array.isArray(first.content) &&
      first.content.some((b) => b.type === 'tool_result');
    expect(firstIsOrphanToolResult).toBe(false);
  });

  test('(b) a non-completed terminal yields a NON-silent fallback reply', async () => {
    // Script the model to THROW on its first call → AgentRunner returns a
    // terminal { reason: 'error' } with no usable assistant text. Pre-fix this
    // returned { silent: true } (pure silence + a bricked conversation).
    MockProvider.toolUseScript = [{ kind: 'throw', message: 'simulated provider failure' }];
    MockProvider.resetScriptCursor();

    const result = await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    // The user must get a user-facing fallback, NOT silence.
    expect(result.silent).toBeUndefined();
    expect(typeof result.text).toBe('string');
    expect((result.text ?? '').length).toBeGreaterThan(0);
  });
});

describe('runChannelTurn — Fix 3: per-session serialization (no double-dispose race)', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-fix3-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_HOME = home;
    __test_resetProjectIdCache();
    resetMockProviderStatics();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    __test_resetProjectIdCache();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('two concurrent turns on the same session run sequentially (one trajectory each)', async () => {
    const sessionId = buildSessionKey(TG_MSG);

    // Fire two turns concurrently on the SAME (channel, sender) → same session
    // id. Without serialization, both share the cached SessionContext and the
    // first to finish disposes the trace/trajectory writers while the second is
    // still live — a double trajectory write + a context disposed under a
    // running turn.
    const [r1, r2] = await Promise.all([
      runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL }),
      runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL }),
    ]);

    // Both turns produced a reply, neither threw.
    expect(r1.text).toBe('Hello world.');
    expect(r2.text).toBe('Hello world.');

    // Exactly two trajectory records were written (one per turn) — proving the
    // turns did not race the same SessionContext into a double/lost write. Each
    // disposeSession run flushes one trajectory line.
    const artifactsRoot = resolveSubagentArtifactsRoot(runtime.harnessHome, runtime.bundle);
    const samplesPath = join(artifactsRoot, 'trajectories', 'samples.jsonl');
    const lines = readFileSync(samplesPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);

    // The second turn saw the first's persisted assistant reply in its history:
    // the final transcript has BOTH turns' user + assistant messages (4 rows).
    const persisted = runtime.sessionDb.loadMessages(sessionId);
    expect(persisted.length).toBe(4);
    expect(persisted.filter((m) => m.role === 'user').length).toBe(2);
    expect(persisted.filter((m) => m.role === 'assistant').length).toBe(2);
  });

  test('concurrent turns on DIFFERENT sessions still run (no global lock)', async () => {
    // Serialization must be PER-session, not global — two different senders run
    // concurrently without one blocking the other.
    const msgA: InboundMessage = { ...TG_MSG, sender: 'a', chatId: 'ca' };
    const msgB: InboundMessage = { ...TG_MSG, sender: 'b', chatId: 'cb' };

    const [ra, rb] = await Promise.all([
      runChannelTurn({ runtime, msg: msgA, principalId: PRINCIPAL }),
      runChannelTurn({ runtime, msg: msgB, principalId: PRINCIPAL }),
    ]);

    expect(ra.text).toBe('Hello world.');
    expect(rb.text).toBe('Hello world.');
    expect(runtime.sessionDb.getSession(buildSessionKey(msgA))).not.toBeNull();
    expect(runtime.sessionDb.getSession(buildSessionKey(msgB))).not.toBeNull();
  });
});

describe('runChannelTurn — Fix 4: empty/whitespace inbound text is a no-op', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-fix4-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_HOME = home;
    __test_resetProjectIdCache();
    resetMockProviderStatics();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    __test_resetProjectIdCache();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('empty text → { silent: true }, no turn, no persisted row', async () => {
    MockProvider.streamCalls = 0;
    const sessionId = buildSessionKey(TG_MSG);

    const result = await runChannelTurn({
      runtime,
      msg: { ...TG_MSG, text: '' },
      principalId: PRINCIPAL,
    });

    expect(result.silent).toBe(true);
    expect(result.text).toBeUndefined();
    // No provider call, no session row, no persisted user message.
    expect(MockProvider.streamCalls).toBe(0);
    expect(runtime.sessionDb.getSession(sessionId)).toBeNull();
  });

  test('whitespace-only text → { silent: true }, no turn, no persisted row', async () => {
    MockProvider.streamCalls = 0;
    const sessionId = buildSessionKey(TG_MSG);

    const result = await runChannelTurn({
      runtime,
      msg: { ...TG_MSG, text: '   \n\t  ' },
      principalId: PRINCIPAL,
    });

    expect(result.silent).toBe(true);
    expect(result.text).toBeUndefined();
    expect(MockProvider.streamCalls).toBe(0);
    expect(runtime.sessionDb.getSession(sessionId)).toBeNull();
  });
});
