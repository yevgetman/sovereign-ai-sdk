// Phase 13.1 — agent definition loader tests. Mirrors the skills loader
// shape: three search paths (project, user, bundle), markdown frontmatter,
// project precedence on duplicate names, sorted output, realpath dedupe.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents } from '@yevgetman/sov-sdk/agents/loader';

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

describe('loadAgents', () => {
  test('returns empty registry when no roots exist', async () => {
    await withTmp(async (dir) => {
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
      });
      expect(registry.agents).toEqual([]);
      expect(registry.byName.size).toBe(0);
    });
  });

  test('loads bundle agents with builtin trust tier', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/explore.md'),
        `---
name: explore
description: Fast codebase explorer
allowedTools: [Read, Grep, Glob]
maxTurns: 30
readOnly: true
---
You are an exploration agent. Find files and grep for patterns.
`,
      );
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      expect(registry.agents).toHaveLength(1);
      const agent = registry.byName.get('explore');
      expect(agent).toBeDefined();
      expect(agent?.source).toBe('bundle');
      expect(agent?.trustTier).toBe('builtin');
      expect(agent?.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
      expect(agent?.maxTurns).toBe(30);
      expect(agent?.readOnly).toBe(true);
      expect(agent?.systemPrompt).toContain('exploration agent');
    });
  });

  test('project agents override bundle agents on name collision', async () => {
    await withTmp(async (dir) => {
      const cwd = join(dir, 'project');
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(cwd, '.harness/agents/explore.md'),
        `---
name: explore
description: Project explore
allowedTools: [Read]
---
Project body
`,
      );
      writeAgent(
        join(bundleRoot, 'agents/explore.md'),
        `---
name: explore
description: Bundle explore
---
Bundle body
`,
      );
      const warnings: string[] = [];
      const registry = await loadAgents({
        cwd,
        harnessHome: join(dir, 'home'),
        bundleRoot,
        warn: (m) => warnings.push(m),
      });
      const agent = registry.byName.get('explore');
      expect(agent?.source).toBe('project');
      expect(agent?.allowedTools).toEqual(['Read']);
      expect(warnings.some((m) => m.includes('duplicate agent name'))).toBe(true);
    });
  });

  test('uses frontmatter systemPrompt when present, body otherwise', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/inline.md'),
        `---
name: inline
description: Inline prompt agent
systemPrompt: |
  You are inline.
  Be concise.
---
This body should be ignored.
`,
      );
      writeAgent(
        join(bundleRoot, 'agents/body.md'),
        `---
name: body
description: Body prompt agent
---
You are body.
Use the markdown body as the prompt.
`,
      );
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      const inline = registry.byName.get('inline');
      const body = registry.byName.get('body');
      expect(inline?.systemPrompt.trim()).toBe('You are inline.\nBe concise.');
      expect(body?.systemPrompt).toContain('You are body.');
      expect(inline?.systemPrompt).not.toContain('should be ignored');
    });
  });

  test('rejects agents missing required frontmatter fields', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/no-name.md'),
        `---
description: missing name
---
Body
`,
      );
      writeAgent(
        join(bundleRoot, 'agents/empty-prompt.md'),
        `---
name: empty
description: missing system prompt and empty body
---
`,
      );
      const warnings: string[] = [];
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
        warn: (m) => warnings.push(m),
      });
      expect(registry.agents).toHaveLength(0);
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('rejects agents with invalid names', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/bad-leading.md'),
        `---
name: 1bad
description: leading digit
---
Body
`,
      );
      writeAgent(
        join(bundleRoot, 'agents/bad-space.md'),
        `---
name: with spaces
description: spaces in name
---
Body
`,
      );
      const warnings: string[] = [];
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
        warn: (m) => warnings.push(m),
      });
      expect(registry.agents).toHaveLength(0);
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('rejects when both model and role are set', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/conflict.md'),
        `---
name: conflict
description: both set
model: anthropic/claude-haiku-4-5
role: explore
---
Body
`,
      );
      const warnings: string[] = [];
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
        warn: (m) => warnings.push(m),
      });
      expect(registry.agents).toHaveLength(0);
      expect(warnings.some((m) => m.includes('model') && m.includes('role'))).toBe(true);
    });
  });

  test('applies defaults: maxTurns=50, readOnly=false, allowedTools=[]', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/minimal.md'),
        `---
name: minimal
description: only required fields
---
Be helpful.
`,
      );
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      const a = registry.byName.get('minimal');
      expect(a?.maxTurns).toBe(50);
      expect(a?.readOnly).toBe(false);
      expect(a?.allowedTools).toEqual([]);
      expect(a?.model).toBeUndefined();
      expect(a?.role).toBeUndefined();
    });
  });

  test('returns agents sorted by name', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/zeta.md'),
        `---
name: zeta
description: zeta
---
Body
`,
      );
      writeAgent(
        join(bundleRoot, 'agents/alpha.md'),
        `---
name: alpha
description: alpha
---
Body
`,
      );
      writeAgent(
        join(bundleRoot, 'agents/mu.md'),
        `---
name: mu
description: mu
---
Body
`,
      );
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      expect(registry.agents.map((a) => a.name)).toEqual(['alpha', 'mu', 'zeta']);
    });
  });

  test('dedupes via realpath when symlinks alias the same file', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      const harnessHome = join(dir, 'home');
      writeAgent(
        join(bundleRoot, 'agents/source.md'),
        `---
name: aliased
description: original
---
Body
`,
      );
      mkdirSync(join(harnessHome, 'agents'), { recursive: true });
      symlinkSync(join(bundleRoot, 'agents/source.md'), join(harnessHome, 'agents/alias.md'));
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome,
        bundleRoot,
      });
      expect(registry.agents).toHaveLength(1);
      expect(registry.byName.get('aliased')).toBeDefined();
    });
  });

  test('user agents under harnessHome have trusted trust tier', async () => {
    await withTmp(async (dir) => {
      const harnessHome = join(dir, 'home');
      writeAgent(
        join(harnessHome, 'agents/local.md'),
        `---
name: local
description: user-defined
---
Body
`,
      );
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome,
      });
      const a = registry.byName.get('local');
      expect(a?.source).toBe('user');
      expect(a?.trustTier).toBe('trusted');
    });
  });

  test('parses allowedTools list with patterns like Bash(git *)', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeAgent(
        join(bundleRoot, 'agents/patterned.md'),
        `---
name: patterned
description: with patterns
allowedTools:
  - Read
  - Grep
  - Bash(git log *)
  - Bash(git status *)
---
Body
`,
      );
      const registry = await loadAgents({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      const a = registry.byName.get('patterned');
      expect(a?.allowedTools).toEqual(['Read', 'Grep', 'Bash(git log *)', 'Bash(git status *)']);
    });
  });
});
