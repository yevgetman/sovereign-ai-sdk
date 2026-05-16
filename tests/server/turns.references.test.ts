// Phase 16.1 M8 T3 — @file:path / @url / @diff / @staged reference expansion
// in the server's POST /turns route.
//
// terminalRepl.ts:1288 calls expandContextReferences on the user's text
// before it ever lands in `messages`. The server route had no equivalent
// hop until M8 T3 — `runTurnInBackground` persisted the raw text and
// handed it to query() verbatim, so any @-prefixed reference reached the
// model unexpanded. This file pins the contract:
//   1. `@file:<path>` substitutes the file contents (fenced + screened)
//      into the persisted user message BEFORE saveMessage.
//   2. `@file:<missing>` substitutes the `[ERROR: file not found …]`
//      marker — the route does NOT throw, mirroring expandContextReferences's
//      inline error contract.
//
// The mock provider's default stream is text-only and terminates quickly,
// so a full POST /turns + drain /events round-trip is the cheapest end-to-end
// signal that the expansion ran inside the route's runTurnInBackground.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — @file:path reference expansion (M8 T3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t3-ref-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('@file:path in user text expands to file contents before saveMessage', async () => {
    writeFileSync(join(tmpHome, 'hello.txt'), 'hello from file');
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'read @file:hello.txt please' }),
      });
      // Drain SSE so the background turn completes before we read the DB.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();

      const messages = runtime.sessionDb.loadMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);
      const userMsg = messages[0];
      expect(userMsg).toBeDefined();
      const userText = JSON.stringify(userMsg?.content);
      expect(userText).toContain('hello from file');
      // The raw reference must have been replaced (not just augmented).
      expect(userText).not.toContain('@file:hello.txt');
    } finally {
      await runtime.dispose();
    }
  });

  test('@file:nonexistent.txt expands to error marker (no throw)', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'check @file:nonexistent.txt' }),
      });
      // Route accepted the turn — expansion failure is inlined, not thrown.
      expect(turnRes.status).toBe(202);
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();

      const messages = runtime.sessionDb.loadMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);
      const userText = JSON.stringify(messages[0]?.content);
      expect(userText).toContain('[ERROR: file not found');
    } finally {
      await runtime.dispose();
    }
  });
});
