// Integration tests for `sov drive`'s SSE session-pivot + follow-stream
// behaviour (FIX 1 / FIX 1b / FIX 2). These run the real in-process Hono
// server (MockProvider) and exercise drive's HTTP/SSE helpers directly:
//
//   FIX 1  — a /clear returns sideEffects.newSessionId; drive must hop the
//            active session AND re-point the SSE stream so subsequent turns
//            reach the NEW session's bus (previously drive forked: it kept
//            POSTing turns to the old session, so history was never cleared).
//   FIX 1b — the reconnect cursor is paired with the session it belongs to;
//            a pivot resets it to null so a stale high old-bus seq can't make
//            the new bus's fresh subscriber skip the new bus's low-seq events.
//   FIX 2  — drive holds ONE persistent `?follow` stream; idle drive does not
//            busy-loop reconnects (the Phase-B regression: a non-follow stream
//            ends immediately when idle, and the 20ms reconnect pause spun
//            ~45 reconnects/sec).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { DriveSseManager, EventRenderer, runSlashCommand } from '../../src/cli/driveCommand.js';
import { startServer } from '../../src/server/index.js';
import { buildRuntime } from '../../src/server/runtime.js';

type Runtime = Awaited<ReturnType<typeof buildRuntime>>;
type Server = Awaited<ReturnType<typeof startServer>>;

let home: string;
let cwd: string;
let runtime: Runtime;
let server: Server;
let baseURL: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'drive-pivot-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'drive-pivot-cwd-'));
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  runtime = await buildRuntime({
    cwd,
    harnessHome: home,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
    cronEnabled: false,
  });
  server = await startServer({ runtime });
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  await runtime.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  MockProvider.lastMessages = undefined;
  // biome-ignore lint/performance/noDelete: process.env requires delete to unset.
  delete process.env.SOV_TEST_MOCK_PROVIDER;
});

/** Silent renderer that resolves awaitTurnTerminal on a turn terminal. */
function silentRenderer(): EventRenderer {
  return new EventRenderer(false, baseURL, () => {});
}

