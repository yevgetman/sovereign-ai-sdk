// Phase C T1 — embedded web UI shell served from the gateway.
//
// GET / and GET /ui serve the embedded HTML shell. Both are OPEN (no auth)
// — they carry no secret, they're just the browser client's shell — and are
// mounted BEFORE the bearer-auth middleware so they stay reachable without
// credentials, exactly like /health. The session routes stay bearer-gated.

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { WEB_UI_HTML } from '../../src/server/webui.js';

async function withMockRuntime(
  label: string,
  fn: (runtime: Awaited<ReturnType<typeof buildRuntime>>) => Promise<void>,
): Promise<void> {
  const home = join(tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
  try {
    runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    await fn(runtime);
  } finally {
    if (runtime !== null) await runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}

describe('web UI shell — buildAppWithRuntime serves an open HTML shell', () => {
  test('GET / with no auth → 200 text/html containing the app marker', async () => {
    await withMockRuntime('ct1-root', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('id="app"');
    });
  });

  test('GET /ui with no auth → 200 text/html containing the app marker', async () => {
    await withMockRuntime('ct1-ui', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/ui');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('id="app"');
    });
  });

  test('POST /sessions with no auth → still 401 (auth unaffected by the open UI route)', async () => {
    await withMockRuntime('ct1-gated', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/sessions', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  test('GET /health with no auth → still 200 (open probe unaffected)', async () => {
    await withMockRuntime('ct1-health', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/health');
      expect(res.status).toBe(200);
    });
  });
});

// FIX (G5) — the embedded web UI is inline JS served as a static asset; there's
// no JS harness to execute its handlers here (a true behavioral check needs a
// browser/Playwright run, noted in the report). These structural assertions
// guard the load-bearing fix against silent regression.
//
// The ORIGINAL FIX 5 re-pointed the follow stream at the child bus the instant
// compaction_complete arrived. That was a HIGH bug: proactive/overflow
// compaction fires MID-TURN, and the rest of the in-flight turn's events still
// flow on the PARENT bus. Aborting+reopening immediately dropped those events
// and left turnActive stuck true, wedging the UI. The corrected handler mirrors
// the Go TUI (app.go startSSE: "mid-turn pivots keep streaming on the original
// bus and reconnect at turn end"): on a mid-turn compaction it pivots
// S.sessionId (so the next POST targets the child) but DEFERS the stream
// reconnect, recording a pending child id and reopening only once the turn
// terminal (turnComplete/turnError) flips turnActive false.
function sliceFn(name: string, fallbackLen = 1000): string {
  const decl = `function ${name}(`;
  const start = WEB_UI_HTML.indexOf(decl);
  expect(start).toBeGreaterThanOrEqual(0);
  const after = WEB_UI_HTML.indexOf('function ', start + decl.length);
  return WEB_UI_HTML.slice(start, after === -1 ? start + fallbackLen : after);
}

describe('web UI compaction pivot defers the stream reconnect to turn end (FIX G5)', () => {
  const compactionFn = sliceFn('compactionNotice');
  const turnCompleteFn = sliceFn('turnComplete', 1600);
  const turnErrorFn = sliceFn('turnError');
  const pivotFn = sliceFn('pivotStreamToActiveSession');

  test('updates S.sessionId on a child pivot', () => {
    expect(compactionFn).toContain('S.sessionId = ev.activeSessionId');
  });

  test('mid-turn (turnActive) it records a pending child id instead of reconnecting now', () => {
    expect(compactionFn).toContain('if (S.turnActive)');
    expect(compactionFn).toContain('S.pendingChildId = ev.activeSessionId');
    // The mid-turn branch MUST NOT abort/reopen the stream — that is the bug.
    // stopStream/openStream live only in the between-turns pivot helper.
    const turnActiveIdx = compactionFn.indexOf('if (S.turnActive)');
    const elseIdx = compactionFn.indexOf('} else {', turnActiveIdx);
    expect(elseIdx).toBeGreaterThan(turnActiveIdx);
    const midTurnBranch = compactionFn.slice(turnActiveIdx, elseIdx);
    expect(midTurnBranch).not.toContain('stopStream()');
    expect(midTurnBranch).not.toContain('openStream()');
  });

  test('between-turns (no active turn) it pivots the stream immediately', () => {
    expect(compactionFn).toContain('pivotStreamToActiveSession()');
  });

  test('the pivot helper reconnects the stream to the child bus with a fresh cursor', () => {
    expect(pivotFn).toContain('S.pendingChildId = null');
    expect(pivotFn).toContain('S.lastEventId = null');
    expect(pivotFn).toContain('stopStream()');
    expect(pivotFn).toContain('openStream()');
    // The cursor reset must precede the reopen.
    expect(pivotFn.indexOf('S.lastEventId = null')).toBeLessThan(pivotFn.indexOf('openStream()'));
  });

  test('both turn terminals apply the deferred pivot after turnActive clears', () => {
    // turnComplete sets turnActive false then applies the pending pivot.
    expect(turnCompleteFn).toContain('S.turnActive = false');
    expect(turnCompleteFn).toContain('applyPendingCompactionPivot()');
    expect(turnCompleteFn.indexOf('S.turnActive = false')).toBeLessThan(
      turnCompleteFn.indexOf('applyPendingCompactionPivot()'),
    );
    // turnError does the same so a failed turn still pivots to the child.
    expect(turnErrorFn).toContain('S.turnActive = false');
    expect(turnErrorFn).toContain('applyPendingCompactionPivot()');
    expect(turnErrorFn.indexOf('S.turnActive = false')).toBeLessThan(
      turnErrorFn.indexOf('applyPendingCompactionPivot()'),
    );
  });

  test('reconnect resets the cursor on a session mismatch (mirrors app.go sseCursorSession)', () => {
    const runStreamFn = sliceFn('runStream', 3000);
    expect(runStreamFn).toContain('S.sessionId !== S.lastEventIdSession');
    expect(runStreamFn).toContain('S.lastEventId = null');
  });
});
