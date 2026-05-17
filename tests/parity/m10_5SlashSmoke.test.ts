// M10.5 — focused real-Anthropic smoke for the slash-command dispatcher.
//
// Gated by SOV_M10_5_REAL_SMOKE=1 so default `bun test` runs skip it (no
// API budget consumed). When set, exercises a representative slash
// command (/help) end-to-end through the server route AND a normal
// model turn in the same session — verifying the dispatcher coexists
// with normal turn dispatch without subsystem interference.
//
// Cost: ~$0.005 (2 short interactions × Haiku 4.5). Most of M10.5 is
// validated by mock-provider unit tests; this is the end-to-end
// sanity check that the wire shape works against the real provider.
//
// Run with:
//   ANTHROPIC_API_KEY=... SOV_M10_5_REAL_SMOKE=1 \
//     bun test tests/parity/m10_5SlashSmoke.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

const SMOKE_ENABLED = process.env.SOV_M10_5_REAL_SMOKE === '1';
const SOAK_DIR = '/Users/julie/code/sovereign-ai-harness/docs/state/2026-05-16-m10-5-slash-soak';

function describeMaybe(name: string, fn: () => void): void {
  if (SMOKE_ENABLED) {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

describeMaybe('M10.5 — real-Anthropic slash-dispatcher smoke', () => {
  let runtime: Runtime;
  let app: ReturnType<typeof buildAppWithRuntime>;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m10-5-real-'));
    __test_resetProjectIdCache();
    mkdirSync(SOAK_DIR, { recursive: true });
    runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      preflight: false,
    });
    app = buildAppWithRuntime(runtime);
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('Agent A — /help via dispatcher returns registry text', async () => {
    const sessRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await sessRes.json()) as { sessionId: string };

    const cmdRes = await app.request(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'help' }),
    });
    expect(cmdRes.status).toBe(200);
    const cmdJson = (await cmdRes.json()) as { output: string };
    writeFileSync(join(SOAK_DIR, 'agent-a-help.transcript.txt'), cmdJson.output);
    expect(cmdJson.output).toContain('/help');
    // No real-LLM call needed for /help — the registry text comes from
    // ctx.registry directly. This confirms the dispatcher is wired even
    // before exercising a model turn.
  }, 30_000);

  test('Agent B — slash + turn coexist in same session', async () => {
    // Verify a slash command (no model turn) and a model turn (no slash)
    // both work against the same session, with no state pollution.
    const sessRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await sessRes.json()) as { sessionId: string };

    // First — a model turn so the session has history
    await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Reply with exactly the string "m10-5-token-fb87" — no commentary.',
      }),
    });
    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    const events = await eventsRes.text();
    const text = extractAssistantText(events);
    writeFileSync(join(SOAK_DIR, 'agent-b-turn.transcript.txt'), text);
    expect(text).toContain('m10-5-token-fb87');

    // Then — /cost via dispatcher; reads sessionDb.getSessionCost
    // post-turn, so the cost should be non-zero
    const cmdRes = await app.request(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cost' }),
    });
    expect(cmdRes.status).toBe(200);
    const cmdJson = (await cmdRes.json()) as { output: string };
    writeFileSync(join(SOAK_DIR, 'agent-b-cost.transcript.txt'), cmdJson.output);
    // /cost output mentions tokens or cost
    const lower = cmdJson.output.toLowerCase();
    expect(lower.includes('token') || lower.includes('cost') || lower.includes('$')).toBe(true);
  }, 90_000);
});

function extractAssistantText(events: string): string {
  const lines = events.split('\n').filter((l) => l.startsWith('data: '));
  const chunks: string[] = [];
  for (const line of lines) {
    try {
      const json = line.slice('data: '.length);
      if (json.trim().length === 0) continue;
      const ev = JSON.parse(json) as { type?: string; text?: string };
      if (ev.type === 'text_delta' && typeof ev.text === 'string') {
        chunks.push(ev.text);
      }
    } catch {
      // ignore non-JSON framing
    }
  }
  return chunks.join('');
}
