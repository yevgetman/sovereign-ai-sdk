// Phase 1 T9 — verify buildRuntime wires the task-routing infrastructure
// (lane registry, preflight, scheduler hook, smart-router segment) into the
// runtime lifecycle. Without these the rest of Phase 1 has no boot path —
// the `delegator` agent never resolves to the operator-pinned model, the
// smart-router prompt segment never reaches the parent, and preflight
// failures slip past until first dispatch.
//
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md
// Plan: docs/plans/2026-05-23-phase-1-task-routing.md (T9)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('buildRuntime — taskRouting wiring', () => {
  let home: string;
  let prevHarnessHome: string | undefined;
  let prevMockFlag: string | undefined;

  beforeEach(() => {
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockFlag = process.env.SOV_TEST_MOCK_PROVIDER;
    home = mkdtempSync(join(tmpdir(), 'rt-tr-'));
    process.env.HARNESS_HOME = home;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    if (prevHarnessHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_HOME;
    } else {
      process.env.HARNESS_HOME = prevHarnessHome;
    }
    if (prevMockFlag === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
    } else {
      process.env.SOV_TEST_MOCK_PROVIDER = prevMockFlag;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test('runtime.laneRegistry exposed regardless of enabled state', async () => {
    const { buildRuntime } = await import('../../src/server/runtime.js');
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
    try {
      expect(runtime.laneRegistry).toBeDefined();
      // All four configured roles resolve to defaults even when taskRouting
      // is disabled — the registry is built unconditionally so cost-lane
      // sub-agents remain reachable via /agent (B-via-D bridge baseline).
      expect(runtime.laneRegistry.lookup('cheap-task')).toBeDefined();
      expect(runtime.laneRegistry.lookup('moderate-task')).toBeDefined();
      expect(runtime.laneRegistry.lookup('frontier-task')).toBeDefined();
      expect(runtime.laneRegistry.lookup('delegator')).toBeDefined();
      // Unknown roles return undefined.
      expect(runtime.laneRegistry.lookup('not-a-lane')).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  test('smart-router segment NOT in systemSegments when disabled (default)', async () => {
    const { buildRuntime } = await import('../../src/server/runtime.js');
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
    try {
      const joined = runtime.systemSegments.map((s) => s.text ?? '').join('\n');
      expect(joined).not.toContain('<smart-router>');
      expect(joined).not.toContain('smart-router');
    } finally {
      await runtime.dispose();
    }
  });

  test('smart-router segment IS in systemSegments when enabled and file exists', async () => {
    // Write taskRouting.enabled into the per-test harness home's config so
    // readConfig() picks it up at boot. The config path under HARNESS_HOME
    // is `<home>/config.json` (see src/config/store.ts:resolveConfigPath).
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        taskRouting: { enabled: true },
      }),
      'utf8',
    );
    const { buildRuntime } = await import('../../src/server/runtime.js');
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      cronEnabled: false,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false, // skip provider + lane preflight in this test path
    });
    try {
      const joined = runtime.systemSegments.map((s) => s.text ?? '').join('\n');
      // T11 (separate task) ships the actual `bundle-default/prompts/smart-router.md`
      // file. For T9 we test only the injection MECHANISM — when the file
      // exists at HEAD the contents land in systemSegments; when not (T11
      // hasn't shipped yet) the runtime still boots cleanly.
      const promptPath = join(process.cwd(), 'bundle-default', 'prompts', 'smart-router.md');
      if (existsSync(promptPath)) {
        // The file is shipped — at minimum the segment carries some content.
        expect(joined).toContain('smart-router');
      } else {
        // The file is not shipped yet — the wiring is in place but the
        // injection is a no-op. Assert the runtime booted cleanly without
        // crashing and that systemSegments still carries the base
        // instructions (so we know we didn't accidentally truncate them).
        expect(runtime.systemSegments.length).toBeGreaterThan(0);
        expect(joined).toContain('You are an interactive agent.');
      }
    } finally {
      await runtime.dispose();
    }
  });
});
