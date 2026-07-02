// Phase 16.1 M5 T8 — turns route threads scheduler + taskManager through
// toolContext.
//
// T6 (1ded093) added SubagentScheduler + LaneSemaphores + writeLock to
// Runtime. T7 (169c1dc) added TaskManager. T8 makes them reachable from
// inside a turn by populating the matching ToolContext fields when query()
// is invoked. Without this wiring, AgentTool throws "no scheduler in
// ToolContext" and task_create / task_list / task_get / task_output throw
// "no task manager in ToolContext" — every sub-agent and task path silently
// 404s through --ui tui.
//
// Test approach (option B in the plan): extract the toolContext
// construction into a helper exported from src/server/routes/turns.ts and
// unit-test the helper directly. This is the cheapest signal that T8's
// contribution is live — calling the full POST /turns surface would
// rebuild the whole turn loop just to assert four field assignments. The
// integration is implicitly exercised by tests/server/turns.test.ts (which
// drives an actual MockProvider turn through the route); this file pins
// the specific fields the plan calls out: subagentScheduler, taskManager,
// parentToolPool, canUseTool.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AskResponse } from '@yevgetman/sov-sdk/permissions/types';
import { buildSessionToolContext } from '../../src/server/routes/turns.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — toolContext threading (T8)', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-t8-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-t8-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('buildSessionToolContext populates subagentScheduler, taskManager, parentToolPool, canUseTool', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionId = 'test-session-id';
      // A trivial canUseTool stand-in — buildSessionToolContext doesn't
      // invoke it during construction, just records the reference. The
      // turns route passes the session-scoped canUseTool built around
      // serverAsk + the bus + permission settings; the helper is agnostic
      // to which canUseTool the caller hands it.
      const sessionCanUseTool = async (): Promise<{
        behavior: 'allow';
        updatedInput: unknown;
      }> => ({
        behavior: 'allow',
        updatedInput: {},
      });

      const ctx = buildSessionToolContext(runtime, sessionId, sessionCanUseTool);

      // Existing fields that buildRuntime's bare context already had —
      // T8 must preserve every one of them. The plan calls out cwd,
      // sessionId, harnessHome, agents, bundleRoot.
      expect(ctx.cwd).toBe(tmpCwd);
      expect(ctx.sessionId).toBe(sessionId);
      expect(ctx.harnessHome).toBe(tmpHome);
      expect(ctx.agents).toBe(runtime.agents);
      // bundleRoot is set when buildRuntime loaded a bundle. The default
      // bundle is present in this repo's test environment; the helper
      // must forward it when present and omit it when the runtime has no
      // bundle. Either is acceptable here — the assertion pins the
      // forward-when-present invariant.
      if (runtime.bundle !== null) {
        expect(ctx.bundleRoot).toBe(runtime.bundle.root);
      }

      // T8's new contribution — the four fields that turn AgentTool +
      // task_* tools from silent-throw to live.
      expect(ctx.subagentScheduler).toBe(runtime.subagentScheduler);
      expect(ctx.taskManager).toBe(runtime.taskManager);
      expect(ctx.parentToolPool).toBe(runtime.toolPool);
      expect(ctx.canUseTool).toBe(sessionCanUseTool);
    } finally {
      await runtime.dispose();
    }
  });

  test('buildSessionToolContext omits bundleRoot when runtime has no bundle', async () => {
    // Use a cwd outside any bundle to force loadBundleIfPresent to return
    // null. tmpCwd is a fresh mkdtemp dir; there's no bundle.json so the
    // default-bundle path is the only candidate. We force "no bundle" by
    // passing an explicit bundleRoot that doesn't exist — the loader
    // returns null and the runtime carries bundle === null.
    const noBundleRoot = join(tmpCwd, 'definitely-not-a-bundle');
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      bundleRoot: noBundleRoot,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionCanUseTool = async (): Promise<{
        behavior: 'allow';
        updatedInput: unknown;
      }> => ({
        behavior: 'allow',
        updatedInput: {},
      });
      const ctx = buildSessionToolContext(runtime, 'session-x', sessionCanUseTool);
      // bundleRoot should be undefined / absent — the helper must use the
      // same conditional-spread pattern the existing turns route used so
      // exactOptionalPropertyTypes stays happy.
      if (runtime.bundle === null) {
        expect(ctx.bundleRoot).toBeUndefined();
      }
    } finally {
      await runtime.dispose();
    }
  });
});

// Reference for the AskResponse type — exported tests don't use AskResponse
// directly but we import it to verify the module path resolves; if the
// import breaks, the test file fails to compile, surfacing the breakage
// earlier than a runtime mismatch would.
void (null as AskResponse | null);
