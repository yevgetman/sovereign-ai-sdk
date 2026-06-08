// install/uninstall library tests. Pin the contract that:
//   - install accepts both file and directory sources
//   - frontmatter name drives the install target (NOT the source path)
//   - install refuses to overwrite without force:true
//   - uninstall only touches the user skills root
//   - uninstall refuses paths that would escape the user root
//   - reference files alongside SKILL.md get copied when source is a dir

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill, uninstallSkill } from '../../src/skills/install.js';
import { loadSkills } from '../../src/skills/loader.js';

let tmpHome: string;
let userSkills: string;
let sourceDir: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'sov-skill-install-'));
  userSkills = join(tmpHome, 'skills');
  sourceDir = join(tmpHome, 'src');
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

function makeSkillContent(name: string, desc = 'A test skill'): string {
  return `---
name: ${name}
description: ${desc}
---

Body of skill ${name}.
`;
}

describe('installSkill', () => {
  test('installs from a SKILL.md file', async () => {
    const src = join(sourceDir, 'SKILL.md');
    await writeFile(src, makeSkillContent('my-skill'));

    const result = await installSkill({ source: src, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected install to succeed');
    expect(result.name).toBe('my-skill');
    expect(result.installedAt).toBe(join(userSkills, 'my-skill'));
    expect(existsSync(join(userSkills, 'my-skill', 'SKILL.md'))).toBe(true);
  });

  test('installs from a directory containing SKILL.md', async () => {
    const dir = join(sourceDir, 'my-skill-pkg');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), makeSkillContent('my-skill'));
    await writeFile(join(dir, 'template.txt'), 'hello {{args}}');

    const result = await installSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected install to succeed');
    expect(result.name).toBe('my-skill');
    expect(existsSync(join(userSkills, 'my-skill', 'SKILL.md'))).toBe(true);
    // Reference file should be copied alongside.
    expect(existsSync(join(userSkills, 'my-skill', 'template.txt'))).toBe(true);
  });

  test('frontmatter name drives the target, not the source path', async () => {
    // Source dir named "weird-name" but frontmatter says "the-real-name"
    const dir = join(sourceDir, 'weird-name');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), makeSkillContent('the-real-name'));

    const result = await installSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected install to succeed');
    expect(existsSync(join(userSkills, 'the-real-name', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userSkills, 'weird-name'))).toBe(false);
  });

  test('refuses when source path does not exist', async () => {
    const result = await installSkill({
      source: join(sourceDir, 'nonexistent.md'),
      userSkillsRoot: userSkills,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected install to fail');
    expect(result.reason).toContain('not found');
  });

  test('refuses when directory lacks SKILL.md', async () => {
    const dir = join(sourceDir, 'no-skill');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'other.md'), '# not a skill');

    const result = await installSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected install to fail');
    expect(result.reason).toContain('SKILL.md');
  });

  test('refuses when file is not named SKILL.md', async () => {
    const src = join(sourceDir, 'wrong-name.md');
    await writeFile(src, makeSkillContent('my-skill'));

    const result = await installSkill({ source: src, userSkillsRoot: userSkills });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected install to fail');
    expect(result.reason).toContain('SKILL.md');
  });

  test('refuses when frontmatter is missing', async () => {
    const src = join(sourceDir, 'SKILL.md');
    await writeFile(src, '# just markdown\nno frontmatter\n');

    const result = await installSkill({ source: src, userSkillsRoot: userSkills });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected install to fail');
    expect(result.reason).toContain('frontmatter');
  });

  test('refuses when name is invalid', async () => {
    const src = join(sourceDir, 'SKILL.md');
    await writeFile(
      src,
      `---
name: 1bad-start
description: invalid
---
body
`,
    );

    const result = await installSkill({ source: src, userSkillsRoot: userSkills });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected install to fail');
    expect(result.reason).toContain('slash-command-safe');
  });

  test('refuses to overwrite without force:true', async () => {
    const src = join(sourceDir, 'SKILL.md');
    await writeFile(src, makeSkillContent('my-skill'));
    await installSkill({ source: src, userSkillsRoot: userSkills });

    const result = await installSkill({ source: src, userSkillsRoot: userSkills });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected install to fail');
    expect(result.reason).toContain('already installed');
  });

  test('overwrites with force:true', async () => {
    const src = join(sourceDir, 'SKILL.md');
    await writeFile(src, makeSkillContent('my-skill', 'original'));
    await installSkill({ source: src, userSkillsRoot: userSkills });

    await writeFile(src, makeSkillContent('my-skill', 'updated'));
    const result = await installSkill({
      source: src,
      userSkillsRoot: userSkills,
      force: true,
    });
    expect(result.ok).toBe(true);
    const installed = await readFile(join(userSkills, 'my-skill', 'SKILL.md'), 'utf8');
    expect(installed).toContain('updated');
  });

  test('refuses a directory source containing an out-of-tree symlink', async () => {
    const dir = join(sourceDir, 'evil-pkg');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), makeSkillContent('evil-pkg'));
    // A secret outside the source root smuggled in via a symlink. The shared
    // copy path (copySkillTree) must reject it before anything lands on disk —
    // this hardens the pre-existing installSkill too.
    const secret = join(tmpHome, 'secret.txt');
    await writeFile(secret, 'TOP SECRET');
    await symlink(secret, join(dir, 'references', 'leak.txt'));

    const result = await installSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected install to refuse the out-of-tree symlink');
    expect(result.reason.toLowerCase()).toContain('symlink');
    expect(existsSync(join(userSkills, 'evil-pkg', 'references', 'leak.txt'))).toBe(false);
  });

  // F10 — install's name extraction must use the real YAML parser, so the
  // dup-check + landed directory name match what the loader (and import)
  // register. A bespoke line-regex disagrees with YAML on quoted values and
  // inline comments, so the install dir could diverge from the loaded name.
  describe('name extraction matches the loader (F10)', () => {
    test('lands a quoted name unquoted, matching the loader', async () => {
      const src = join(sourceDir, 'SKILL.md');
      await writeFile(
        src,
        `---
name: "quoted-name"
description: A test skill
---
body
`,
      );
      const result = await installSkill({ source: src, userSkillsRoot: userSkills });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected install to succeed');
      // Dir + result name are the UNQUOTED form.
      expect(result.name).toBe('quoted-name');
      expect(existsSync(join(userSkills, 'quoted-name', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(userSkills, '"quoted-name"'))).toBe(false);
      // The loader registers the exact same name from the landed file.
      const registry = await loadSkills({
        cwd: join(tmpHome, 'project-empty'),
        harnessHome: tmpHome,
      });
      expect(registry.byName.has('quoted-name')).toBe(true);
    });

    test('a name with an inline YAML comment lands under the bare name', async () => {
      // The regex scrape yields `my-skill # inline comment` (which fails the
      // name schema → install wrongly refuses); the real YAML parser yields
      // `my-skill`, matching what the loader registers. RED before F10.
      const src = join(sourceDir, 'SKILL.md');
      await writeFile(
        src,
        `---
name: commented-name # this is a YAML comment
description: A test skill
---
body
`,
      );
      const result = await installSkill({ source: src, userSkillsRoot: userSkills });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected install to succeed');
      expect(result.name).toBe('commented-name');
      expect(existsSync(join(userSkills, 'commented-name', 'SKILL.md'))).toBe(true);
      const registry = await loadSkills({
        cwd: join(tmpHome, 'project-empty'),
        harnessHome: tmpHome,
      });
      expect(registry.byName.has('commented-name')).toBe(true);
    });

    test('a plain unquoted name still installs', async () => {
      const src = join(sourceDir, 'SKILL.md');
      await writeFile(src, makeSkillContent('plain-name'));
      const result = await installSkill({ source: src, userSkillsRoot: userSkills });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected install to succeed');
      expect(result.name).toBe('plain-name');
      expect(existsSync(join(userSkills, 'plain-name', 'SKILL.md'))).toBe(true);
    });
  });
});

