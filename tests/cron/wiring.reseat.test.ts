// Task 4.2 — cron re-seat onto `createAgent()` (was `new AgentRunner(...).run()`).
//
// Two layers of proof:
//
//   A. Field-level parity (unit) — `buildCronAgentConfig` maps every prior
//      `AgentRunner` opt 1:1 to the `AgentConfig`, AND lands the two CEO-ratified
//      parity-fixes the AgentRunner surface structurally could not carry:
//        • microcompactConfig — cron previously inherited query()'s built-in
//          DEFAULT_MICROCOMPACT_CONFIG; it now carries the runtime's
//          settings-derived value (this is the fix, proven structurally because a
//          cold-start cron turn — a single user-text prompt — can never exhibit
//          microcompaction eviction: every tool_result is in the current burst,
//          so `findCurrentTurnBoundary` excludes them all from clearing).
//        • transcripts — present only when the runtime supplies a store.
//
//   B. Behavioral parity (integration, through the real runtime + MockProvider):
//        • a cron turn yields the SAME final assistant text + completed terminal
//          as before (ok:true / "Hello world.");
//        • a transcript JSONL is now written for the cron session (the fix);
//        • the error path: a turn whose provider throws yields cron's UNCHANGED
//          job-completion behavior — runAgent returns ok:false (it does NOT
//          propagate), delivery still runs, the run is recorded, nothing throws.
//          This confirms the createAgent throw→error-terminal conversion matches
//          AgentRunner's (Task 4.1 error-path rule, case (a): no control change).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MicrocompactConfig } from '../../src/compact/microcompact.js';
import type { RecallTurn, SystemSegment } from '../../src/core/types.js';
import { addJob } from '../../src/cron/jobs.js';
import { getJob } from '../../src/cron/jobs.js';
import {
  type CronAgentConfigInput,
  buildCronAgentConfig,
  createProductionCronRunner,
} from '../../src/cron/wiring.js';
import type { MemoryRuntime } from '../../src/memory/provider.js';
import type { TranscriptStore } from '../../src/persistence/transcriptStore.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { LLMProvider } from '../../src/providers/types.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';
import type { Tool } from '../../src/tool/types.js';

// ── Part A — buildCronAgentConfig field-level parity (unit) ───────────────────

/** Distinct sentinel objects so every assertion can prove reference-identity
 *  pass-through (the re-seat must hand the SAME value through, not a copy). */
function makeInput(overrides: Partial<CronAgentConfigInput> = {}): {
  input: CronAgentConfigInput;
  provider: LLMProvider;
  systemPrompt: SystemSegment[];
  tools: Tool<unknown, unknown>[];
  memoryManager: MemoryRuntime;
  microcompactConfig: MicrocompactConfig;
} {
  const provider = { name: 'sentinel-provider' } as unknown as LLMProvider;
  const systemPrompt: SystemSegment[] = [{ text: 'cron system', cacheable: true }];
  const tools = [{ name: 'sentinel-tool' }] as unknown as Tool<unknown, unknown>[];
  const memoryManager = { id: 'sentinel-memory' } as unknown as MemoryRuntime;
  const microcompactConfig: MicrocompactConfig = {
    enabled: true,
    keepRecent: 3,
    triggerThresholdPct: 25,
    compactableTools: new Set(['Bash']),
  };
  const input: CronAgentConfigInput = {
    provider,
    model: 'mock-model',
    effort: 'medium',
    systemPrompt,
    maxTokens: 4096,
    cwd: '/cron/cwd',
    tools,
    memoryManager,
    microcompactConfig,
    ...overrides,
  };
  return { input, provider, systemPrompt, tools, memoryManager, microcompactConfig };
}

