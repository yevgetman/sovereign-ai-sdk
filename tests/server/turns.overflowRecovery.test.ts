// Phase 16.1 M6 T4 — context-overflow auto-recovery in the turns route.
//
// Contract under test (M6-02 retry-once):
//   1. When the first model call surfaces an `isContextOverflowError(...)`
//      (either thrown by the provider stream — which `query()` captures into
//      `Terminal.error` per `src/core/query.ts:156-164` — or otherwise present
//      on the returned Terminal), the route runs `runtime.compact()`,
//      publishes `compaction_complete`, and re-runs the SAME turn ONCE
//      against the new (post-compaction) session id.
//   2. If the retry succeeds (no second overflow), the wire emits exactly one
//      `compaction_complete` event followed by the normal terminal
//      `turn_complete` — no `turn_error`.
//   3. If the retry ALSO surfaces an overflow, the route does NOT compact +
//      retry a second time. The overflow surfaces as `turn_error` (the same
//      surface non-overflow errors take). One lineage row exists from the
//      single recovery attempt.
//
// Closes prereq row 15 (overflow auto-recovery) and the second half of
// prereq row 7 (full Compactor — proactive + overflow paths).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from '@yevgetman/sov-sdk/providers/types';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { wrapTransportWithOverflow } from '../helpers/transportWrappers.js';

/** First non-summarize call throws overflow; rest pass through. */
function wrapTransportWithOverflowOnce<T extends Transport>(inner: T) {
  return wrapTransportWithOverflow(inner, (n) => n === 1);
}

/** Every non-summarize call throws overflow. Pins the second-overflow → turn_error
 *  half of the M6-02 retry-once contract — the retry's compact runs (summarize
 *  passes through) but the second main call also throws, and the route must NOT
 *  recover a second time. */
function wrapTransportWithOverflowAlways<T extends Transport>(inner: T) {
  return wrapTransportWithOverflow(inner, () => true);
}

