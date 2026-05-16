// Phase 16.1 M8 T2 — capture-mode wiring in `buildRuntime`.
//
// Pins two contracts:
//   1. `captureFixturePath` wraps the resolved provider so a session's
//      provider events + tool results are mirrored into a CaptureSink,
//      and `runtime.dispose()` flushes the sink to a valid fixture file.
//   2. Setting both `captureFixturePath` and `replayFixturePath` is a
//      configuration error — the two modes are mutually exclusive.
//
// The dispose-time write must precede MCP shutdown so the fixture lands
// before any teardown-induced failures could swallow it (M8-08 ordering).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — capture fixture write on dispose (M8 T2)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t2-capture-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('captureFixturePath wraps provider; runtime.dispose() writes valid fixture', async () => {
    const fixturePath = join(tmpHome, 'fixture.json');
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      captureFixturePath: fixturePath,
    });

    const app = buildAppWithRuntime(runtime);
    const createRes = await app.request('/sessions', { method: 'POST' });
    expect(createRes.status).toBe(201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(turnRes.status).toBe(202);

    // Drain SSE so the background turn finishes before we dispose.
    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    await eventsRes.text();

    await runtime.dispose();

    expect(existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      meta: { provider: string; model: string; sessionId: string; capturedAt: string };
      turns: Array<{ turn: number; providerEvents: unknown[]; toolResults: unknown[] }>;
    };
    expect(fixture.meta.provider).toBe('mock');
    expect(fixture.meta.model).toBe('mock-haiku');
    expect(Array.isArray(fixture.turns)).toBe(true);
    expect(fixture.turns.length).toBeGreaterThan(0);
    // Sanity: the captured turn carries the synthetic mock events.
    expect(fixture.turns[0]?.providerEvents.length).toBeGreaterThan(0);
  });

  test('captureFixturePath + replayFixturePath mutex throws', async () => {
    await expect(
      buildRuntime({
        cwd: tmpHome,
        harnessHome: tmpHome,
        provider: 'mock',
        preflight: false,
        captureFixturePath: join(tmpHome, 'a.json'),
        replayFixturePath: join(tmpHome, 'b.json'),
      }),
    ).rejects.toThrow(/capture.*replay.*mutually exclusive|cannot.*both/i);
  });
});
