// Cron learning-loop participation regression — the cron turn path must inject
// MEMORY.md, run recall, and write memory back, exactly like the interactive
// turns route and the channel pipeline.
//
// This is the SAME omission the Phase-F channel fix (commit e23b869) closed for
// channels: `src/cron/wiring.ts` built its headless AgentRunner WITHOUT
// `memoryManager`/`recall`, so a scheduled job never injected MEMORY.md, never
// ran recall (`<learned-context>`), and never wrote memory back. The fix sources
// the cron session's SessionContext via `runtime.getSessionContext(sessionId)`
// (the same cached context `buildSessionToolContext` already builds) and threads
// `sessionCtx.memoryManager` + the conditional `sessionCtx.recall` into the
// AgentRunner.
//
// Cron sessions are owner-null/implicit → the legacy/global memory + learning
// namespace (correct for operator-scheduled jobs, which have no channel
// principal). So MEMORY.md is seeded at `<home>/memory/MEMORY.md` and the
// instinct under `learning/_global/instincts/...` — the un-prefixed legacy keys.
//
// These tests prove all three contracts deterministically (no LLM variance) by
// inspecting `MockProvider.lastMessages` (the exact request the provider saw)
// and by spying on the cron session's memoryManager.syncTurn (write-back).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@yevgetman/sov-sdk/core/types';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { addJob } from '../../src/cron/jobs.js';
import { createProductionCronRunner } from '../../src/cron/wiring.js';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';
import { serializeInstinct } from '../../src/learning/instinctSerde.js';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import type { Instinct } from '../../src/learning/types.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';
import { buildSessionContext } from '../../src/server/sessionContext.js';

const MEMORY_BODY = 'Always prefer ripgrep over grep in this cron-run repo.';
const INSTINCT_TRIGGER = 'run the nightly report';
const INSTINCT_ACTION = 'aggregate the metrics before emailing';
const JOB_PROMPT = 'please run the nightly report now';

/** A global-scope instinct in the LEGACY (owner-null) corpus — exactly where a
 *  cron session's recall reads (no user prefix). Its trigger lexically overlaps
 *  the job prompt so the token-overlap recall assembler surfaces it. */
function buildGlobalInstinct(): Instinct {
  return {
    id: 'nightlycmd',
    trigger: INSTINCT_TRIGGER,
    action: INSTINCT_ACTION,
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
}

async function seedGlobalInstinct(home: string): Promise<void> {
  const persist = createFsPersist(home);
  await persist.write(
    'learning/_global/instincts/nightlycmd.md',
    serializeInstinct(buildGlobalInstinct(), ''),
  );
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

describe('cron wiring — learning-loop participation (MEMORY.md + recall + write-back)', () => {
  let home: string;
  let runtime: Runtime | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-cron-recall-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_HOME = home;
    __test_resetProjectIdCache();
    resetMockProviderStatics();
  });

  afterEach(async () => {
    if (runtime) await runtime.dispose();
    runtime = undefined;
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

  test('MEMORY.md (legacy namespace) is injected into the cron provider request', async () => {
    // Single-entry script → one stream() call → no tool loop, so lastMessages is
    // exactly the turn-0 request with memory injected.
    MockProvider.toolUseScript = [{ kind: 'text', text: 'done.' }];
    MockProvider.resetScriptCursor();

    // Owner-null cron session → legacy top-level memory path.
    mkdirSync(join(home, 'memory'), { recursive: true });
    writeFileSync(join(home, 'memory', 'MEMORY.md'), MEMORY_BODY);

    // cron OFF so the production runner doesn't tick behind our back; drive
    // runDueJobs() directly via the public factory.
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: home,
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });

    const job = addJob(home, {
      prompt: JOB_PROMPT,
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });

    MockProvider.lastMessages = undefined;
    const runner = createProductionCronRunner(runtime, home);
    await runner.runDueJobs();
    expect(job.id).toBeDefined();

    const seenText = flattenProviderText(MockProvider.lastMessages);
    // formatMemorySnapshot wraps the body in a <memory-context> fence — assert
    // both the fence and the body so the proof pins that the file content
    // actually reached the provider (was omitted pre-fix → this was the bug).
    expect(seenText).toContain('<memory-context>');
    expect(seenText).toContain(MEMORY_BODY);
  });

  test('recall fires — a recalled lesson reaches the cron provider request', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: 'done.' }];
    MockProvider.resetScriptCursor();

    // Recall is ON by default, but make it explicit so the test is robust to a
    // future default flip.
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ learning: { recall: { enabled: true } } }));
    process.env.HARNESS_CONFIG = configPath;

    await seedGlobalInstinct(home);

    runtime = await buildRuntime({
      harnessHome: home,
      cwd: home,
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });

    const job = addJob(home, {
      prompt: JOB_PROMPT,
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });

    MockProvider.lastMessages = undefined;
    const runner = createProductionCronRunner(runtime, home);
    await runner.runDueJobs();
    expect(job.id).toBeDefined();

    const seenText = flattenProviderText(MockProvider.lastMessages);
    expect(seenText).toContain('<learned-context>');
    expect(seenText).toContain(INSTINCT_ACTION);
    expect(seenText).toContain(INSTINCT_TRIGGER);
  });

  test('memory write-back fires — the cron turn syncs the exchange via syncTurn', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: 'done.' }];
    MockProvider.resetScriptCursor();

    // query() only calls memoryManager.syncTurn when memoryManager is passed.
    // The cron session id is minted fresh inside runAgent, so we can't grab it
    // by id ahead of time (as the channel test does). Instead, wrap the
    // SessionContext factory to spy on whatever context the cron session builds
    // and count syncTurn invocations.
    let syncCalls = 0;
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: home,
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      sessionContextFactory: (sessionId) => {
        const ctx = buildSessionContext({ runtime: runtime as Runtime, sessionId });
        const realSync = ctx.memoryManager.syncTurn.bind(ctx.memoryManager);
        ctx.memoryManager.syncTurn = async (u, a) => {
          syncCalls += 1;
          return realSync(u, a);
        };
        return ctx;
      },
    });

    const job = addJob(home, {
      prompt: JOB_PROMPT,
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });

    const runner = createProductionCronRunner(runtime, home);
    await runner.runDueJobs();
    expect(job.id).toBeDefined();

    // syncTurn is only reached when query() received memoryManager — proves the
    // cron path now threads it (was silently skipped pre-fix).
    expect(syncCalls).toBeGreaterThan(0);
  });
});
