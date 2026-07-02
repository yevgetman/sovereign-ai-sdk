// Task 4.3 — channel re-seat onto `createAgent()` (was `new AgentRunner(...).run()`).
//
// Two layers of proof, mirroring the cron re-seat (Task 4.2) but adapted to the
// ONE structural difference between the two surfaces:
//
//   A. Field-level parity (unit) — `buildChannelAgentConfig` maps every prior
//      `AgentRunner` opt 1:1 to the `AgentConfig`, AND lands the single
//      CEO-ratified parity-fix the AgentRunner surface could not carry:
//        • microcompactConfig — the channel path previously inherited query()'s
//          built-in DEFAULT_MICROCOMPACT_CONFIG; it now carries the runtime's
//          settings-derived value.
//      It carries NO `transcripts` and NO `sessionStore` — UNLIKE cron. The
//      channel pipeline already persists + transcribes each turn's user +
//      final-assistant message via its own `persistMessage` calls (outside the
//      agent loop), so routing a store through createAgent would DOUBLE-write.
//      These unit tests pin that deliberate asymmetry.
//
//   B. Behavioral parity (integration, through the real runtime + MockProvider):
//        • a channel turn yields the SAME final reply + completed terminal as
//          before ("Hello world.", non-silent) and persists user + assistant;
//        • the session transcript is written EXACTLY ONCE per message (1 user +
//          1 assistant record) — proving channels still transcribes (via
//          persistMessage) and createAgent does NOT additionally transcribe
//          (the no-double-write discriminator);
//        • the error path: a turn whose provider throws RETURNS the channel's
//          UNCHANGED non-silent fallback (it does NOT propagate), the in-memory
//          context is still disposed, and the DB row persists. This confirms the
//          createAgent throw→error-terminal conversion matches AgentRunner's
//          (Task 4.1 error-path rule, case (a): no control-flow change).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MicrocompactConfig } from '@yevgetman/sov-sdk/compact/microcompact';
import type { RecallTurn, SystemSegment } from '@yevgetman/sov-sdk/core/types';
import type { MemoryRuntime } from '@yevgetman/sov-sdk/memory/provider';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import {
  type ChannelAgentConfigInput,
  buildChannelAgentConfig,
  runChannelTurn,
} from '../../src/channels/pipeline.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

// ── Part A — buildChannelAgentConfig field-level parity (unit) ─────────────────

/** Distinct sentinel objects so every assertion can prove reference-identity
 *  pass-through (the re-seat must hand the SAME value through, not a copy). */
function makeInput(overrides: Partial<ChannelAgentConfigInput> = {}): {
  input: ChannelAgentConfigInput;
  provider: LLMProvider;
  systemPrompt: SystemSegment[];
  tools: Tool<unknown, unknown>[];
  memoryManager: MemoryRuntime;
  microcompactConfig: MicrocompactConfig;
} {
  const provider = { name: 'sentinel-provider' } as unknown as LLMProvider;
  const systemPrompt: SystemSegment[] = [{ text: 'channel system', cacheable: true }];
  const tools = [{ name: 'sentinel-tool' }] as unknown as Tool<unknown, unknown>[];
  const memoryManager = { id: 'sentinel-memory' } as unknown as MemoryRuntime;
  const microcompactConfig: MicrocompactConfig = {
    enabled: true,
    keepRecent: 3,
    triggerThresholdPct: 25,
    compactableTools: new Set(['Bash']),
  };
  const input: ChannelAgentConfigInput = {
    provider,
    model: 'mock-model',
    effort: 'medium',
    systemPrompt,
    maxTokens: 4096,
    cwd: '/channel/cwd',
    tools,
    memoryManager,
    microcompactConfig,
    ...overrides,
  };
  return { input, provider, systemPrompt, tools, memoryManager, microcompactConfig };
}

