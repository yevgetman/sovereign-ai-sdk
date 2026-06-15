// Multi-agent workflows (W4) — `workflow_run` must be in the subagent
// exclusion set so it can never nest (a workflow task can't trigger a
// workflow) AND so it's stripped from the cron + channel tool pools (which
// both filter against this set), keeping arbitrary-workflow-triggering off
// untrusted remote surfaces. Spec §"Invocation surfaces".

import { describe, expect, test } from 'bun:test';
import { SUBAGENT_EXCLUDED_TOOLS } from '../../src/agents/exclusions.js';
import { WORKFLOW_RUN_TOOL_NAME } from '../../src/tools/WorkflowRunTool.js';

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
