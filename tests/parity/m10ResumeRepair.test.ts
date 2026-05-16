// M10 audit fix — verifies `repairMissingToolResults` is wired into the
// server-side resume path. Audit slice 2 HIGH finding: terminalRepl.ts:2129
// calls repair before query(), but src/server/routes/turns.ts did not. The
// regression risk: a session whose last persisted assistant turn had an
// unfulfilled tool_use (e.g., process crashed mid-turn) would 400 on the
// next POST /sessions/:id/turns because the Anthropic API rejects messages
// arrays with an assistant tool_use unmatched by a following user
// tool_result.
//
// Fix: turns.ts:hydrate() now wraps loadHistoryAsMessages with
// repairMissingToolResults, mirroring terminalRepl.ts:2129. Repair is
// additive — sessions without orphan tool_use are unaffected.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('M10 — server resume path repairs orphan tool_use', () => {
  let runtime: Runtime;
  let app: ReturnType<typeof buildAppWithRuntime>;
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m10-resume-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
    runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    app = buildAppWithRuntime(runtime);
  });

  afterEach(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('session with orphan tool_use does NOT 400 on next /turns call', async () => {
    // Set up a session
    const sessionRes = await app.request('/sessions', { method: 'POST' });
    expect(sessionRes.status).toBe(201);
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    // Inject an orphan tool_use directly into the sessionDb to simulate a
    // crashed-mid-turn state. The next /turns call must not 400 — the
    // hydrate() path must repair this before sending to the model.
    runtime.sessionDb.saveMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'do something' }],
    });
    runtime.sessionDb.saveMessage(sessionId, {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling a tool' },
        {
          type: 'tool_use',
          id: 'orphan-tool-use-1',
          name: 'NonexistentTool',
          input: {},
        },
      ],
    });
    // No matching tool_result — this is the orphan state.

    // POST a new turn; this must succeed (mock provider returns a canned
    // response). Without the repair fix, the orphan tool_use blocks the
    // request from being sent to Anthropic (real provider) or breaks
    // message validation downstream.
    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'next turn' }),
    });
    expect(turnRes.status).toBe(202);

    // Drain events to ensure the turn completes
    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    expect(eventsRes.status).toBe(200);
    const body = await eventsRes.text();
    // Look for turn_complete — failure mode would be turn_complete never
    // arriving because the orphan tool_use crashed the validation.
    expect(body).toContain('turn_complete');
  });

  test('session without orphans is unchanged by repair (no spurious inserts)', async () => {
    // Clean session — single user turn, no orphan tool_use
    const sessionRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(turnRes.status).toBe(202);

    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    const body = await eventsRes.text();
    expect(body).toContain('turn_complete');
    // No `[repair]` stderr — but we can't assert on stderr in a test here.
    // The repair function is idempotent on clean histories; this test just
    // proves the wrapping doesn't break the happy path.
  });
});
