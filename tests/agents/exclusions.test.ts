// Phase 13.5 — exclusion-set guarantees. Append-only, code-owned, contains
// at minimum the recursion guard and the parent-side control plane.

import { describe, expect, test } from 'bun:test';
import { SUBAGENT_EXCLUDED_TOOLS } from '@yevgetman/sov-sdk/agents/exclusions';

describe('SUBAGENT_EXCLUDED_TOOLS', () => {
  test('blocks recursive sub-agent spawning', () => {
    expect(SUBAGENT_EXCLUDED_TOOLS.has('AgentTool')).toBe(true);
  });

  test('blocks session-scoped cron CRUD tools from child contexts', () => {
    for (const name of [
      'cron_add',
      'cron_list',
      'cron_show',
      'cron_pause',
      'cron_resume',
      'cron_delete',
    ]) {
      expect(SUBAGENT_EXCLUDED_TOOLS.has(name)).toBe(true);
    }
  });

  test('does not contain the renamed cron_create placeholder', () => {
    expect(SUBAGENT_EXCLUDED_TOOLS.has('cron_create')).toBe(false);
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