async function createSession(): Promise<string> {
  const res = await fetch(`${baseURL}/sessions`, { method: 'POST' });
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

async function postTurnTo(sessionId: string, text: string): Promise<void> {
  const res = await fetch(`${baseURL}/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  expect(res.ok).toBe(true);
}

/** Drain a session's bus by GETting its (non-follow) events stream until the
 *  turn terminal so the turn's messages are persisted before we assert. */
async function awaitTurn(sessionId: string): Promise<void> {
  const res = await fetch(`${baseURL}/sessions/${sessionId}/events`);
  await res.text(); // non-follow stream closes on turn_complete / turn_error
}

describe('drive session pivot (FIX 1)', () => {
  test('after /clear, a subsequent turn POSTs to the NEW session id', async () => {
    const original = await createSession();

    // Wire the command through the SAME plumbing the drive loop uses: the
    // manager owns activeSessionId; the command's onPivot updates it. This
    // proves the loop's NEXT turn would route to the child, not just that we
    // can post to a known child id.
    const manager = new DriveSseManager({
      baseURL,
      initialSessionId: original,
      renderer: silentRenderer(),
    });

    // /clear mints a child and returns sideEffects.newSessionId.
    await runSlashCommand({
      baseURL,
      sessionId: manager.activeSessionId,
      line: '/clear',
      renderer: silentRenderer(),
      onPivot: (id) => manager.pivot(id),
    });
    // The manager hopped to the child — this is the id the loop now POSTs to.
    const child = manager.activeSessionId;
    expect(child).not.toBe(original);

    // Post a turn to the pivoted session — exactly what the drive loop does
    // (it reads sse.activeSessionId for every turn).
    await postTurnTo(manager.activeSessionId, 'hello after clear');
    await awaitTurn(child);

    // The NEW (child) session received the turn; the OLD session did not see
    // the post-clear user message. content is a ContentBlock[]; flatten any
    // text blocks to a searchable string.
    const userText = (sessionId: string): string =>
      runtime.sessionDb
        .loadMessages(sessionId)
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n');
    expect(userText(child)).toContain('hello after clear');
    expect(userText(original)).not.toContain('hello after clear');
  });
});

describe('drive cursor/session pairing (FIX 1b)', () => {
  test('pivot resets the cursor to null and re-points the cursor session', async () => {
    const manager = new DriveSseManager({
      baseURL,
      initialSessionId: 'session-A',
      renderer: silentRenderer(),
    });
    // Simulate the cursor having advanced on session-A's bus.
    manager.start();
    // Give the loop a tick to open its connection (no events on a fresh bus —
    // it just parks on ?follow), then pivot.
    await new Promise((r) => setTimeout(r, 30));

    manager.pivot('session-B');
    // After a pivot the cursor MUST be null (the new bus has its own seq space)
    // and the cursor's owning session must be the new one.
    expect(manager.currentCursor).toBeNull();
    expect(manager.currentCursorSession).toBe('session-B');
    expect(manager.activeSessionId).toBe('session-B');

    await manager.stop();
  });

  test('a no-op pivot to the same id leaves the cursor untouched', async () => {
    const manager = new DriveSseManager({
      baseURL,
      initialSessionId: 'session-A',
      renderer: silentRenderer(),
    });
    manager.pivot('session-A'); // same id — must be a no-op
    expect(manager.activeSessionId).toBe('session-A');
    expect(manager.currentCursorSession).toBe('session-A');
    await manager.stop();
  });

  // Regression for finding #46: the OLD guard `activeSessionId !== cursorSession`
  // could NEVER fire because pivot() updates both fields in lockstep. So residual
  // events draining from the pre-pivot (parent) connection in the same buffered
  // chunk would bump the cursor with stale high old-bus seqs, and the child
  // reconnect would skip the child bus's low-seq events. The cursor advance must
  // be gated by the EVENT's originating CONNECTION session instead.
  test('residual old-bus events after a mid-turn compaction pivot do NOT poison the cursor', () => {
    const PARENT = 'parent-session';
    const CHILD = 'child-session';
    const manager = new DriveSseManager({
      baseURL,
      initialSessionId: PARENT,
      renderer: silentRenderer(),
    });

    // 1. A normal parent-bus event advances the cursor (current connection).
    manager.ingestEvent(
      { type: 'text_delta', seq: 41, sessionId: PARENT, block: 0, text: 'before' },
      PARENT,
    );
    expect(manager.currentCursor).toBe(41);

    // 2. compaction_complete arrives on the parent connection: it advances the
    //    cursor to its own seq, then pivots to the child (resetting the cursor).
    manager.ingestEvent(
      {
        type: 'compaction_complete',
        seq: 42,
        sessionId: PARENT,
        activeSessionId: CHILD,
        summary: 's',
        estimatedBeforeTokens: 100,
        estimatedAfterTokens: 10,
      },
      PARENT,
    );
    expect(manager.activeSessionId).toBe(CHILD);
    expect(manager.currentCursor).toBeNull(); // pivot reset it

    // 3. THE BUG: a residual parent-bus event still buffered on the SAME
    //    (pre-pivot) parent connection arrives AFTER the pivot. It carries a high
    //    old-bus seq and MUST NOT bump the cursor — the child reconnect needs to
    //    be a fresh subscriber (cursor null) so it sees the child bus's seq-1+
    //    events. Pre-fix this set the cursor to 99 (the parent's seq) because
    //    activeSessionId === cursorSession === CHILD made the old guard false.
    manager.ingestEvent(
      { type: 'text_delta', seq: 99, sessionId: PARENT, block: 0, text: 'residual' },
      PARENT,
    );
    expect(manager.currentCursor).toBeNull();

    // 4. A genuine event on the NEW child connection advances the cursor again.
    manager.ingestEvent(
      { type: 'text_delta', seq: 1, sessionId: CHILD, block: 0, text: 'child' },
      CHILD,
    );
    expect(manager.currentCursor).toBe(1);
  });
});

describe('drive follow stream — no idle reconnect busy-loop (FIX 2)', () => {
  test('idle drive holds a single follow connection over an idle window', async () => {
    const sessionId = await createSession();
    const manager = new DriveSseManager({
      baseURL,
      initialSessionId: sessionId,
      renderer: silentRenderer(),
    });
    manager.start();

    // Idle for ~400ms. With the pre-fix per-turn reconnect loop (20ms pause,
    // non-follow stream ending immediately when idle), this window would rack
    // up ~20 reconnects. With ?follow the stream parks server-side, so the
    // connection count must stay tiny (1, allowing a small slop for an initial
    // open race).
    await new Promise((r) => setTimeout(r, 400));
    expect(manager.connectionCount).toBeLessThanOrEqual(2);

    await manager.stop();
  });

  test('a turn still streams over the persistent follow connection', async () => {
    const sessionId = await createSession();
    const writes: string[] = [];
    const renderer = new EventRenderer(false, baseURL, (s) => {
      writes.push(s);
    });
    const manager = new DriveSseManager({ baseURL, initialSessionId: sessionId, renderer });
    manager.start();
    // Let the follow stream attach.
    await new Promise((r) => setTimeout(r, 30));

    const turnDone = renderer.awaitTurnTerminal();
    await postTurnTo(sessionId, 'say hello');
    await turnDone;

    const out = writes.join('');
    // MockProvider streams "Hello world." then a turn_complete.
    expect(out).toContain('Hello world.');
    expect(out).toContain('[turn_complete');
    // Still one connection — the turn streamed over the existing follow stream,
    // no reconnect needed.
    expect(manager.connectionCount).toBeLessThanOrEqual(2);

    await manager.stop();
  });
});
