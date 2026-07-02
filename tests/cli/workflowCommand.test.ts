// Multi-agent workflows (W4) — `sov workflow` CLI helpers.
//
// - runWorkflowList / runWorkflowShow over a temp project workflows dir.
// - runWorkflowRun e2e: build a mock-provider runtime, mint a parent session,
//   drive the engine over a one-phase / one-task workflow, assert the final
//   text + lifecycle events.
//
// NOTE: runWorkflowRun + runWorkflowList/Show import the sibling-owned W2 engine
// (src/workflows/engine.ts) and W3 loader (src/workflows/loader.ts). Until those
// land this file's RUN test is expected to fail at module resolution; the
// list/show + parse tests exercise only the loader. Flagged in the report as the
// central integration dependency.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import {
  formatWorkflowLine,
  parseArgPairs,
  runWorkflowList,
  runWorkflowRun,
  runWorkflowShow,
} from '../../src/cli/workflowCommand.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { WorkflowEvent } from '../../src/workflows/events.js';

const ECHO_AGENT = `---
name: echo
description: A read-only agent used by the workflow smoke test.
readOnly: true
---
You are a test agent. Reply with a one-line summary.
`;

const SMOKE_WORKFLOW = `name: smoke
description: One-phase one-task smoke workflow.
phases:
  - id: synthesize
    tasks:
      - agent: echo
        prompt: 'Say hello.'
`;

let home: string;
let cwd: string;

function seedProject(): void {
  mkdirSync(join(cwd, '.harness', 'agents'), { recursive: true });
  mkdirSync(join(cwd, '.harness', 'workflows'), { recursive: true });
  writeFileSync(join(cwd, '.harness', 'agents', 'echo.md'), ECHO_AGENT, 'utf8');
  writeFileSync(join(cwd, '.harness', 'workflows', 'smoke.yaml'), SMOKE_WORKFLOW, 'utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-wf-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sov-wf-cwd-'));
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  MockProvider.toolUseMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  seedProject();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  // biome-ignore lint/performance/noDelete: process.env requires delete to unset.
  delete process.env.SOV_TEST_MOCK_PROVIDER;
});

describe('sov workflow list / show', () => {
  test('list surfaces the seeded project workflow', async () => {
    const entries = await runWorkflowList({ cwd, harnessHome: home });
    expect(entries.map((e) => e.name)).toContain('smoke');
    const smoke = entries.find((e) => e.name === 'smoke');
    expect(smoke?.source).toBe('project');
    expect(smoke?.phaseCount).toBe(1);
  });

  test('show returns the definition for a named workflow', async () => {
    const loaded = await runWorkflowShow('smoke', { cwd, harnessHome: home });
    expect(loaded?.def.name).toBe('smoke');
    expect(loaded?.def.phases).toHaveLength(1);
  });

  test('show returns undefined for an unknown workflow', async () => {
    const loaded = await runWorkflowShow('nope', { cwd, harnessHome: home });
    expect(loaded).toBeUndefined();
  });

  test('formatWorkflowLine includes name, source, and description', () => {
    const line = formatWorkflowLine({
      name: 'smoke',
      description: 'a smoke workflow',
      source: 'project',
      phaseCount: 1,
    });
    expect(line).toContain('smoke');
    expect(line).toContain('project');
    expect(line).toContain('a smoke workflow');
  });
});

describe('sov workflow run — e2e with MockProvider', () => {
  test('runs the workflow, emits lifecycle events, and returns final text', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
    });
    const events: WorkflowEvent[] = [];
    try {
      const { result } = await runWorkflowRun({
        runtime,
        name: 'smoke',
        args: {},
        onEvent: (e) => events.push(e),
      });
      expect(result.ok).toBe(true);
      // The mock provider's default turn emits "Hello world."; the single
      // synthesis task's final text is the workflow's finalText.
      expect(result.finalText).toContain('Hello world.');
      // Lifecycle events bracket the run.
      expect(events.some((e) => e.type === 'workflow_started')).toBe(true);
      expect(events.some((e) => e.type === 'workflow_complete')).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 20_000);

  test('an unknown workflow name throws with the available list', async () => {
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd,
      provider: 'mock',
      preflight: false,
      cronEnabled: false,
    });
    try {
      await expect(runWorkflowRun({ runtime, name: 'ghost', args: {} })).rejects.toThrow(
        /no workflow named 'ghost'/,
      );
    } finally {
      await runtime.dispose();
    }
  }, 20_000);
});

describe('parseArgPairs (CLI)', () => {
  test('parses repeated key=value tokens', () => {
    expect(parseArgPairs(['diff=abc', 'dim=bugs'])).toEqual({ diff: 'abc', dim: 'bugs' });
  });

  test('rejects a token with no =', () => {
    expect(() => parseArgPairs(['bad'])).toThrow(/expected key=value/);
  });
});
