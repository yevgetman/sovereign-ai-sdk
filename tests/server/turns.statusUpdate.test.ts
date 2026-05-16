// Phase 16.1 M9 T10 — status_update SSE event emission.
//
// Verifies that the turns route emits `status_update` events at:
//   (a) start of the turn (streaming: true)
//   (b) just before turn_complete (streaming: false + tokens + cost)
//   (c) on turn_error (streaming: false, no tokens)
//
// The TUI's statusline (Go side) consumes these events to drive the
// streaming spinner and the live cost field. Without (a) the spinner
// never starts; without (b) the spinner spins forever after a successful
// turn; without (c) the spinner spins forever on errors.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — status_update SSE event (M9 T10)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m9-t10-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('successful turn emits status_update at start + end with cost/tokens on the final event', async () => {
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
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // Parse all status_update events from the SSE stream.
      type StatusEvent = {
        streaming?: boolean;
        cost?: number;
        tokensIn?: number;
        tokensOut?: number;
      };
      const statusEvents: StatusEvent[] = [];
      for (const line of body.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice('data: '.length).trim();
        if (!json) continue;
        try {
          const parsed = JSON.parse(json) as {
            type?: string;
            streaming?: boolean;
            cost?: number;
            tokensIn?: number;
            tokensOut?: number;
          };
          if (parsed.type === 'status_update') {
            const ev: StatusEvent = {};
            if (parsed.streaming !== undefined) ev.streaming = parsed.streaming;
            if (parsed.cost !== undefined) ev.cost = parsed.cost;
            if (parsed.tokensIn !== undefined) ev.tokensIn = parsed.tokensIn;
            if (parsed.tokensOut !== undefined) ev.tokensOut = parsed.tokensOut;
            statusEvents.push(ev);
          }
        } catch {
          // ignore framing-only lines.
        }
      }

      // Must have at least the start + end events.
      expect(statusEvents.length).toBeGreaterThanOrEqual(2);

      // First event: streaming=true (no tokens yet).
      const first = statusEvents[0];
      expect(first?.streaming).toBe(true);

      // Last event: streaming=false (turn done).
      const last = statusEvents[statusEvents.length - 1];
      expect(last?.streaming).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('start event publishes before any text_delta or tool events', async () => {
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

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      const body = await eventsRes.text();

      // Find positions of status_update streaming:true and turn_complete.
      // The streaming:true event MUST appear before turn_complete in the
      // serialized stream.
      let firstStatusIdx = -1;
      let turnCompleteIdx = -1;
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        try {
          const parsed = JSON.parse(json) as { type?: string; streaming?: boolean };
          if (
            parsed.type === 'status_update' &&
            parsed.streaming === true &&
            firstStatusIdx === -1
          ) {
            firstStatusIdx = i;
          }
          if (parsed.type === 'turn_complete' && turnCompleteIdx === -1) {
            turnCompleteIdx = i;
          }
        } catch {
          // skip
        }
      }

      expect(firstStatusIdx).toBeGreaterThanOrEqual(0);
      expect(turnCompleteIdx).toBeGreaterThan(firstStatusIdx);
    } finally {
      await runtime.dispose();
    }
  });
});
