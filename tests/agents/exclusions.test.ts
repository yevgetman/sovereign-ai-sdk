// Phase 13.5 — exclusion-set guarantees. Append-only, code-owned, contains
// at minimum the recursion guard and the parent-side control plane.

import { describe, expect, test } from 'bun:test';
import { SUBAGENT_EXCLUDED_TOOLS } from '../../src/agents/exclusions.js';

describe('SUBAGENT_EXCLUDED_TOOLS', () => {
  test('blocks recursive sub-agent spawning', () => {
    expect(SUBAGENT_EXCLUDED_TOOLS.has('AgentTool')).toBe(true);
  });

  test('blocks session-scoped cron tools from child contexts', () => {
    expect(SUBAGENT_EXCLUDED_TOOLS.has('cron_create')).toBe(true);
    expect(SUBAGENT_EXCLUDED_TOOLS.has('cron_list')).toBe(true);
    expect(SUBAGENT_EXCLUDED_TOOLS.has('cron_delete')).toBe(true);
  });

  test('blocks parent-side control-plane tools', () => {
    expect(SUBAGENT_EXCLUDED_TOOLS.has('task_stop')).toBe(true);
    expect(SUBAGENT_EXCLUDED_TOOLS.has('send_message')).toBe(true);
  });

  test('does not exclude common read tools', () => {
    expect(SUBAGENT_EXCLUDED_TOOLS.has('Read')).toBe(false);
    expect(SUBAGENT_EXCLUDED_TOOLS.has('Grep')).toBe(false);
    expect(SUBAGENT_EXCLUDED_TOOLS.has('Glob')).toBe(false);
  });
});
