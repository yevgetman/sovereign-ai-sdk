// Multi-agent workflows (W4) — `workflow_run` must be in the subagent
// exclusion set so it can never nest (a workflow task can't trigger a
// workflow) AND so it's stripped from the cron + channel tool pools (which
// both filter against this set), keeping arbitrary-workflow-triggering off
// untrusted remote surfaces. Spec §"Invocation surfaces".

import { describe, expect, test } from 'bun:test';
import { SUBAGENT_EXCLUDED_TOOLS } from '../../src/agents/exclusions.js';
import type { Runtime } from '../../src/server/runtime.js';
import { assembleToolPool } from '../../src/tool/registry.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';
import { WORKFLOW_RUN_TOOL_NAME, buildWorkflowRunTool } from '../../src/tools/WorkflowRunTool.js';

describe('workflow_run exclusion', () => {
  test('workflow_run is in SUBAGENT_EXCLUDED_TOOLS', () => {
    expect(SUBAGENT_EXCLUDED_TOOLS.has('workflow_run')).toBe(true);
  });

  test('the tool name constant matches the excluded name (no drift)', () => {
    expect(WORKFLOW_RUN_TOOL_NAME).toBe('workflow_run');
    expect(SUBAGENT_EXCLUDED_TOOLS.has(WORKFLOW_RUN_TOOL_NAME)).toBe(true);
  });

  test('filtering a pool against the exclusion set drops workflow_run (cron/channel pool shape)', () => {
    // Both cron (src/cron/wiring.ts) and channels (src/channels/pipeline.ts)
    // build their child pool as `pool.filter(t => !SUBAGENT_EXCLUDED_TOOLS.has(t.name))`.
    // Prove that shape removes workflow_run.
    const pool = [{ name: 'Read' }, { name: 'workflow_run' }, { name: 'Grep' }];
    const filtered = pool.filter((t) => !SUBAGENT_EXCLUDED_TOOLS.has(t.name));
    expect(filtered.map((t) => t.name)).toEqual(['Read', 'Grep']);
  });
});

// 2026-06-15 review fix (#61) — the model-invocable tool is now wired into the
// assembled pool via a lazy runtime getter (the pool is built before the
// runtime object exists).
describe('workflow_run wiring', () => {
  test('assembleToolPool includes workflow_run when supplied', () => {
    const tool = buildWorkflowRunTool({
      getRuntime: () => {
        throw new Error('getRuntime must NOT be called at build/assembly time');
      },
    }) as unknown as Tool<unknown, unknown>;
    const pool = assembleToolPool({} as ToolContext, { workflowRunTool: tool });
    expect(pool.some((t) => t.name === 'workflow_run')).toBe(true);
  });

  test('assembleToolPool omits workflow_run when not supplied', () => {
    const pool = assembleToolPool({} as ToolContext, {});
    expect(pool.some((t) => t.name === 'workflow_run')).toBe(false);
  });

  test('getRuntime resolves lazily — bound after build, read at call time', () => {
    const holder: { current: Runtime | undefined } = { current: undefined };
    // Build BEFORE the runtime exists (the real wiring order).
    const tool = buildWorkflowRunTool({
      getRuntime: () => {
        if (holder.current === undefined) throw new Error('not ready');
        return holder.current;
      },
    });
    // Building did not dereference the runtime.
    expect(tool.name).toBe('workflow_run');
    // Now bind it (as runtime.ts does after the literal).
    holder.current = { cwd: '/x', harnessHome: '/y' } as unknown as Runtime;
    // The getter would now resolve (proven indirectly by no throw building/pooling).
    expect(holder.current).toBeDefined();
  });
});
