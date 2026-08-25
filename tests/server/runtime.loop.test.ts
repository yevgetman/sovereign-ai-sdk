// T4 — gateway plumbing for the progress-aware loop guard. `buildRuntime`
// lifts the `loop` config block onto `Runtime.loop`, and the turns route hands
// it to `createAgent` per turn. This file pins the runtime half: a configured
// block is exposed verbatim; an absent block leaves the field ABSENT (not
// `undefined`-valued), which is what keeps an unconfigured deployment
// byte-identical to pre-loop-block behaviour.
//
// Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §3.6.
// Plan: plans/2026-08-25-progress-aware-loop-guard.md (T4).
//
// Runtime-level construction only — `settings` injection bypasses disk, so
// this needs no HTTP server and no provider network call (`provider: 'ollama'`
// is keyless and `preflight: false` skips the probe), mirroring
// tests/config/settingsInjection.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — loop config block', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rt-loop-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'rt-loop-cwd-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('settings.loop is lifted onto runtime.loop', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama',
      preflight: false,
      cronEnabled: false,
      settings: { loop: { mode: 'off' } },
    });
    try {
      expect(runtime.loop).toEqual({ mode: 'off' });
    } finally {
      await runtime.dispose();
    }
  });

  test('a partial block keeps only the keys the host set', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama',
      preflight: false,
      cronEnabled: false,
      settings: { loop: { mode: 'warn', noProgressWindow: 12 } },
    });
    try {
      expect(runtime.loop).toEqual({ mode: 'warn', noProgressWindow: 12 });
      // No default-merge: unset keys never materialize.
      expect(Object.keys(runtime.loop ?? {}).sort()).toEqual(['mode', 'noProgressWindow']);
    } finally {
      await runtime.dispose();
    }
  });

  test('settings without a loop block leave runtime.loop absent', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama',
      preflight: false,
      cronEnabled: false,
      settings: { defaultModel: 'injected-model' },
    });
    try {
      expect(runtime.loop).toBeUndefined();
      expect('loop' in runtime).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('an empty loop block leaves runtime.loop absent', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'ollama',
      preflight: false,
      cronEnabled: false,
      settings: { loop: {} },
    });
    try {
      expect(runtime.loop).toBeUndefined();
      expect('loop' in runtime).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