describe('buildChannelAgentConfig — field-level parity with the prior AgentRunner opts', () => {
  test('maps every standing field 1:1 by value/reference', () => {
    const { input, provider, systemPrompt, tools, memoryManager } = makeInput();
    const config = buildChannelAgentConfig(input);

    expect(config.provider).toBe(provider);
    expect(config.model).toBe('mock-model');
    expect(config.effort).toBe('medium');
    expect(config.systemPrompt).toBe(systemPrompt);
    expect(config.maxTokens).toBe(4096);
    expect(config.cwd).toBe('/channel/cwd');
    expect(config.tools).toBe(tools);
    expect(config.memoryManager).toBe(memoryManager);
    // Pinned to the channel-default turn ceiling the AgentRunner path also passed.
    expect(config.maxTurns).toBe(10);
  });

  test('PARITY-FIX: microcompactConfig is threaded onto the config', () => {
    const { input, microcompactConfig } = makeInput();
    const config = buildChannelAgentConfig(input);
    // AgentRunner had no such field → the channel path ran on query()'s built-in
    // default; the re-seat carries the runtime's settings-derived value verbatim.
    expect(config.microcompactConfig).toBe(microcompactConfig);
  });

  test('recall is conditionally spread (present when supplied, absent when omitted)', () => {
    const recall = (() => {}) as unknown as RecallTurn;
    const withRecall = buildChannelAgentConfig(makeInput({ recall }).input);
    expect(withRecall.recall).toBe(recall);

    const withoutRecall = buildChannelAgentConfig(makeInput().input);
    expect('recall' in withoutRecall).toBe(false);
  });

  test('NEVER passes transcripts (channels transcribes via persistMessage — no double-write)', () => {
    const config = buildChannelAgentConfig(makeInput().input);
    // UNLIKE cron: the channel pipeline already transcribes each turn's user +
    // final-assistant message via its own persistMessage calls. Routing the
    // store through createAgent too would double-transcribe.
    expect('transcripts' in config).toBe(false);
  });

  test('NEVER passes a sessionStore (channels persists via persistMessage)', () => {
    const config = buildChannelAgentConfig(makeInput().input);
    // The channel pipeline owns its own DB persistence (persistMessage →
    // sessionDb.saveMessage). Adding createAgent's persistTurn would double the
    // message rows AND re-persist the hydrated history seed — not parity.
    expect('sessionStore' in config).toBe(false);
  });
});

// ── Part B — behavioral parity through runChannelTurn ─────────────────────────

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
  MockProvider.throwOnNext = undefined;
  MockProvider.streamCalls = 0;
}

/** Recursively collect every `.jsonl` transcript file under a root. Channel
 *  sessions are owner-scoped, so they live under `<base>/users/<owner>/...`,
 *  NOT under the unowned `projectsDir` — walk the whole home to find them. */
function collectJsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsonl(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** Every transcript record belonging to `sessionId` across all JSONL files. */
function sessionTranscriptRecords(root: string, sessionId: string): { type: string }[] {
  const records: { type: string }[] = [];
  for (const file of collectJsonl(root)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const rec = JSON.parse(line) as { type: string; sessionId?: string };
      if (rec.sessionId === sessionId) records.push(rec);
    }
  }
  return records;
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

describe('channel re-seat — behavioral parity through runChannelTurn', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-reseat-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_HOME = home;
    resetMockProviderStatics();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('a channel turn yields the same reply + persists user + assistant', async () => {
    const result = await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    // Same final reply + non-silent (completed-terminal proxy) as the AgentRunner path.
    expect(result.text).toBe('Hello world.');
    expect(result.silent).toBeUndefined();

    // Conversation persisted on the reused row: user + assistant (unchanged).
    const sessionId = buildSessionKey(TG_MSG);
    const persisted = runtime.sessionDb.loadMessages(sessionId);
    expect(persisted.filter((m) => m.role === 'user').length).toBe(1);
    expect(persisted.filter((m) => m.role === 'assistant').length).toBe(1);
  });

  test('PARITY: the turn is transcribed EXACTLY ONCE (no double-write via createAgent)', async () => {
    const sessionId = buildSessionKey(TG_MSG);

    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    // The channel pipeline transcribes via persistMessage (1 user + 1 assistant).
    // If the re-seat had ALSO routed `transcripts` through createAgent, the
    // persistTurn walk would add a second user + assistant record. Exactly one of
    // each proves the transcript is written once — the no-double-write contract.
    const records = sessionTranscriptRecords(home, sessionId);
    expect(records.filter((r) => r.type === 'user').length).toBe(1);
    expect(records.filter((r) => r.type === 'assistant').length).toBe(1);
    // And the session was transcribed at all (parity — channels still writes it).
    expect(records.length).toBeGreaterThan(0);
  });

  test('error path: a turn whose provider throws RETURNS the non-silent fallback', async () => {
    const sessionId = buildSessionKey(TG_MSG);

    // Prove the finally still disposes the in-memory context on the error path.
    const disposed: string[] = [];
    const realDispose = runtime.disposeSession;
    runtime.disposeSession = async (id, opts) => {
      disposed.push(id);
      return realDispose(id, opts);
    };

    // The provider throws on the turn's first stream() call. createAgent converts
    // it to terminal.reason:'error' (exactly as AgentRunner did) — so the turn
    // RETURNS a non-silent fallback rather than propagating the throw.
    MockProvider.throwOnNext = new Error('channel-boom');

    // Must not reject — the error is absorbed into a user-facing fallback.
    const result = await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    // Non-silent fallback (no pure silence on error), and it never leaks the
    // internal error detail over the untrusted channel.
    expect(result.silent).toBeUndefined();
    expect(typeof result.text).toBe('string');
    expect((result.text ?? '').length).toBeGreaterThan(0);
    expect(result.text).not.toContain('channel-boom');

    // Control flow preserved: the finally disposed the in-memory context, and
    // the DB row persists (the conversation is not bricked).
    expect(disposed).toContain(sessionId);
    expect(runtime.sessionDb.getSession(sessionId)).not.toBeNull();

    runtime.disposeSession = realDispose;
  });
});
