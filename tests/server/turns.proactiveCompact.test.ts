// Phase 16.1 M6 T3 — proactive compaction wiring through the turns route.
//
// Contract under test:
//   1. Before query() runs, the route hydrates message history from the
//      session and probes shouldCompactProactively against the runtime's
//      proactiveCompactThreshold.
//   2. When the probe returns true, runtime.compact() runs synchronously
//      BEFORE the first text response, and the result.newSessionId becomes
//      the active session id for the rest of the turn.
//   3. A `compaction_complete` SSE event surfaces (carrying parent +
//      activeSessionId + summary + before/after token estimates) before any
//      text_delta from the post-compaction model call.
//   4. compactSession persists a parent→child lineage row inside its own
//      implementation (see compactor.ts:145); the route does not need to
//      duplicate that. The test pins lineage as a sanity check that the
//      hop actually occurred.
//   5. Mid-turn persistence (assistant messages) lands on the new child
//      session, not on the parent — proves the local sessionId variable
//      reassignment took effect.
//
// Threshold mechanics: shouldCompactProactively self-guards against the
// frozen system prompt alone exceeding the threshold (compactor.ts:177-183
// — without that guard the route would compact in a runaway loop because
// the child still has the same system prompt). The mock provider's system
// prompt is ~2,200 tokens, so the test picks a threshold large enough to
// fit the system prompt (0.02 of 200_000 = 4,000) and seeds a history
// large enough to put system+messages over the limit. Passing 0 here
// trips the system-prompt guard and SUPPRESSES compaction — the wrong
// signal.

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
 * Wraps an existing transport so the summarize-shaped call (detected by the
 * exact `compressionSystemPrompt()` text in `req.system`) throws while every
 * other call passes through to the underlying transport. Lets the test
 * exercise the compaction failure path without disturbing the post-compact
 * model turn or any other test in the suite. Compaction failure short-circuits
 * the rest of the turn anyway, so the throw-only summarize is safe — but we
 * preserve the pass-through to keep the wrapper drop-in compatible with any
 * future test that drives a turn after the compact failure.
 */
function wrapTransportWithFailingSummarize<T extends Transport>(inner: T): T {
  const compressionPrompt = compressionSystemPrompt();
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
        throw new Error('mock summarizer failure');
      }
      return yield* inner.stream(req);
    },
  };
  return wrapped as T;
}

describe('turns route — proactive compaction', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-m6-t3-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('emits compaction_complete before first text_delta and hops sessionId for mid-turn persistence', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      // 0.02 of 200_000 = 4_000 tokens — enough headroom for the mock
      // runtime's ~2,200-token system prompt to clear the self-guard,
      // but small enough that the seeded large history below trips the
      // overall limit.
      proactiveCompactThreshold: 0.02,
    });
    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed enough prior history that system + messages > 4,000 tokens.
      // ~12 KB of text (~3,000 tokens) per message, two messages → ~6,000
      // total message tokens, plus the ~2,200 system → comfortably past
      // the limit. Bypasses the route's own user-text persistence.
      const filler = 'lorem ipsum dolor sit amet '.repeat(500);
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: `prior turn: ${filler}` }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: `prior reply: ${filler}` }],
      });

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'next turn' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // compaction_complete must surface on the wire.
      expect(body).toContain('event: compaction_complete');

      // Ordering: compaction_complete must precede the first text_delta of
      // the post-compaction model response. If the route ran query() first
      // and only later compacted, this assertion would fail.
      const compactionIdx = body.indexOf('event: compaction_complete');
      const firstTextIdx = body.indexOf('event: text_delta');
      expect(compactionIdx).toBeGreaterThan(-1);
      expect(firstTextIdx).toBeGreaterThan(-1);
      expect(compactionIdx).toBeLessThan(firstTextIdx);

      // Lineage row exists: parent is the original sessionId, child is the
      // newSessionId minted inside compactSession. Surfaced via the
      // existing getCompactionsForParent API.
      const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
      expect(lineage.length).toBe(1);
      const childSessionId = lineage[0]?.childSessionId;
      expect(typeof childSessionId).toBe('string');
      expect(childSessionId).not.toBe(sessionId);

      // The wire event echoes the new id as activeSessionId so the TUI can
      // pivot subsequent POSTs onto the child session.
      expect(body).toContain(`"activeSessionId":"${childSessionId}"`);

      // Mid-turn persistence (the assistant "Hello world." message) lands
      // on the CHILD session, not the parent. compactSession itself
      // persists the summary + tail onto the child during the compact
      // step; after that, runTurnInBackground's post-compact query() must
      // saveMessage against the new id.
      const childMessages = runtime.sessionDb.loadMessages(childSessionId ?? '');
      const hasAssistantText = childMessages.some(
        (m) =>
          m.role === 'assistant' &&
          m.content.some((b) => b.type === 'text' && 'text' in b && b.text === 'Hello world.'),
      );
      expect(hasAssistantText).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  // Pins the route invariant ("runTurnInBackground catches its own errors and
  // publishes them as turn_error events onto the bus" — see turns.ts:60-66)
  // for the proactive-compaction code path. A pre-fix bug saw the proactive
  // block run OUTSIDE the existing try/catch, so a summarizer throw escaped
  // as an unhandled promise rejection and the SSE stream parked until client
  // disconnect. Wrapping the proactive block inside the try {} routes the
  // failure through the same turn_error publish path that handles query()
  // failures.
  test('emits turn_error (not unhandled rejection) when summarize throws mid-proactive-compaction', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      // Same threshold mechanics as the happy-path test above — the seeded
      // history must be large enough to trip shouldCompactProactively.
      proactiveCompactThreshold: 0.02,
    });
    try {
      // Drop in a wrapper that throws on the summarize call only. Pass-
      // through everything else so any unrelated provider invocation
      // (preflight has already happened during buildRuntime) behaves
      // normally.
      runtime.resolvedProvider.transport = wrapTransportWithFailingSummarize(
        runtime.resolvedProvider.transport,
      );

      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Same seeding as the happy-path test — pushes system+messages over
      // the threshold so shouldCompactProactively returns true and the
      // route invokes runtime.compact().
      const filler = 'lorem ipsum dolor sit amet '.repeat(500);
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: `prior turn: ${filler}` }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: `prior reply: ${filler}` }],
      });

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'next turn' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // Safety net fired: turn_error surfaces with the summarizer's message
      // text. Without the try/catch around the proactive block, the
      // rejection would escape runTurnInBackground and never reach the bus
      // — this assertion is the pin.
      expect(body).toContain('event: turn_error');
      expect(body).toContain('mock summarizer failure');

      // compaction_complete MUST NOT fire — compact() threw before
      // returning, so the wire event the happy-path test asserts must be
      // absent here. (If it were present, compaction either succeeded or
      // the route published the event before awaiting compact() — both
      // would be regressions.)
      expect(body).not.toContain('event: compaction_complete');

      // The turn_error attribution carries the PARENT sessionId because the
      // hop never completed — runTurnInBackground's `let sessionId` was
      // still pointing at the parent at the moment of throw. (If the route
      // had reassigned sessionId before the failing call, the catch would
      // attribute against the wrong session.)
      expect(body).toContain(`"sessionId":"${sessionId}"`);

      // No lineage row — compactSession throws before recordCompactionLineage.
      const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
      expect(lineage.length).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });
});