describe('turns route — overflow recovery (M6 T4)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-m6-t4-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  // First overflow → compact + retry → success. Pins the retry-once HAPPY
  // path. The default proactive threshold (0.75 of 200_000 = 150_000 tokens)
  // is well above the seeded history, so the proactive block does NOT fire —
  // the overflow recovery path is the SOLE route into compaction here.
  test('recovers from first overflow via compact + retry; no turn_error', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      const wrapped = wrapTransportWithOverflowOnce(runtime.resolvedProvider.transport);
      runtime.resolvedProvider.transport = wrapped.transport;

      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed enough prior history that the recovery's compactSession() call
      // has a non-empty `head` to summarize. Backlog #36: when the entire
      // history fits within the tail budget AND the min-tail floor
      // (DEFAULT_MIN_TAIL_MESSAGES=4), compactSession short-circuits to a
      // no-op and the recovery branch surfaces the original overflow
      // directly via turn_error rather than retrying. Without seeded
      // history the recovery branch would never fire compaction_complete.
      const filler = 'lorem ipsum dolor sit amet '.repeat(500);
      for (let i = 0; i < 3; i += 1) {
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'user',
          content: [{ type: 'text', text: `prior user turn ${i}: ${filler}` }],
        });
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'assistant',
          content: [{ type: 'text', text: `prior reply ${i}: ${filler}` }],
        });
      }

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // Recovery path executed: compaction_complete fired, turn_complete
      // fired, NO turn_error fired (the first overflow was absorbed).
      expect(body).toContain('event: compaction_complete');
      expect(body).toContain('event: turn_complete');
      expect(body).not.toContain('event: turn_error');

      // Exactly one compaction_complete on the wire — the recovery attempt
      // succeeded, so no second compaction was needed.
      const compactionMatches = body.match(/event: compaction_complete/g) ?? [];
      expect(compactionMatches.length).toBe(1);

      // Lineage row pinned: parent=original sessionId, child=new id minted by
      // compactSession. One row, not zero (proves recovery ran) and not two
      // (proves no double-recovery).
      const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
      expect(lineage.length).toBe(1);
      const childSessionId = lineage[0]?.childSessionId;
      expect(typeof childSessionId).toBe('string');
      expect(childSessionId).not.toBe(sessionId);

      // The retry's main-call hit the post-compaction child session. The
      // wire echoes the new id as activeSessionId so the TUI can pivot.
      expect(body).toContain(`"activeSessionId":"${childSessionId}"`);

      // Call-count sanity check: 2 main-stream calls (the overflow-throwing
      // first call + the successful retry) and >= 1 summarize call (the
      // recovery's compact step). Higher counts are fine — the mock's
      // streamHelloWorld doesn't loop; this is a floor, not an exact match.
      const counts = wrapped.callCounter();
      expect(counts.mainCalls).toBe(2);
      expect(counts.summarizeCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.dispose();
    }
  });

  // Second overflow → turn_error (NO further retry). Pins the "retry-once,
  // not retry-loop" half of M6-02. The first overflow triggers compact +
  // retry; the retry's overflow surfaces as turn_error rather than
  // triggering a second compact + retry cycle.
  test('surfaces second overflow as turn_error; no second compaction', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      const wrapped = wrapTransportWithOverflowAlways(runtime.resolvedProvider.transport);
      runtime.resolvedProvider.transport = wrapped.transport;

      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed enough prior history that the recovery's compactSession() call
      // has a non-empty `head` to summarize. Backlog #36: empty-head
      // compactions short-circuit to a no-op and the recovery branch
      // surfaces the original overflow directly via turn_error WITHOUT
      // ever firing compaction_complete — which would invalidate this
      // test's "compaction_complete fired exactly once" pin.
      const filler = 'lorem ipsum dolor sit amet '.repeat(500);
      for (let i = 0; i < 3; i += 1) {
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'user',
          content: [{ type: 'text', text: `prior user turn ${i}: ${filler}` }],
        });
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'assistant',
          content: [{ type: 'text', text: `prior reply ${i}: ${filler}` }],
        });
      }

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // The recovery attempt ran ONCE: compaction_complete fired (proves
      // first-overflow recovery triggered) but the second main call also
      // overflowed, so turn_error must surface and turn_complete must NOT.
      expect(body).toContain('event: compaction_complete');
      expect(body).toContain('event: turn_error');
      expect(body).not.toContain('event: turn_complete');

      // Exactly ONE compaction_complete — proves the route did NOT loop a
      // second compact + retry attempt on the second overflow. Multiple
      // compaction_complete events would be the marker of a runaway loop.
      const compactionMatches = body.match(/event: compaction_complete/g) ?? [];
      expect(compactionMatches.length).toBe(1);

      // The turn_error message text mentions the overflow surface. We don't
      // pin exact wording (provider-specific), only that the error wasn't
      // silently swallowed.
      expect(body).toMatch(/context length|context window|too many tokens|prompt is too long/i);

      // Exactly one lineage row from the single recovery attempt — proves
      // the route did not run a second compactSession after the second
      // overflow. Two rows here would also be a runaway-loop marker.
      const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
      expect(lineage.length).toBe(1);

      // Call-count sanity: exactly 2 main calls (one before recovery, one
      // after) and >= 1 summarize call. A third main call would mean the
      // route retried twice — a regression.
      const counts = wrapped.callCounter();
      expect(counts.mainCalls).toBe(2);
      expect(counts.summarizeCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.dispose();
    }
  });

  // Proactive + recovery interaction (Path A — independent budgets).
  // The proactive block (M6 T3) and the overflow recovery branch
  // (M6 T4) fire INDEPENDENTLY: there is no per-turn semaphore that
  // blocks one once the other has run. The `retriedAfterCompact` flag
  // in the route guards ONLY the recovery retry — a proactive
  // compaction earlier in the same turn does NOT prevent the recovery
  // hop from firing if `query()` then throws overflow. Pinning this
  // contract here so future "DRY the compaction logic" refactors don't
  // accidentally collapse both compactions onto a single per-turn flag
  // and silently regress the TUI
  // session-pivot semantics (it expects to handle TWO `compaction_complete`
  // events per turn in this scenario, each with a fresh `activeSessionId`).
  test('fires both proactive and recovery compactions in the same turn', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      // Same threshold mechanics as turns.proactiveCompact.test.ts: 0.02 of
      // 200_000 = 4_000 tokens — comfortably above the mock's ~2,200-token
      // system prompt (so the self-guard at compactor.ts:177-183 doesn't trip)
      // but small enough that the seeded large history below trips the
      // overall limit and `shouldCompactProactively` returns true.
      proactiveCompactThreshold: 0.02,
    });
    try {
      // Wrap so the proactive's summarize call passes through (mainCalls is
      // not incremented for summarize), then the FIRST post-proactive main
      // call throws overflow → triggers the recovery branch. The recovery's
      // own summarize call also passes through, and the SECOND main call
      // (the recovery retry) succeeds. Net: 2 summarize + 2 main calls.
      const wrapped = wrapTransportWithOverflowOnce(runtime.resolvedProvider.transport);
      runtime.resolvedProvider.transport = wrapped.transport;

      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed enough prior history that system + messages > 4_000 tokens AND
      // both compactSession() calls have a non-empty `head` (proactive
      // before query(), recovery before retry). Backlog #36: empty-head
      // compactions short-circuit to a no-op — proactive returns without
      // publishing compaction_complete; recovery surfaces the original
      // overflow as turn_error WITHOUT firing compaction_complete and
      // WITHOUT retrying. Both behaviors would invalidate this test's
      // "exactly 2 compaction_complete events on the wire" pin. The min
      // -tail floor (DEFAULT_MIN_TAIL_MESSAGES=4) requires 5+ messages to
      // leave any messages in head; we seed 6 + the route's user save = 7.
      const filler = 'lorem ipsum dolor sit amet '.repeat(500);
      for (let i = 0; i < 3; i += 1) {
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'user',
          content: [{ type: 'text', text: `prior user turn ${i}: ${filler}` }],
        });
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'assistant',
          content: [{ type: 'text', text: `prior reply ${i}: ${filler}` }],
        });
      }

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'next turn' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // Both compactions fired and the turn ultimately completed normally.
      // No turn_error — the recovery retry succeeded.
      expect(body).toContain('event: compaction_complete');
      expect(body).toContain('event: turn_complete');
      expect(body).not.toContain('event: turn_error');

      // EXACTLY two compaction_complete events on the wire — one from the
      // proactive block, one from the recovery branch. A regression that
      // collapsed both onto a single per-turn semaphore would land here as
      // either 1 (recovery suppressed) or, in a runaway loop, more than 2.
      const compactionMatches = body.match(/event: compaction_complete/g) ?? [];
      expect(compactionMatches.length).toBe(2);

      // Lineage chain: parent → proactiveChild → recoveryChild. Two distinct
      // rows because each compactSession() call records its own. The
      // proactive child becomes the parent for the recovery row (the local
      // `let sessionId` was reassigned to it before the recovery's compact
      // ran — see Path A note in turns.ts).
      const proactiveLineage = runtime.sessionDb.getCompactionsForParent(sessionId);
      expect(proactiveLineage.length).toBe(1);
      const proactiveChildId = proactiveLineage[0]?.childSessionId;
      expect(typeof proactiveChildId).toBe('string');
      expect(proactiveChildId).not.toBe(sessionId);

      const recoveryLineage = runtime.sessionDb.getCompactionsForParent(proactiveChildId ?? '');
      expect(recoveryLineage.length).toBe(1);
      const recoveryChildId = recoveryLineage[0]?.childSessionId;
      expect(typeof recoveryChildId).toBe('string');
      expect(recoveryChildId).not.toBe(proactiveChildId);
      expect(recoveryChildId).not.toBe(sessionId);

      // Both child ids surface on the wire as activeSessionId payloads. The
      // TUI consumer reads compaction_complete events in order and pivots to
      // the LATEST activeSessionId — so the recovery child id must be present
      // somewhere in the SSE body.
      expect(body).toContain(`"activeSessionId":"${proactiveChildId}"`);
      expect(body).toContain(`"activeSessionId":"${recoveryChildId}"`);

      // Call-count sanity: 2 summarize calls (one per compaction) and exactly
      // 2 main calls (the overflow-throwing first call after proactive + the
      // successful recovery retry). A third main call would mean the route
      // ran a second recovery retry — a regression of the M6-02 retry-once
      // contract under the proactive-precedes-recovery scenario.
      const counts = wrapped.callCounter();
      expect(counts.mainCalls).toBe(2);
      expect(counts.summarizeCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.dispose();
    }
  });
});