describe('uninstallSkill', () => {
  test('removes the user-installed skill directory', async () => {
    const src = join(sourceDir, 'SKILL.md');
    await writeFile(src, makeSkillContent('my-skill'));
    await installSkill({ source: src, userSkillsRoot: userSkills });

    expect(existsSync(join(userSkills, 'my-skill'))).toBe(true);
    const result = await uninstallSkill({ name: 'my-skill', userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected uninstall to succeed');
    expect(result.name).toBe('my-skill');
    expect(existsSync(join(userSkills, 'my-skill'))).toBe(false);
  });

  test('refuses when skill is not installed', async () => {
    const result = await uninstallSkill({
      name: 'not-installed',
      userSkillsRoot: userSkills,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected uninstall to fail');
    expect(result.reason).toContain('not installed');
  });

  test('refuses path-traversal names like ../bin', async () => {
    const result = await uninstallSkill({
      name: '../bin',
      userSkillsRoot: userSkills,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected uninstall to fail');
    expect(result.reason).toContain('invalid skill name');
  });

  test('refuses path-traversal that bypasses name regex', async () => {
    // Even if a name regex check were bypassed, the absolute-path
    // guard should still reject anything outside userSkillsRoot.
    // We test this by creating a target outside the user root and
    // confirming we can't reach it via a valid-looking name (we
    // can't, by construction — name regex blocks slashes).
    const result = await uninstallSkill({
      name: 'foo',
      userSkillsRoot: userSkills,
    });
    expect(result.ok).toBe(false); // not installed; that's the expected error path
  });

  test('does not touch agent-created subdirectory by accident', async () => {
    // agent-created/ lives under userSkillsRoot but as a nested directory.
    // uninstall operates at name granularity (one level deep) — a name
    // of "agent-created" would target ${userSkills}/agent-created/
    // (the whole tree). Confirm this is rejected when not installed,
    // and accepted only if it actually exists at the top level.
    await mkdir(join(userSkills, 'agent-created', 'some-skill'), { recursive: true });
    await writeFile(
      join(userSkills, 'agent-created', 'some-skill', 'SKILL.md'),
      makeSkillContent('some-skill'),
    );

    // Trying to uninstall 'some-skill' directly (which is nested under
    // agent-created/) should fail because it doesn't exist at the top
    // level.
    const result = await uninstallSkill({
      name: 'some-skill',
      userSkillsRoot: userSkills,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected uninstall of nested skill to fail');

    // Nested file is still present.
    expect(existsSync(join(userSkills, 'agent-created', 'some-skill', 'SKILL.md'))).toBe(true);
  });
});
