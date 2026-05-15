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
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

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
});
