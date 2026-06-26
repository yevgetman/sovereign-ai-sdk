// M11.5 — real-Anthropic smoke for the inline picker round-trip.
//
// Gated by SOV_M11_5_REAL_SMOKE=1 so default `bun test` skips it. When
// set, exercises the pickerOpen side-effect end-to-end through the
// generic /commands route:
//   1) POST /commands { name: 'model' } (no args)         → pickerOpen
//   2) POST /commands { name: 'model', args: '<chosen>' } → modelChanged
//
// The dispatcher doesn't actually hit the LLM for /model (registry
// runs locally), so cost is near $0. This smoke pins the wire-shape
// contract under a real Anthropic-backed runtime instead of the mock
// provider — catches drift between server schema (PickerOpenConfig)
// and provider-side runtime setup.
//
// Run with:
//   ANTHROPIC_API_KEY=... SOV_M11_5_REAL_SMOKE=1 \
//     bun test tests/parity/m11_5PickerSmoke.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

const SMOKE_ENABLED = process.env.SOV_M11_5_REAL_SMOKE === '1';
const SOAK_DIR = '/Users/julie/code/sovereign-ai-harness/docs/07-history/state/2026-05-19-m11-5-smoke';

function describeMaybe(name: string, fn: () => void): void {
  if (SMOKE_ENABLED) {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

describeMaybe('M11.5 — real-Anthropic picker round-trip smoke', () => {
  let runtime: Runtime;
  let app: ReturnType<typeof buildAppWithRuntime>;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m11-5-real-'));
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

  test('Agent A — /model (no args) emits pickerOpen with anthropic preset models', async () => {
    const sessRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await sessRes.json()) as { sessionId: string };

    const cmdRes = await app.request(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'model' }),
    });
    expect(cmdRes.status).toBe(200);
    const json = (await cmdRes.json()) as {
      output: string;
      sideEffects?: {
        pickerOpen?: {
          title: string;
          subtitle?: string;
          items: { label: string; value: string; hint?: string }[];
          initial?: number;
          onSelect: { command: string };
        };
      };
    };
    writeFileSync(join(SOAK_DIR, 'agent-a-pickeropen.json'), JSON.stringify(json, null, 2));

    expect(json.output).toBe('');
    expect(json.sideEffects?.pickerOpen).toBeDefined();
    const picker = json.sideEffects?.pickerOpen;
    if (!picker) throw new Error('pickerOpen missing from sideEffects');
    expect(picker.title).toBe('switch model');
    expect(picker.onSelect).toEqual({ command: 'model' });
    expect(picker.items.length).toBeGreaterThanOrEqual(3);
    const values = picker.items.map((i) => i.value);
    expect(values).toContain('claude-haiku-4-5-20251001');
    expect(values).toContain('claude-sonnet-4-6');
    expect(values).toContain('claude-opus-4-7');
  }, 30_000);

  test('Agent B — /model <selected> applies the change with modelChanged side-effect', async () => {
    const sessRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await sessRes.json()) as { sessionId: string };

    const cmdRes = await app.request(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'model', args: 'claude-sonnet-4-6' }),
    });
    expect(cmdRes.status).toBe(200);
    const json = (await cmdRes.json()) as {
      output: string;
      sideEffects?: { modelChanged?: string; pickerOpen?: unknown };
    };
    writeFileSync(join(SOAK_DIR, 'agent-b-modelchanged.json'), JSON.stringify(json, null, 2));

    expect(json.output).toContain('model set to claude-sonnet-4-6');
    expect(json.sideEffects?.modelChanged).toBe('claude-sonnet-4-6');
    expect(json.sideEffects?.pickerOpen).toBeUndefined();
  }, 30_000);
});