describe('buildCronAgentConfig — field-level parity with the prior AgentRunner opts', () => {
  test('maps every standing field 1:1 by value/reference', () => {
    const { input, provider, systemPrompt, tools, memoryManager } = makeInput();
    const config = buildCronAgentConfig(input);

    expect(config.provider).toBe(provider);
    expect(config.model).toBe('mock-model');
    expect(config.effort).toBe('medium');
    expect(config.systemPrompt).toBe(systemPrompt);
    expect(config.maxTokens).toBe(4096);
    expect(config.cwd).toBe('/cron/cwd');
    expect(config.tools).toBe(tools);
    expect(config.memoryManager).toBe(memoryManager);
    // Pinned to the cron-default turn ceiling the AgentRunner path also passed.
    expect(config.maxTurns).toBe(10);
  });

  test('PARITY-FIX #1: microcompactConfig is threaded onto the config', () => {
    const { input, microcompactConfig } = makeInput();
    const config = buildCronAgentConfig(input);
    // AgentRunner had no such field → cron ran on query()'s built-in default;
    // the re-seat carries the runtime's settings-derived value through verbatim.
    expect(config.microcompactConfig).toBe(microcompactConfig);
  });

  test('PARITY-FIX #2: transcripts is threaded when supplied, absent when omitted', () => {
    const transcripts = { recordMessage() {} } as unknown as TranscriptStore;
    const withStore = buildCronAgentConfig(makeInput({ transcripts }).input);
    expect(withStore.transcripts).toBe(transcripts);

    const withoutStore = buildCronAgentConfig(makeInput().input);
    // No store → key stays absent (no silent disk writes where there was none).
    expect('transcripts' in withoutStore).toBe(false);
  });

  test('recall is conditionally spread (present when supplied, absent when omitted)', () => {
    const recall = (() => {}) as unknown as RecallTurn;
    const withRecall = buildCronAgentConfig(makeInput({ recall }).input);
    expect(withRecall.recall).toBe(recall);

    const withoutRecall = buildCronAgentConfig(makeInput().input);
    expect('recall' in withoutRecall).toBe(false);
  });

  test('never passes a sessionStore (cron never wrote message rows before)', () => {
    const config = buildCronAgentConfig(makeInput({ transcripts: {} as TranscriptStore }).input);
    // The re-seat transcribes but must NOT start persisting message rows to the
    // session DB — that would be a new capability, not parity.
    expect('sessionStore' in config).toBe(false);
  });
});

// ── Part B — behavioral parity through the live runtime ───────────────────────

/** Recursively collect every `.jsonl` transcript file under a root. */
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

function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.throwOnNext = undefined;
}

describe('cron re-seat — behavioral parity through createProductionCronRunner', () => {
  let home: string;
  let runtime: Runtime | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-cron-reseat-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_HOME = home;
    resetMockProviderStatics();
  });

  afterEach(async () => {
    if (runtime) await runtime.dispose();
    runtime = undefined;
    resetMockProviderStatics();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('a cron turn yields the same final assistant + completed terminal as before', async () => {
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: home,
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
    const job = addJob(home, {
      prompt: 'say hello',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });

    const runner = createProductionCronRunner(runtime, home);
    const result = await runner.forceRunJob(job.id);

    // ok:true is the completed-terminal proxy; the body is the final assistant
    // text the loop produced — both unchanged from the AgentRunner path.
    expect(result.ok).toBe(true);
    expect(result.output).toBe('Hello world.');
    expect(result.deliveryOk).toBe(true);
  });

  test('PARITY-FIX: a transcript JSONL is now written for the cron session', async () => {
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: home,
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
    expect(runtime.transcripts).toBeDefined();
    const projectsDir = runtime.transcripts?.projectsDir;
    expect(projectsDir).not.toBeNull();

    // No transcript before the turn runs.
    expect(collectJsonl(projectsDir as string)).toHaveLength(0);

    const job = addJob(home, {
      prompt: 'say hello',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });
    const runner = createProductionCronRunner(runtime, home);
    await runner.forceRunJob(job.id);

    // The cron session's turn is flushed to a JSONL transcript (disposeSession
    // awaited the writer close before forceRunJob resolved). Pre-fix: nothing.
    const transcripts = collectJsonl(projectsDir as string);
    expect(transcripts.length).toBeGreaterThan(0);
  });

  test('error path: a turn whose provider throws preserves cron job-completion', async () => {
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: home,
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
    const job = addJob(home, {
      prompt: 'will fail',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });

    // The provider throws on the turn's first stream() call. createAgent converts
    // it to terminal.reason:'error' (exactly as AgentRunner did) — so runAgent
    // RETURNS ok:false rather than propagating.
    MockProvider.throwOnNext = new Error('cron-boom');

    const runner = createProductionCronRunner(runtime, home);
    // Must not throw — the error is absorbed into the result.
    const result = await runner.forceRunJob(job.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('cron-boom');
    // deliveryOk is DEFINED → the executor reached `send()` → runAgent returned
    // (did not throw). Had createAgent propagated, the executor's catch would
    // have skipped delivery and `deliveryOk` would be undefined. This is the
    // discriminating proof that the error-terminal semantics are preserved.
    expect(result.deliveryOk).not.toBeUndefined();

    // The run was recorded (job-completion semantics unchanged): nextRun is
    // rescheduled off lastRunAt, so a failed turn doesn't immediately retry.
    expect(getJob(home, job.id)?.lastRunAt).toBeDefined();
  });
});
