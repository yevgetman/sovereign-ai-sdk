import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandSkillPrompt, loadSkills, reloadSkill } from '../../src/skills/loader.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-skills-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSkill(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

describe('loadSkills', () => {
  test('scans project, user, and bundle skills with project-name precedence', async () => {
    await withTmp(async (dir) => {
      const cwd = join(dir, 'project');
      const harnessHome = join(dir, 'home');
      const bundleRoot = join(dir, 'bundle');
      writeSkill(
        join(cwd, '.harness/skills/simplify.md'),
        `---
name: simplify
description: Project simplify
allowedTools: [Read, Edit]
whenToUse: Project cleanup request
---
Project body {{args}}
`,
      );
      writeSkill(
        join(harnessHome, 'skills/simplify.md'),
        `---
name: simplify
description: User simplify
whenToUse: User cleanup request
---
User body
`,
      );
      writeSkill(
        join(bundleRoot, 'skills/review.md'),
        `---
name: review
description: Bundle review
allowedTools:
  - Bash(git status **)
whenToUse: Review changed code
---
Review body
`,
      );

      const warnings: string[] = [];
      const registry = await loadSkills({
        cwd,
        harnessHome,
        bundleRoot,
        warn: (message) => warnings.push(message),
      });

      expect(registry.skills.map((skill) => skill.name)).toEqual(['review', 'simplify']);
      expect(registry.byName.get('simplify')?.source).toBe('project');
      expect(registry.byName.get('simplify')?.allowedTools).toEqual(['Read', 'Edit']);
      expect(warnings.some((message) => message.includes('duplicate skill name'))).toBe(true);
    });
  });
});

describe('expandSkillPrompt', () => {
  test('substitutes args and inline shell interpolation', async () => {
    await withTmp(async (dir) => {
      const skill = {
        name: 'where',
        description: 'Show cwd',
        whenToUse: 'Need cwd',
        allowedTools: [],
        path: join(dir, 'where.md'),
        realpath: join(dir, 'where.md'),
        source: 'project' as const,
        body: 'Args={{args}}\nCWD=`!pwd`',
      };

      const expanded = await expandSkillPrompt(skill, { args: 'src/main.ts', cwd: dir });
      expect(expanded).toContain('Args=src/main.ts');
      expect(expanded).toContain(`CWD=${realpathSync(dir)}`);
    });
  });
});

describe('reloadSkill', () => {
  test('re-reads the skill file lazily for command invocation', async () => {
    await withTmp(async (dir) => {
      const cwd = join(dir, 'project');
      const harnessHome = join(dir, 'home');
      const bundleRoot = join(dir, 'bundle');
      const skillPath = join(bundleRoot, 'skills/fresh.md');
      writeSkill(
        skillPath,
        `---
name: fresh
description: Fresh skill
whenToUse: Re-read check
---
Old {{args}}
`,
      );
      const registry = await loadSkills({ cwd, harnessHome, bundleRoot });
      const loaded = registry.byName.get('fresh');
      if (!loaded) throw new Error('skill not loaded');

      writeSkill(
        skillPath,
        `---
name: fresh
description: Fresh skill
whenToUse: Re-read check
---
New {{args}}
`,
      );

      const reloaded = await reloadSkill(loaded);
      expect(await expandSkillPrompt(reloaded, { args: 'body', cwd: dir })).toBe('New body');
    });
  });
});
