import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  type PathLike,
  type StatOptions,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillText } from '@yevgetman/sov-sdk/skills/loader';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-reference-identity-')));
  roots.push(root);
  const directory = join(root, 'skill');
  const refs = join(directory, 'refs');
  const outside = join(root, 'outside');
  mkdirSync(refs, { recursive: true });
  mkdirSync(outside);
  const markdown =
    '---\nname: safe\ndescription: Resource identity fixture\n---\nRead the bounded reference.';
  writeFileSync(join(directory, 'SKILL.md'), markdown);
  const target = join(refs, 'data.txt');
  writeFileSync(target, 'accepted-reference');
  writeFileSync(join(outside, 'data.txt'), 'outside-private-reference');
  const skill = loadSkillText(markdown, {
    path: join(directory, 'SKILL.md'),
    source: 'project',
    trustTier: 'trusted',
  });
  const runtime = createSkillRuntime({
    load: async () => ({ registry: { skills: [skill], byName: new Map([[skill.name, skill]]) } }),
    resolveSkill: async (current) => current,
  });
  await runtime.discover();
  const context = runtime.bindContext({ cwd: root, sessionId: 'fixture' });
  return { root, refs, target, outside, runtime, context };
}

describe('composed reference opened identity', () => {
  test('a concealed ancestor swap cannot expose the outside opened file through skill_view', async () => {
    const f = await fixture();
    const originalOpen = fsPromises.open;
    const originalStat = fsPromises.stat;
    let swapped = false;
    let hidden = false;
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(
      async (...args: Parameters<typeof originalOpen>) => {
        if (args[0] === f.target && !swapped) {
          swapped = true;
          renameSync(f.refs, `${f.refs}-old`);
          symlinkSync(f.outside, f.refs);
        }
        return originalOpen(...args);
      },
    );
    const statSpy = spyOn(fsPromises, 'stat').mockImplementation((async (
      path: PathLike,
      options?: StatOptions,
    ) => {
      const result = await originalStat(path, options);
      if (path === f.target && swapped && !hidden) {
        hidden = true;
        unlinkSync(f.refs);
        renameSync(`${f.refs}-old`, f.refs);
      }
      return result;
    }) as typeof originalStat);
    try {
      await expect(
        SkillsViewTool.call({ name: 'safe', path: 'refs/data.txt' }, f.context),
      ).rejects.toThrow('changed');
      expect(swapped).toBe(true);
    } finally {
      openSpy.mockRestore();
      statSpy.mockRestore();
      f.runtime.dispose();
    }
  });

  test('a concealed snapshot swap cannot attach outside metadata to the accepted opened file', async () => {
    const f = await fixture();
    const original = fsPromises.lstat;
    let swapped = false;
    const lstatSpy = spyOn(fsPromises, 'lstat').mockImplementation((async (
      path: PathLike,
      options?: StatOptions,
    ) => {
      if (path !== f.target || swapped) return original(path, options);
      swapped = true;
      renameSync(f.refs, `${f.refs}-old`);
      symlinkSync(f.outside, f.refs);
      try {
        return await original(path, options);
      } finally {
        unlinkSync(f.refs);
        renameSync(`${f.refs}-old`, f.refs);
      }
    }) as typeof original);
    try {
      await expect(f.runtime.inspect('safe', 'refs/data.txt')).rejects.toThrow('changed');
      expect(swapped).toBe(true);
    } finally {
      lstatSpy.mockRestore();
      f.runtime.dispose();
    }
  });

  test('stable canonical and in-tree linked references retain their accepted bytes', async () => {
    const f = await fixture();
    symlinkSync(f.target, join(f.refs, 'alias.txt'));
    try {
      const direct = await f.runtime.inspect('safe', 'refs/data.txt');
      const alias = await f.runtime.inspect('safe', 'refs/alias.txt');
      expect(direct.content).toBe('accepted-reference');
      expect(alias.content).toBe(direct.content);
      expect(alias.resourceIdentity).toBe(direct.resourceIdentity);
    } finally {
      f.runtime.dispose();
    }
  });
});
