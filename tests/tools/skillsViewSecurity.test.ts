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
import { open } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills } from '@yevgetman/sov-sdk/skills/loader';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-view-security-')));
  roots.push(root);
  const dir = join(root, '.harness', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'flat.md'),
    '---\nname: flat\ndescription: Flat fixture\n---\nRead a reference.',
  );
  const skills = await loadSkills({ cwd: root, harnessHome: join(root, 'empty-home') });
  return { root, dir, context: { cwd: root, sessionId: 'reference-fixture', skills } };
}

describe('legacy skill reference reads', () => {
  test('rejects a hidden ancestor swap during the pre-open identity snapshot', async () => {
    const f = await fixture();
    const refs = join(f.dir, 'refs');
    const outside = join(f.root, 'outside');
    mkdirSync(refs);
    mkdirSync(outside);
    const target = join(refs, 'data.txt');
    writeFileSync(target, 'initial-reference');
    writeFileSync(join(outside, 'data.txt'), 'outside-private-reference');
    const original = fsPromises.lstat;
    let swapped = false;
    const lstatSpy = spyOn(fsPromises, 'lstat').mockImplementation((async (
      path: PathLike,
      options?: StatOptions,
    ) => {
      if (path !== target || swapped) return original(path, options);
      swapped = true;
      renameSync(refs, `${refs}-old`);
      symlinkSync(outside, refs);
      try {
        return await original(path, options);
      } finally {
        unlinkSync(refs);
        renameSync(`${refs}-old`, refs);
      }
    }) as typeof original);
    try {
      await expect(
        SkillsViewTool.call({ name: 'flat', path: 'refs/data.txt' }, f.context),
      ).rejects.toThrow('changed');
      expect(swapped).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  test('rejects outside bytes when the ancestor swap is hidden before canonical checks', async () => {
    const f = await fixture();
    const refs = join(f.dir, 'refs');
    const outside = join(f.root, 'outside');
    mkdirSync(refs);
    mkdirSync(outside);
    const target = join(refs, 'data.txt');
    writeFileSync(target, 'initial-reference');
    writeFileSync(join(outside, 'data.txt'), 'outside-private-reference');
    const originalOpen = fsPromises.open;
    const originalStat = fsPromises.stat;
    let swapped = false;
    let hidden = false;
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(
      async (...args: Parameters<typeof originalOpen>) => {
        if (args[0] === target && !swapped) {
          swapped = true;
          renameSync(refs, `${refs}-old`);
          symlinkSync(outside, refs);
        }
        return originalOpen(...args);
      },
    );
    const statSpy = spyOn(fsPromises, 'stat').mockImplementation((async (
      path: PathLike,
      options?: StatOptions,
    ) => {
      const result = await originalStat(path, options);
      if (path === target && swapped && !hidden) {
        hidden = true;
        unlinkSync(refs);
        renameSync(`${refs}-old`, refs);
      }
      return result;
    }) as typeof originalStat);
    try {
      await expect(
        SkillsViewTool.call({ name: 'flat', path: 'refs/data.txt' }, f.context),
      ).rejects.toThrow('changed');
      expect(swapped).toBe(true);
    } finally {
      openSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  test('rejects a reference larger than the per-file discovery limit', async () => {
    const f = await fixture();
    writeFileSync(join(f.dir, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    await expect(
      SkillsViewTool.call({ name: 'flat', path: 'large.txt' }, f.context),
    ).rejects.toThrow('bounded');
  });

  test('rejects an ancestor retargeted after reading the opened file', async () => {
    const f = await fixture();
    const refs = join(f.dir, 'refs');
    const outside = join(f.root, 'outside');
    mkdirSync(refs);
    mkdirSync(outside);
    writeFileSync(join(refs, 'data.txt'), 'initial-reference');
    writeFileSync(join(outside, 'data.txt'), 'outside-private-reference');
    const probe = await open(join(refs, 'data.txt'), 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const original = prototype.read;
    let swapped = false;
    const readSpy = spyOn(prototype, 'read').mockImplementation(async function (
      this: typeof probe,
      ...args: Parameters<typeof original>
    ) {
      const result = await original.apply(this, args);
      if (!swapped && result.buffer.toString().startsWith('initial-reference')) {
        swapped = true;
        renameSync(refs, `${refs}-old`);
        symlinkSync(outside, refs);
      }
      return result;
    });
    try {
      await expect(
        SkillsViewTool.call({ name: 'flat', path: 'refs/data.txt' }, f.context),
      ).rejects.toThrow('changed');
      expect(swapped).toBe(true);
    } finally {
      readSpy.mockRestore();
      await probe.close();
    }
  });

  test('does not expose outside bytes when an ancestor changes during a metadata check', async () => {
    const f = await fixture();
    const refs = join(f.dir, 'refs');
    const outside = join(f.root, 'outside');
    mkdirSync(refs);
    mkdirSync(outside);
    const target = join(refs, 'data.txt');
    writeFileSync(target, 'initial-reference');
    writeFileSync(join(outside, 'data.txt'), 'outside-private-reference');
    const original = fsPromises.stat;
    let swapped = false;
    const retargetingStat = async (path: PathLike, options?: StatOptions) => {
      const result = await original(path, options);
      if (!swapped && path === target) {
        swapped = true;
        renameSync(refs, `${refs}-old`);
        symlinkSync(outside, refs);
      }
      return result;
    };
    const statSpy = spyOn(fsPromises, 'stat').mockImplementation(
      retargetingStat as typeof original,
    );
    try {
      await expect(
        SkillsViewTool.call({ name: 'flat', path: 'refs/data.txt' }, f.context),
      ).rejects.toThrow('changed');
      expect(swapped).toBe(true);
    } finally {
      statSpy.mockRestore();
    }
  });
});
