import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents } from '@yevgetman/sov-sdk/agents/loader';

function makeAgentFile(agentsDir: string, name: string, content: string): void {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), content);
}

describe('loader: supportsMissionState', () => {
  test('parses supportsMissionState: true from frontmatter', async () => {
    const root = join(tmpdir(), `sov-agent-test-${randomUUID()}`);
    makeAgentFile(
      join(root, 'agents'),
      'test-mission-agent',
      `---
name: test-mission-agent
description: A test mission agent
allowedTools:
  - Read
supportsMissionState: true
---
You are a mission agent.`,
    );

    const registry = await loadAgents({ harnessHome: root, cwd: root });
    const agent = registry.byName.get('test-mission-agent');
    expect(agent).toBeDefined();
    expect(agent?.supportsMissionState).toBe(true);
  });

  test('defaults supportsMissionState to false when absent', async () => {
    const root = join(tmpdir(), `sov-agent-test-${randomUUID()}`);
    makeAgentFile(
      join(root, 'agents'),
      'plain-agent',
      `---
name: plain-agent
description: A plain agent
---
Plain system prompt.`,
    );

    const registry = await loadAgents({ harnessHome: root, cwd: root });
    const agent = registry.byName.get('plain-agent');
    expect(agent).toBeDefined();
    expect(agent?.supportsMissionState).toBe(false);
  });

  test('scheduled-mission bundle agent has supportsMissionState: true', async () => {
    const { getDefaultBundlePath } = await import('@yevgetman/sov-sdk/bundle/defaultBundle');
    const bundleRoot = getDefaultBundlePath();
    if (!bundleRoot) return; // skip if no default bundle
    const registry = await loadAgents({
      harnessHome: join(tmpdir(), `sov-bundle-test-${randomUUID()}`),
      cwd: tmpdir(),
      bundleRoot,
    });
    const agent = registry.byName.get('scheduled-mission');
    expect(agent).toBeDefined();
    expect(agent?.supportsMissionState).toBe(true);
  });
});
