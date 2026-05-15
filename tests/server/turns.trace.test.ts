// Phase 16.1 M7 T3 — turns route wires the per-session trace writer.
//
// Verifies that POSTing a turn against the runtime fires trace events
// through the SessionContext's TraceWriter and that the file lands at
// <harnessHome>/traces/<sessionId>.jsonl. Drives the turn via the public
// route (POST /sessions/:id/turns) the same way other server tests do,
// rather than reaching into the private runTurnInBackground helper.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — server-side trace writer (M7 T3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t3-trace-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('one turn fires trace events; file lands at <harnessHome>/traces/<sessionId>.jsonl', async () => {
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
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain the SSE so the background turn completes deterministically
      // before we close the writer.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      // Force the trace writer to flush by disposing the session context.
      await runtime.disposeSession(sessionId);

      const tracePath = join(tmpHome, 'traces', `${sessionId}.jsonl`);
      expect(existsSync(tracePath)).toBe(true);
      const content = readFileSync(tracePath, 'utf8');
      // query() records turn_start + provider_request + provider_response on
      // every model call — the mock provider hits all three in one turn.
      expect(content).toContain('"type":"turn_start"');
      expect(content).toContain('"type":"provider_request"');
      expect(content).toContain('"type":"provider_response"');
    } finally {
      await runtime.dispose();
    }
  });
});
