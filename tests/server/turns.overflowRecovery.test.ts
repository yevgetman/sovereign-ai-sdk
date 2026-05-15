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
// Mirrors the proven shape in `src/ui/terminalRepl.ts:1659-1675`, adapted to
// the server route. Closes prereq row 15 (overflow auto-recovery) and the
// second half of prereq row 7 (full Compactor — proactive + overflow paths).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressionSystemPrompt } from '../../src/compact/compactor.js';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import type { ProviderRequest, Transport } from '../../src/providers/types.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

/**
 * Wrap a transport so the FIRST non-summarize stream call throws an overflow
 * error (caught inside `query()` and surfaced as `Terminal.error`), and every
 * subsequent non-summarize call passes through. Summarize-shaped calls
 * (detected by the `compressionSystemPrompt()` text in `req.system`) always
 * pass through so `runtime.compact()` can run normally during recovery.
 *
 * The overflow-detection test in `src/providers/errors.ts:81` is string-based
 * (no `ContextOverflowError` class exists in the codebase), so we throw a
 * plain Error whose message matches one of the substrings checked there
 * (`'context length'`, `'prompt is too long'`, etc.). This is the same shape
 * a real provider's HTTP-413 / OpenAI-style `context_length_exceeded` body
 * would surface as after string-coercion.
 */
function wrapTransportWithOverflowOnce<T extends Transport>(
  inner: T,
): {
  transport: T;
  callCounter: () => { mainCalls: number; summarizeCalls: number };
} {
  const compressionPrompt = compressionSystemPrompt();
  let mainCalls = 0;
  let summarizeCalls = 0;
  const wrapped: Transport = {
    name: inner.name,
    apiMode: inner.apiMode,
    toProviderMessages: inner.toProviderMessages.bind(inner),
    toProviderTools: inner.toProviderTools.bind(inner),
    buildKwargs: inner.buildKwargs.bind(inner),
    normalizeResponse: inner.normalizeResponse.bind(inner),
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const isSummarizeCall = req.system.some((seg) => seg.text === compressionPrompt);
      if (isSummarizeCall) {
        summarizeCalls += 1;
        return yield* inner.stream(req);
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        // First model turn — surface an overflow. Thrown from inside the
        // async generator, caught at `src/core/query.ts:156-164`, surfaced
        // back to the route via `Terminal { reason: 'error', error }`.
        throw new Error('context length exceeded by 12000 tokens');
      }
      return yield* inner.stream(req);
    },
  };
  return {
    transport: wrapped as T,
    callCounter: () => ({ mainCalls, summarizeCalls }),
  };
}

/**
 * Wrap a transport so EVERY non-summarize call throws an overflow. Used to
 * pin the "second overflow → turn_error, no further retry" half of the M6-02
 * retry-once contract. Summarize calls still pass through so the recovery
 * attempt's `runtime.compact()` can run; the second `query()` then fails
 * with overflow again, which the route must NOT recover from a second time.
 */
function wrapTransportWithOverflowAlways<T extends Transport>(
  inner: T,
): {
  transport: T;
  callCounter: () => { mainCalls: number; summarizeCalls: number };
} {
  const compressionPrompt = compressionSystemPrompt();
  let mainCalls = 0;
  let summarizeCalls = 0;
  const wrapped: Transport = {
    name: inner.name,
    apiMode: inner.apiMode,
    toProviderMessages: inner.toProviderMessages.bind(inner),
    toProviderTools: inner.toProviderTools.bind(inner),
    buildKwargs: inner.buildKwargs.bind(inner),
    normalizeResponse: inner.normalizeResponse.bind(inner),
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const isSummarizeCall = req.system.some((seg) => seg.text === compressionPrompt);
      if (isSummarizeCall) {
        summarizeCalls += 1;
        return yield* inner.stream(req);
      }
      mainCalls += 1;
      throw new Error('context length exceeded by 12000 tokens');
    },
  };
  return {
    transport: wrapped as T,
    callCounter: () => ({ mainCalls, summarizeCalls }),
  };
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
});
