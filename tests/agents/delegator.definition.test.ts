import { describe, expect, test } from 'bun:test';

describe('delegator agent definition', () => {
  test('loads with correct frontmatter and prompt', async () => {
    const { loadAgents } = await import('../../src/agents/loader.js');
    const result = await loadAgents({
      cwd: process.cwd(),
      harnessHome: '/tmp/nonexistent-home',
      bundleRoot: 'bundle-default',
      warn: () => {},
    });
    const delegator = result.agents.find((a) => a.name === 'delegator');
    expect(delegator).toBeDefined();
    expect(delegator?.role).toBe('delegator');
    expect(delegator?.allowedSubagents).toEqual(['cheap-task', 'moderate-task', 'frontier-task']);
    expect(delegator?.allowedTools).toContain('AgentTool');
    expect(delegator?.inheritParentTools).toBe(false);
    // Body content checks — load-bearing prompt features
    expect(delegator?.systemPrompt).toContain('lane');
    expect(delegator?.systemPrompt).toContain('AgentTool');
    expect(delegator?.systemPrompt).toContain('synthesis');
    expect(delegator?.systemPrompt).toContain('cheap-task');
    expect(delegator?.systemPrompt).toContain('moderate-task');
    expect(delegator?.systemPrompt).toContain('frontier-task');
  });
});
