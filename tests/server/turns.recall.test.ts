// Learning-loop spike Phase 1 / Task 11 — deterministic proof that the
// turns route threads recall + memory into the provider request.
//
// The learning loop is wired such that when `learning.recall.enabled` is
// true, buildSessionContext builds a per-session recall thunk that query()
// runs after memory injection, splicing a `<learned-context>` snapshot
// (assembled from the instinct corpus) in front of the latest user message
// before the provider sees it. The route also threads `memoryManager`
// unconditionally (backlog #43 / D6 fix) so MEMORY.md injects on the server
// surface, not only the CLI paths.
//
// This test proves all three contracts deterministically (no LLM variance)
// by inspecting `MockProvider.lastMessages` — the exact message array the
// provider received on its most recent stream() call:
//   1. recall ON  → the captured request contains `<learned-context>` AND
//                    the seeded instinct's action text.
//   2. recall OFF → the captured request does NOT contain `<learned-context>`.
//   3. MEMORY.md present → the captured request contains the `<memory-context>`
//                    fence AND the MEMORY.md body (proves the route threads
//                    memoryManager into query()).
//
// Driven through the public POST /sessions/:id/turns route (mirrors the M7 T5
// learning-observer test pattern). MockProvider is scripted to return a
// single text response so the turn completes in one stream() call and
// `lastMessages` is exactly the turn-0 request with injections applied.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../../src/core/types.js';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';
import { serializeInstinct } from '../../src/learning/instinctSerde.js';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import type { Instinct } from '../../src/learning/types.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

/** The seeded instinct's trigger lexically overlaps the user prompt
 *  ("run the test suite") so the deterministic, token-overlap recall
 *  assembler surfaces it. The action is the load-bearing string the ON
 *  case asserts reached the provider. */
const INSTINCT_TRIGGER = 'run the test suite';
const INSTINCT_ACTION = 'use the make check command';
const USER_PROMPT = 'please run the test suite now';
const MEMORY_BODY = 'Always prefer ripgrep over grep in this repo.';

/** A global-scope instinct. Recall always reads the `_global` corpus in
 *  addition to the per-project one, so seeding here avoids reproducing the
 *  per-project project-id derivation. */
function buildGlobalInstinct(): Instinct {
  return {
    id: 'testcmd',
    trigger: INSTINCT_TRIGGER,
    action: INSTINCT_ACTION,
    confidence: 0.9,
    evidence_count: 3,
    domain: 'testing',
    scope: 'global',
    project_id: null,
    project_name: null,
    created_at: '2026-06-03T00:00:00.000Z',
    last_evidence_at: '2026-06-03T00:00:00.000Z',
    observation_ids: ['obs-1', 'obs-2', 'obs-3'],
  };
}

/** Seed the instinct on disk under the test's harnessHome at the global
 *  corpus key. Uses the same Persist adapter + serializer the runtime reads
 *  through, so the on-disk shape is guaranteed to round-trip. */
async function seedGlobalInstinct(harnessHome: string): Promise<void> {
  const persist = createFsPersist(harnessHome);
  await persist.write(
    'learning/_global/instincts/testcmd.md',
    serializeInstinct(buildGlobalInstinct(), ''),
  );
}

/** Flatten the captured provider request messages into a single searchable
 *  string. The injected snapshots live in text blocks of the latest user
 *  message, so concatenating every text block is sufficient for substring
 *  assertions. */
function capturedRequestText(messages: Message[] | undefined): string {
  if (messages === undefined) return '';
  const parts: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Reset every MockProvider static this suite touches so the known
 *  static-pollution flake can't bleed across tests in the shared Bun
 *  process. */
function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.lastMaxTokens = undefined;
  MockProvider.lastSignal = undefined;
  MockProvider.throwOnNext = undefined;
}

/** Boot a runtime against the temp home, drive one user turn whose text
 *  overlaps the instinct trigger, drain SSE so the background turn
 *  completes, and return the captured provider request as a searchable
 *  string. MockProvider is scripted to a single text response so the turn
 *  completes in exactly one stream() call. */
