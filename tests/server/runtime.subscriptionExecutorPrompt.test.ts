// SPIKE — verify buildRuntime injects the subscription-executor bias
// system-prompt segment into the parent system prompt ONLY when
// `subscriptionExecutor.enabled === true`. Without the segment, enabling the
// executor makes the role a legal AgentTool target but nothing nudges the model
// to pick it — the observed failure mode (the agent built a page inline and
// never delegated to the shell).
//
// Mirrors tests/server/runtime.taskRouting.test.ts (the smart-router segment
// wiring test).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('buildRuntime — subscription-executor bias segment', () => {
  let home: string;
  let prevHarnessHome: string | undefined;
  let prevMockFlag: string | undefined;

  beforeEach(() => {
    prevHarnessHome = process.env.HARNESS_HOME;
    prevMockFlag = process.env.SOV_TEST_MOCK_PROVIDER;
    home = mkdtempSync(join(tmpdir(), 'rt-subexec-'));
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

  test('segment NOT in systemSegments when disabled (default)', async () => {
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
      // The XML-style tag uniquely marks the segment. The bare substring can
      // appear in recent git commit messages surfaced in the runtime context
      // block — so we assert on the tag, not the bare substring.
      expect(joined).not.toContain('<subscription-executor>');
    } finally {
      await runtime.dispose();
    }
  });

  test('segment IS in systemSegments when enabled and file exists', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        subscriptionExecutor: { enabled: true },
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
      preflight: false,
    });
    try {
      const joined = runtime.systemSegments.map((s) => s.text ?? '').join('\n');
      const promptPath = join(
        process.cwd(),
        'bundle-default',
        'prompts',
        'subscription-executor.md',
      );
      if (existsSync(promptPath)) {
        expect(joined).toContain('<subscription-executor>');
        // The bias instruction must name the delegation target so the model
        // knows what to call.
        expect(joined).toContain('subagent_type: "subscription-executor"');
      } else {
        // Wiring is in place but the file is absent — runtime still boots.
        expect(runtime.systemSegments.length).toBeGreaterThan(0);
        expect(joined).toContain('You are an interactive agent.');
      }
    } finally {
      await runtime.dispose();
    }
  });
});
