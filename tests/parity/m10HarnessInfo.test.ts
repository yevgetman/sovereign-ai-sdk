// M10 audit fix — verifies HarnessInfoTool is in the server-mode tool pool
// and its snapshot getter produces a well-formed result.
//
// Regression guard: pre-M10, src/server/runtime.ts called assembleToolPool
// without a harnessInfoSnapshot getter, so HarnessInfo was silently absent
// from the tool pool in --ui tui mode (audit slice 4 HIGH finding). Fix:
// pass a closure-based snapshot getter mirroring terminalRepl.ts:668-727.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('M10 — HarnessInfoTool wired in server-mode tool pool', () => {
  let runtime: Runtime;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m10-harnessinfo-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
    runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
  });

  afterAll(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('toolPool contains HarnessInfo tool', () => {
    const names = runtime.toolPool.map((t) => t.name);
    expect(names).toContain('HarnessInfo');
  });

  test('HarnessInfo tool invocation returns a well-formed snapshot', async () => {
    const tool = runtime.toolPool.find((t) => t.name === 'HarnessInfo');
    expect(tool).toBeDefined();
    if (!tool) return;
    // Call with no section filter — returns the full snapshot
    const result = await tool.call({} as never, {
      cwd: tmpHome,
      sessionId: 'test-session',
      harnessHome: tmpHome,
      agents: runtime.agents,
    });
    // buildTool envelope: { data, observation }
    expect(typeof result).toBe('object');
    const envelope = result as { data: Record<string, unknown>; observation: { status: string } };
    expect(envelope.observation.status).toBe('success');
    const snap = envelope.data;
    expect(snap).toHaveProperty('permissionMode');
    expect(snap).toHaveProperty('settingsLayers');
    expect(snap).toHaveProperty('mcpServers');
    expect(snap).toHaveProperty('tools');
    expect(snap).toHaveProperty('slashCommands');
    expect(snap).toHaveProperty('agents');
    expect(snap).toHaveProperty('budget');
    // tools.native must list at least the core file tools assembled into the pool
    const tools = snap.tools as { native: string[]; mcp: string[] };
    expect(Array.isArray(tools.native)).toBe(true);
    expect(tools.native.length).toBeGreaterThan(0);
    // Server-mode slashCommands is intentionally empty (audit note)
    expect(snap.slashCommands).toEqual([]);
  });
});
