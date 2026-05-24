// Phase 1 T5 — AgentDefinition fields: `inheritParentTools` and
// `allowedSubagents`. The loader threads them through frontmatter with
// safe defaults (false / []) so existing agents keep their current
// strict-allowlist behavior. The `buildSubagentExclusions` helper
// returns the exclusion set minus `AgentTool` when an agent declares
// non-empty `allowedSubagents` — enabling nested AgentTool dispatch
// gated by the per-child allowed list (enforcement lives in T8).

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUBAGENT_EXCLUDED_TOOLS, buildSubagentExclusions } from '../../src/agents/exclusions.js';
import { loadAgents } from '../../src/agents/loader.js';
import type { AgentDefinition } from '../../src/agents/types.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-agents-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeAgent(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

describe('agent definition new fields', () => {
  test('loader carries inheritParentTools and allowedSubagents from frontmatter', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/tester.md'),
        `---
name: tester
description: Test agent
inheritParentTools: true
allowedSubagents:
  - cheap-task
  - moderate-task
model: claude-sonnet-4-6
maxTurns: 30
readOnly: false
---

Body text.
`,
      );
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      const agent = registry.byName.get('tester');
      expect(agent).toBeDefined();
      expect(agent?.inheritParentTools).toBe(true);
      expect(agent?.allowedSubagents).toEqual(['cheap-task', 'moderate-task']);
    });
  });

  test('defaults: inheritParentTools=false, allowedSubagents=[]', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/tester.md'),
        `---
name: tester
description: Test agent
model: claude-sonnet-4-6
maxTurns: 30
readOnly: false
---

Body.
`,
      );
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      const agent = registry.byName.get('tester');
      expect(agent).toBeDefined();
      expect(agent?.inheritParentTools).toBe(false);
      expect(agent?.allowedSubagents).toEqual([]);
    });
  });
});

describe('buildSubagentExclusions', () => {
  test('keeps AgentTool in exclusions when allowedSubagents is empty', () => {
    const agent: Pick<AgentDefinition, 'allowedSubagents'> = { allowedSubagents: [] };
    const exclusions = buildSubagentExclusions(agent);
    expect(exclusions.has('AgentTool')).toBe(true);
    expect(exclusions.size).toBe(SUBAGENT_EXCLUDED_TOOLS.size);
  });

  test('removes AgentTool from exclusions when allowedSubagents is non-empty', () => {
    const agent: Pick<AgentDefinition, 'allowedSubagents'> = {
      allowedSubagents: ['cheap-task'],
    };
    const exclusions = buildSubagentExclusions(agent);
    expect(exclusions.has('AgentTool')).toBe(false);
    expect(exclusions.size).toBe(SUBAGENT_EXCLUDED_TOOLS.size - 1);
  });

  test('all other exclusions preserved when AgentTool removed', () => {
    const agent: Pick<AgentDefinition, 'allowedSubagents'> = {
      allowedSubagents: ['cheap-task'],
    };
    const exclusions = buildSubagentExclusions(agent);
    for (const tool of SUBAGENT_EXCLUDED_TOOLS) {
      if (tool === 'AgentTool') continue;
      expect(exclusions.has(tool)).toBe(true);
    }
  });
});

describe('bundled cost-lane agents', () => {
  test('cheap-task, moderate-task, frontier-task all use inheritParentTools=true', async () => {
    const registry = await loadAgents({
      cwd: process.cwd(),
      harnessHome: '/tmp/nonexistent-home',
      bundleRoot: 'bundle-default',
      warn: () => {},
    });
    for (const name of ['cheap-task', 'moderate-task', 'frontier-task']) {
      const agent = registry.byName.get(name);
      expect(agent).toBeDefined();
      expect(agent?.inheritParentTools).toBe(true);
      expect(agent?.role).toBe(name);
    }
  });
});
