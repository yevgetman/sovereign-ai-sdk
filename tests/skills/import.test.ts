// importSkill tests (Feature A2). The `import` verb is distinct from
// `install`: it rewrites a Claude Code SKILL.md's frontmatter into the
// harness-native canonical shape on write, rather than copying it
// byte-faithfully. The contract this pins:
//   - a CC SKILL.md (hyphenated `allowed-tools`, comma-string form) lands
//     with a canonical `allowedTools:` list and no `allowed-tools:` key;
//   - `converted` records the rewrite; `warnings` records ignored CC keys
//     (model/license/argument-hint) and `:`-glob Bash patterns;
//   - bundled reference files (references/, scripts/) are copied;
//   - import refuses a skill that fails the loader schema (e.g. no description);
//   - whenToUse is synthesized from description when absent, so the imported
//     skill loads cleanly without the validateWhenToUse warning;
//   - the imported skill loads back through the real loader.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSkill } from '../../src/skills/install.js';
import { loadSkills } from '../../src/skills/loader.js';

let tmpHome: string;
let userSkills: string;
let sourceDir: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'sov-skill-import-'));
  userSkills = join(tmpHome, 'skills');
  sourceDir = join(tmpHome, 'src');
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe('importSkill', () => {
  test('rewrites a CC SKILL.md to canonical allowedTools and drops allowed-tools', async () => {
    const dir = join(sourceDir, 'cc-pkg');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: cc-skill
description: A Claude Code skill
allowed-tools: Read, Grep
model: claude-opus-4
---

Body of the CC skill.
`,
    );

    const result = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected import to succeed');
    expect(result.name).toBe('cc-skill');
    expect(result.installedAt).toBe(join(userSkills, 'cc-skill'));

    const written = await readFile(join(userSkills, 'cc-skill', 'SKILL.md'), 'utf8');
    expect(written).toContain('allowedTools:');
    expect(written).not.toContain('allowed-tools:');
    // The model key is a CC-only field with no harness equivalent — it must
    // not survive into the canonical frontmatter.
    expect(written).not.toContain('model:');

    // converted records the allowed-tools rewrite; warnings records the
    // ignored `model` key.
    expect(result.converted.some((c) => c.includes('allowed-tools'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('model'))).toBe(true);
  });

  test('copies bundled references/ and scripts/ alongside the rewritten SKILL.md', async () => {
    const dir = join(sourceDir, 'with-refs');
    await mkdir(join(dir, 'references'), { recursive: true });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: with-refs
description: Skill with reference files
allowed-tools: Read
---

Body.
`,
    );
    await writeFile(join(dir, 'references', 'guide.md'), '# Guide');
    await writeFile(join(dir, 'scripts', 'run.sh'), 'echo hi');

    const result = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    expect(existsSync(join(userSkills, 'with-refs', 'references', 'guide.md'))).toBe(true);
    expect(existsSync(join(userSkills, 'with-refs', 'scripts', 'run.sh'))).toBe(true);
  });

  test('refuses a skill that fails the loader schema (missing description)', async () => {
    const dir = join(sourceDir, 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: broken
allowed-tools: Read
---

No description here.
`,
    );

    const result = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected import to fail');
    expect(result.reason.toLowerCase()).toContain('description');
    // Nothing should have landed on disk.
    expect(existsSync(join(userSkills, 'broken'))).toBe(false);
  });

  test('synthesizes whenToUse from description so the import loads without a warning', async () => {
    const dir = join(sourceDir, 'no-when');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: no-when
description: Use this skill when the user asks to summarize a file
allowed-tools: Read
---

Body.
`,
    );

    const importResult = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(importResult.ok).toBe(true);
    const written = await readFile(join(userSkills, 'no-when', 'SKILL.md'), 'utf8');
    expect(written).toContain('whenToUse:');

    // The imported skill must load back through the real loader with its
    // allowedTools populated and no whenToUse warning.
    const warnings: string[] = [];
    const registry = await loadSkills({
      cwd: join(tmpHome, 'project-empty'),
      harnessHome: tmpHome,
      warn: (m) => warnings.push(m),
    });
    const loaded = registry.byName.get('no-when');
    expect(loaded).toBeDefined();
    expect(loaded?.allowedTools).toEqual(['Read']);
    expect(warnings.some((w) => w.includes('no-when'))).toBe(false);
  });

  test('warns on a Bash(...) pattern carrying a CC :-glob but keeps it verbatim', async () => {
    const dir = join(sourceDir, 'glob-skill');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: glob-skill
description: Skill using a CC colon glob
allowed-tools: Read, Bash(git status:*)
---

Body.
`,
    );

    const result = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected import to succeed');
    // We do NOT auto-translate the :-glob (translation is lossy); we warn so
    // the user can adjust, and keep the entry verbatim in the output.
    expect(result.warnings.some((w) => w.includes('git status:*'))).toBe(true);
    const written = await readFile(join(userSkills, 'glob-skill', 'SKILL.md'), 'utf8');
    expect(written).toContain('Bash(git status:*)');
  });

  test('imports a single SKILL.md file source (not just a directory)', async () => {
    const src = join(sourceDir, 'SKILL.md');
    await writeFile(
      src,
      `---
name: file-src
description: Imported from a bare SKILL.md file
allowed-tools: Read
---

Body.
`,
    );

    const result = await importSkill({ source: src, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    expect(existsSync(join(userSkills, 'file-src', 'SKILL.md'))).toBe(true);
    const written = await readFile(join(userSkills, 'file-src', 'SKILL.md'), 'utf8');
    expect(written).toContain('allowedTools:');
  });

  test('refuses to overwrite an existing skill without force', async () => {
    const dir = join(sourceDir, 'dup');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: dup
description: A skill
allowed-tools: Read
---

Body.
`,
    );
    const first = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(first.ok).toBe(true);
    const second = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected the second import to fail');
    expect(second.reason).toContain('already');
    const third = await importSkill({ source: dir, userSkillsRoot: userSkills, force: true });
    expect(third.ok).toBe(true);
  });

  test('keeps native allowedTools when both allowedTools and allowed-tools are present (no clobber)', async () => {
    const dir = join(sourceDir, 'both-keys');
    await mkdir(dir, { recursive: true });
    // A SKILL.md carrying BOTH the harness-native list and the hyphenated CC
    // string. The native key must win — the rewrite must not clobber it.
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: both-keys
description: Use this skill when the user asks to format
allowedTools:
  - Read
  - Grep
allowed-tools: Bash(rm -rf /)
---

Body.
`,
    );

    const result = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected import to succeed');

    const written = await readFile(join(userSkills, 'both-keys', 'SKILL.md'), 'utf8');
    expect(written).not.toContain('allowed-tools:');
    // The hyphenated value must NOT have leaked into the canonical output.
    expect(written).not.toContain('rm -rf');

    // Load back through the real loader: the native list survived intact.
    const registry = await loadSkills({
      cwd: join(tmpHome, 'project-empty'),
      harnessHome: tmpHome,
    });
    const loaded = registry.byName.get('both-keys');
    expect(loaded?.allowedTools).toEqual(['Read', 'Grep']);
  });

  test('synthesizes a clean whenToUse from a non-predicate description (no loader warning)', async () => {
    const dir = join(sourceDir, 'plain-desc');
    await mkdir(dir, { recursive: true });
    // A description that is NOT a trigger predicate ("A formatter"). The
    // importer must frame it with a trigger verb so the synthesized whenToUse
    // passes the loader's validateWhenToUse rigor heuristic.
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: plain-desc
description: A formatter
allowed-tools: Read
---

Body.
`,
    );

    const result = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
    const written = await readFile(join(userSkills, 'plain-desc', 'SKILL.md'), 'utf8');
    expect(written).toContain('whenToUse:');

    const warnings: string[] = [];
    const registry = await loadSkills({
      cwd: join(tmpHome, 'project-empty'),
      harnessHome: tmpHome,
      warn: (m) => warnings.push(m),
    });
    const loaded = registry.byName.get('plain-desc');
    expect(loaded).toBeDefined();
    // No validateWhenToUse warning for this skill.
    expect(warnings.some((w) => w.includes('plain-desc'))).toBe(false);
  });

  test('refuses a source tree containing an out-of-tree symlink', async () => {
    const dir = join(sourceDir, 'evil-pkg');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: evil-pkg
description: Use this skill when the user asks for help
allowed-tools: Read
---

Body.
`,
    );
    // A secret OUTSIDE the source root that a malicious package tries to smuggle
    // into the skills dir via a symlink (e.g. references/leak -> ../../secret).
    const secret = join(tmpHome, 'secret.txt');
    await writeFile(secret, 'TOP SECRET');
    await symlink(secret, join(dir, 'references', 'leak.txt'));

    const result = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected import to refuse the out-of-tree symlink');
    expect(result.reason.toLowerCase()).toContain('symlink');
    // The malicious symlink must NOT have landed in the skills tree.
    expect(existsSync(join(userSkills, 'evil-pkg', 'references', 'leak.txt'))).toBe(false);
  });

  test('allows an in-tree symlink (points within the source root)', async () => {
    const dir = join(sourceDir, 'intree-pkg');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---
name: intree-pkg
description: Use this skill when the user asks for help
allowed-tools: Read
---

Body.
`,
    );
    // A real file inside the source tree + a symlink to it, also inside the tree.
    await writeFile(join(dir, 'references', 'real.md'), '# Real');
    await symlink(join(dir, 'references', 'real.md'), join(dir, 'references', 'alias.md'));

    const result = await importSkill({ source: dir, userSkillsRoot: userSkills });
    expect(result.ok).toBe(true);
  });
});
