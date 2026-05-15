// Phase 16.1 M7 T5 — learning observer wired into ToolContext.
//
// Verifies that the per-session SessionContext constructs a LearningObserver
// (when learning isn't disabled in settings) and that the turns route threads
// it onto the ToolContext so the orchestrator's
// `ctx.learningObserver?.observe(...)` call after every tool call writes a
// JSONL record into `<harnessHome>/learning/<projectId>/observations.jsonl`.
//
// Two contracts:
//   1. Default settings + a tool-using turn → observations.jsonl exists and
//      contains a record for the dispatched Bash tool.
//   2. learning.disabled === true in user settings → observer is left
//      undefined, observe() is a no-op, and no observations.jsonl is written.
//
// Driven through the public POST /sessions/:id/turns route (mirrors the M7 T3
// trace test pattern) rather than reaching into private helpers.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — learning observer (M7 T5)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t5-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // The getProjectId cache is keyed by cwd and persists across tests in the
    // same Bun process. tmpHome is fresh each test, so a stale cache entry
    // can't bleed in directly — but git-remote resolution for tmpHome can
    // (the temp dir is not in a git repo, so the fallback path runs). Reset
    // defensively so each test's getProjectId(tmpHome) lookup is uncached.
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: same — config override must be unset, not assigned undefined.
    delete process.env.HARNESS_CONFIG;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('turn with tool call writes observation to learning JSONL', async () => {
    MockProvider.toolUseMode = true;
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

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'run echo hi' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE so the background turn completes deterministically.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      // Dispose to flush the observer's write chain.
      await runtime.disposeSession(sessionId);

      const projectId = getProjectId(tmpHome).id;
      const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
      expect(existsSync(obsPath)).toBe(true);
      const content = readFileSync(obsPath, 'utf8');
      // Observer writes Observation records keyed via snake_case to match
      // the corpus shape (src/learning/types.ts).
      expect(content).toContain('"tool_name":"Bash"');
      expect(content).toContain('"status":"success"');
    } finally {
      await runtime.dispose();
    }
  });

  test('learning.disabled === true — no observer constructed, no observations written', async () => {
    // Point readConfig() at a config under tmpHome that disables learning.
    // Per src/config/store.ts, HARNESS_CONFIG (not HARNESS_CONFIG_PATH) is
    // the override env var the loader honors.
    const configPath = join(tmpHome, 'config.json');
    writeFileSync(configPath, JSON.stringify({ learning: { disabled: true } }));
    process.env.HARNESS_CONFIG = configPath;

    MockProvider.toolUseMode = true;
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
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'go' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();

      await runtime.disposeSession(sessionId);

      const projectId = getProjectId(tmpHome).id;
      const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
      expect(existsSync(obsPath)).toBe(false);

      // Also assert the SessionContext field is undefined — disposal would
      // skip drain even without that, but the visible contract per the plan
      // is "field is left undefined when learning is disabled".
      const ctx = runtime.getSessionContext(sessionId);
      expect(ctx.learningObserver).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
