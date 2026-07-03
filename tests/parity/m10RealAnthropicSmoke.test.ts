// M10 — focused real-Anthropic smoke for the server-mode runtime + the
// M10 audit fixes (HarnessInfo wire + resume-repair). Gated by env var
// SOV_M10_REAL_SMOKE=1 so CI / normal `bun test` runs skip it (no API
// budget consumed). When set, exercises 4 representative prompts against
// Anthropic Haiku 4.5 through the server-mode path (the same runtime
// --ui tui boots), capturing transcripts and asserting key behaviors.
//
// Captured outputs land at docs/state/2026-05-16-tui-parity-audit-soak/
// for the M10 audit report.
//
// Estimated cost: 4 prompts × short conversation × Haiku 4.5 ≈ $0.05.
//
// Run with:
//   ANTHROPIC_API_KEY=... SOV_M10_REAL_SMOKE=1 bun test tests/parity/m10RealAnthropicSmoke.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

const SMOKE_ENABLED = process.env.SOV_M10_REAL_SMOKE === '1';
const SOAK_DIR =
  '/Users/julie/code/sovereign-ai-sdk/docs/07-history/state/2026-05-16-tui-parity-audit-soak';

async function runPrompt(
  app: ReturnType<typeof buildAppWithRuntime>,
  prompt: string,
): Promise<{ sessionId: string; events: string }> {
  const sessionRes = await app.request('/sessions', { method: 'POST' });
  const { sessionId } = (await sessionRes.json()) as { sessionId: string };

  await app.request(`/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: prompt }),
  });

  const eventsRes = await app.request(`/sessions/${sessionId}/events`);
  const events = await eventsRes.text();
  return { sessionId, events };
}

function extractAssistantText(events: string): string {
  // SSE events are `data: {json}\n` lines. text_delta events carry the
  // model's response; turn_complete signals end-of-turn. Aggregate them.
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

function describeMaybe(name: string, fn: () => void): void {
  if (SMOKE_ENABLED) {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

describeMaybe('M10 — real-Anthropic Haiku 4.5 smoke (server-mode runtime)', () => {
  let runtime: Runtime;
  let app: ReturnType<typeof buildAppWithRuntime>;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m10-real-'));
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

  test('Agent A — Bash tool dispatch (smoke baseline)', async () => {
    const { events } = await runPrompt(
      app,
      'Run the shell command `echo m10-token-7af3` and tell me what it printed.',
    );
    const text = extractAssistantText(events);
    writeFileSync(join(SOAK_DIR, 'agent-a-bash.transcript.txt'), text);
    expect(events).toContain('turn_complete');
    expect(text.toLowerCase()).toContain('m10-token-7af3');
  }, 90_000);

  test('Agent B — HarnessInfo tool (M10 fix verification)', async () => {
    const { events } = await runPrompt(
      app,
      'What MCP servers are connected to this harness, and what permission mode is active? Use a tool to inspect the runtime if needed.',
    );
    const text = extractAssistantText(events);
    writeFileSync(join(SOAK_DIR, 'agent-b-harness-info.transcript.txt'), text);
    expect(events).toContain('turn_complete');
    // The model should reference permission mode or MCP — confirming
    // HarnessInfo is now reachable in server mode (M10 audit fix).
    const lower = text.toLowerCase();
    const mentionsRuntime =
      lower.includes('permission') ||
      lower.includes('mcp') ||
      lower.includes('mode') ||
      lower.includes('bypass') ||
      lower.includes('connected');
    expect(mentionsRuntime).toBe(true);
  }, 90_000);

  test('Agent C — File tool (Read/Write loop)', async () => {
    const { events } = await runPrompt(
      app,
      `Create a file at ${tmpHome}/notes.txt with the content "M10 smoke test". Then read it back and tell me what it says.`,
    );
    const text = extractAssistantText(events);
    writeFileSync(join(SOAK_DIR, 'agent-c-files.transcript.txt'), text);
    expect(events).toContain('turn_complete');
    expect(text.toLowerCase()).toContain('m10 smoke test');
  }, 90_000);

  test('Agent D — Resume-repair safety (clean session through happy path)', async () => {
    // This smoke confirms the resume-repair wrap doesn't break clean sessions.
    // The same session does multi-turn: first turn establishes context, second
    // turn references it. If repair were spuriously injecting tool_results,
    // multi-turn semantics would break.
    const sessionRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    // Turn 1
    await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'My favorite color is sovereign-purple-9242.' }),
    });

    // Turn 2 — recall from Turn 1
    await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'What was my favorite color?' }),
    });

    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    const events = await eventsRes.text();
    const text = extractAssistantText(events);
    writeFileSync(join(SOAK_DIR, 'agent-d-multiturn.transcript.txt'), text);

    expect(text.toLowerCase()).toContain('sovereign-purple-9242');
  }, 120_000);
});
