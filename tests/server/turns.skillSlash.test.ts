// Phase 16.1 M8 T5 — skill-as-slash server-side expansion.
//
// POST /sessions/:id/turns with `{ text: '/skillname args', kind: 'skill' }`
// parses the slash command, looks the name up in runtime.skills.byName, and
// expands the skill body via `expandSkillPrompt(skill, { args })` BEFORE the
// rest of the turn (T3 @file expansion + saveMessage + query) runs. The
// expanded body is what lands in the messages table and what the model sees,
// not the raw `/greet Alice` slash.
//
// Pins two contracts:
//   1. Success path — kind:'skill' with a known name expands `{{args}}` and
//      replaces body.text before the saveMessage call. The persisted user
//      message contains the EXPANDED text, never the raw slash.
//   2. Unknown skill — the route returns 400 with an `unknown skill: <name>`
//      error envelope rather than silently treating the slash as plain text.
//      Symmetric with the malformed-id / missing-text 400s sibling routes
//      already surface.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — skill-as-slash expansion (M8 T5)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t5-skill-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Seed a project-local skill at <cwd>/.harness/skills/greet.md — the
    // project source root the loader walks first (src/skills/loader.ts:73).
    mkdirSync(join(tmpHome, '.harness', 'skills'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.harness', 'skills', 'greet.md'),
      '---\nname: greet\nwhenToUse: when user asks to greet someone\ndescription: Greets the user\n---\nHello {{args}}, nice to meet you.\n',
    );
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('POST /turns with kind:skill expands the skill prompt before saving the user message', async () => {
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
        body: JSON.stringify({ text: '/greet Alice', kind: 'skill' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE so the background turn finishes (and the user message has
      // been persisted via saveMessage) before we read the row.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();

      const messages = runtime.sessionDb.loadMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);
      const userText = JSON.stringify(messages[0]?.content);
      expect(userText).toContain('Hello Alice, nice to meet you.');
      // The raw `/greet Alice` slash MUST NOT appear in the persisted prompt —
      // expansion replaces the entire text, so a leak indicates the route
      // forgot to overwrite body.text before runTurnInBackground.
      expect(userText).not.toContain('/greet');
    } finally {
      await runtime.dispose();
    }
  });

  test('POST /turns with kind:skill + unknown skill returns 400', async () => {
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
        body: JSON.stringify({ text: '/unknownskill arg', kind: 'skill' }),
      });
      expect(turnRes.status).toBe(400);
      const body = (await turnRes.json()) as { error: string };
      expect(body.error).toContain('unknown skill');
      expect(body.error).toContain('unknownskill');
    } finally {
      await runtime.dispose();
    }
  });
});