async function driveTurnAndCapture(tmpHome: string): Promise<string> {
  // Single-entry script → one stream() call → no tool loop. `lastMessages`
  // is therefore exactly the turn-0 request with memory + recall injected.
  MockProvider.toolUseScript = [{ kind: 'text', text: 'ok.' }];
  MockProvider.resetScriptCursor();

  const runtime = await buildRuntime({
    cwd: tmpHome,
    harnessHome: tmpHome,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
  });

  try {
    const app = buildAppWithRuntime(runtime);

    const createRes = await app.request('/sessions', { method: 'POST' });
    expect(createRes.status).toBe(201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    MockProvider.lastMessages = undefined;

    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: USER_PROMPT }),
    });
    expect(turnRes.status).toBe(202);

    // Drain SSE so the background turn completes deterministically before
    // we read the captured request.
    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    expect(eventsRes.status).toBe(200);
    await eventsRes.text();

    return capturedRequestText(MockProvider.lastMessages);
  } finally {
    await runtime.dispose();
  }
}

describe('turns route — recall + memory injection (Task 11)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-t11-recall-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // getProjectId caches per-cwd across tests in the same Bun process; the
    // temp dir is fresh each test but git-remote fallback resolution can
    // still cache. Reset defensively (mirrors turns.learning.test.ts).
    __test_resetProjectIdCache();
    resetMockProviderStatics();
  });

  afterEach(() => {
    resetMockProviderStatics();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: config override must be unset, not assigned undefined.
    delete process.env.HARNESS_CONFIG;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('recall ON — the recalled lesson reaches the provider request', async () => {
    // Enable recall via a config file the loader honors (HARNESS_CONFIG,
    // per src/config/store.ts). buildSessionContext reads this to build the
    // per-session recall thunk.
    const configPath = join(tmpHome, 'config.json');
    writeFileSync(configPath, JSON.stringify({ learning: { recall: { enabled: true } } }));
    process.env.HARNESS_CONFIG = configPath;

    await seedGlobalInstinct(tmpHome);

    const requestText = await driveTurnAndCapture(tmpHome);

    // The core proof: the recall fence AND the lesson's action text both
    // reached the provider. The action is rendered as part of the
    // `- when <trigger> → <action>` line inside <learned-context>.
    expect(requestText).toContain('<learned-context>');
    expect(requestText).toContain(INSTINCT_ACTION);
    // The trigger appears in the rendered line too — pin both halves so a
    // future format change that drops the action is caught.
    expect(requestText).toContain(INSTINCT_TRIGGER);
  });

  test('recall OFF — no learned-context injected', async () => {
    // No recall config → field defaults off → the route omits `recall` from
    // query() → recall stays inert. Seed the instinct anyway to prove it is
    // the OFF switch, not a missing corpus, that suppresses injection.
    const configPath = join(tmpHome, 'config.json');
    writeFileSync(configPath, JSON.stringify({ learning: { recall: { enabled: false } } }));
    process.env.HARNESS_CONFIG = configPath;

    await seedGlobalInstinct(tmpHome);

    const requestText = await driveTurnAndCapture(tmpHome);

    expect(requestText).not.toContain('<learned-context>');
    // The lesson text must not leak in via any other path either.
    expect(requestText).not.toContain(INSTINCT_ACTION);
  });

  test('MEMORY.md present — memory block injected on the server route (D6 fix)', async () => {
    // No recall config (recall stays off) — this case isolates the memory
    // path. The route now threads sessionCtx.memoryManager into query()
    // unconditionally (backlog #43); prior to the fix the server surface
    // omitted it and MEMORY.md never injected here.
    mkdirSync(join(tmpHome, 'memory'), { recursive: true });
    writeFileSync(join(tmpHome, 'memory', 'MEMORY.md'), MEMORY_BODY);

    const requestText = await driveTurnAndCapture(tmpHome);

    // formatMemorySnapshot wraps the file body in a <memory-context> fence
    // with a <MEMORY.md> inner tag. Assert both the fence and the body so
    // the proof pins that the actual file content reached the provider.
    expect(requestText).toContain('<memory-context>');
    expect(requestText).toContain('<MEMORY.md>');
    expect(requestText).toContain(MEMORY_BODY);
  });
});
