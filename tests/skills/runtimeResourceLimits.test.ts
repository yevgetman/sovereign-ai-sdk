import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SKILL_DISCOVERY_LIMITS } from '@yevgetman/sov-sdk/skills/discovery';
import { loadSkillText } from '@yevgetman/sov-sdk/skills/loader';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';

const markdown = '---\nname: bounded\ndescription: Bounded reference fixture\n---\nKeep the steps.';
const maxBytes = DEFAULT_SKILL_DISCOVERY_LIMITS.maxFileBytes;

describe('composed skill reference byte bounds', () => {
  test('custom readers keep exact-limit resources but refuse oversized UTF-8 before tool disclosure', async () => {
    const skill = loadSkillText(markdown, {
      path: 'virtual:/bounded/SKILL.md',
      source: 'agent-created',
      trustTier: 'agent-created',
    });
    let resource = 'é'.repeat(maxBytes / 2);
    const errors: string[] = [];
    const runtime = createSkillRuntime({
      load: async () => ({ registry: { skills: [skill], byName: new Map([[skill.name, skill]]) } }),
      resolveSkill: async () => skill,
      readResource: async () => resource,
    });
    runtime.subscribe((event) => {
      if (event.type === 'error') errors.push(event.operation);
    });
    try {
      await runtime.discover();
      const context = runtime.bindContext({ cwd: '/virtual', sessionId: 'bounded' });
      const result = await SkillsViewTool.call({ name: 'bounded', path: 'reference.md' }, context);
      expect(Buffer.byteLength(result.data.content)).toBe(maxBytes);
      expect(result.data.content).toBe(resource);
      resource += 'é';
      expect(resource.length).toBeLessThan(maxBytes);
      await expect(
        SkillsViewTool.call({ name: 'bounded', path: 'reference.md' }, context),
      ).rejects.toThrow('byte limit');
      expect(errors).toEqual(['inspect']);
      expect(runtime.snapshot().registry.byName.has('bounded')).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  test('approved filesystem links obey the per-file bound even when guard discovery skips the link', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reference-limit-'));
    const directory = join(cwd, '.harness/skills/bounded');
    const external = join(cwd, 'approved');
    const reference = join(external, 'reference.md');
    mkdirSync(directory, { recursive: true });
    mkdirSync(external);
    writeFileSync(join(directory, 'SKILL.md'), markdown);
    writeFileSync(reference, 'x'.repeat(maxBytes));
    symlinkSync(reference, join(directory, 'reference.md'));
    const runtime = createSkillRuntime({
      discovery: { cwd, harnessHome: join(cwd, 'empty') },
      allowedResourceRoots: async () => [directory, external],
    });
    try {
      await runtime.discover();
      const context = runtime.bindContext({ cwd, sessionId: 'bounded' });
      expect(
        Buffer.byteLength(
          (await SkillsViewTool.call({ name: 'bounded', path: 'reference.md' }, context)).data
            .content,
        ),
      ).toBe(maxBytes);
      writeFileSync(reference, 'x'.repeat(maxBytes + 1));
      await expect(
        SkillsViewTool.call({ name: 'bounded', path: 'reference.md' }, context),
      ).rejects.toThrow('bounded');
      expect(runtime.snapshot().registry.byName.has('bounded')).toBe(true);
    } finally {
      runtime.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
