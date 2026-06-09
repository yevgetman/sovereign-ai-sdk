// Plugin-skill security tests (T5 / S2 — the security crux). A plugin skill's
// body must NEVER trigger inline-shell interpolation (`` `!cmd` `` / `` !`cmd` ``),
// because that runs OUTSIDE the permission layer (C2). Variable substitution
// ({{args}}, ${HARNESS_SKILL_DIR}, ${HARNESS_SESSION_ID}) still happens — only
// the shell-command expansion is disabled, and only for `source:'plugin'` skills.
//
// Defense in depth: even a mis-constructed plugin Skill with
// allowShellInterpolation:true must NOT run shell (the source==='plugin' guard).

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expandSkillPrompt } from '../../src/skills/loader.js';
import type { Skill, SkillSource } from '../../src/skills/types.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-plugin-shell-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  const path = overrides.path ?? '/tmp/sample.md';
  const source: SkillSource = overrides.source ?? 'project';
  const dir = overrides.dir ?? dirname(path);
  // The skill dir is the cwd `Bun.spawn` chdir's into for inline-shell. It must
  // exist or the spawn fails with ENOENT (masking whether the gate, not the
  // environment, suppressed the command).
  mkdirSync(dir, { recursive: true });
  return {
    name: 'sample',
    description: 'Sample skill',
    whenToUse: 'User asks for the sample',
    allowedTools: [],
    path,
    realpath: path,
    dir,
    source,
    trustTier: 'trusted',
    metadata: {
      harness: {
        requiresToolsets: [],
        requiresTools: [],
        fallbackForToolsets: [],
        fallbackForTools: [],
      },
    },
    guard: { action: 'allow', findings: [] },
    // Honest default: non-plugin skills allow shell, plugin skills do not —
    // mirrors the loadSkillFile chokepoint. An explicit override wins (used by
    // the defense-in-depth test to deliberately mis-construct a plugin skill).
    allowShellInterpolation: source !== 'plugin',
    body: 'Sample {{args}}.',
    ...overrides,
  };
}

describe('plugin-skill inline-shell disable (C2)', () => {
  test('a plugin skill does NOT run inline shell — the literal stays inert', async () => {
    await withTmp(async (dir) => {
      const skill = makeSkill({
        source: 'plugin',
        path: join(dir, 'plugin/sample.md'),
        dir: join(dir, 'plugin'),
        body: 'OUT=`!echo PWNED`',
      });

      const expanded = await expandSkillPrompt(skill, { cwd: dir });

      // The shell did NOT run: the raw literal survives un-expanded and the
      // command output ("PWNED") was never substituted in.
      expect(expanded).toContain('`!echo PWNED`');
      expect(expanded).not.toContain('OUT=PWNED');
    });
  });

  test('a plugin skill does NOT run an inline shell with an observable side effect', async () => {
    await withTmp(async (dir) => {
      const marker = join(dir, 'pwned-marker');
      const skill = makeSkill({
        source: 'plugin',
        path: join(dir, 'plugin/touch.md'),
        dir: join(dir, 'plugin'),
        // Both syntaxes; neither must execute.
        body: `A=\`!touch ${marker}\` B=!\`touch ${marker}\``,
      });

      await expandSkillPrompt(skill, { cwd: dir });

      // The side-effecting command never ran — the marker file does not exist.
      expect(existsSync(marker)).toBe(false);
    });
  });

  test('variable substitution STILL works for plugin skills (only shell is disabled)', async () => {
    await withTmp(async (dir) => {
      const skillDir = join(dir, 'plugin');
      const skill = makeSkill({
        source: 'plugin',
        path: join(skillDir, 'vars.md'),
        dir: skillDir,
        body: 'Args={{args}} DIR=${HARNESS_SKILL_DIR} SESSION=${HARNESS_SESSION_ID} SH=`!echo NOPE`',
      });

      const expanded = await expandSkillPrompt(skill, {
        args: 'topic',
        cwd: dir,
        sessionId: 'sess-1',
      });

      expect(expanded).toContain('Args=topic');
      expect(expanded).toContain(`DIR=${skillDir}`);
      expect(expanded).toContain('SESSION=sess-1');
      // Shell stays inert even alongside the variables.
      expect(expanded).toContain('SH=`!echo NOPE`');
      expect(expanded).not.toContain('SH=NOPE');
    });
  });

  test('defense in depth: a mis-constructed plugin Skill (allowShellInterpolation:true) still does NOT run shell', async () => {
    await withTmp(async (dir) => {
      const skill = makeSkill({
        source: 'plugin',
        allowShellInterpolation: true, // deliberately wrong — the source guard must still win
        path: join(dir, 'plugin/evil.md'),
        dir: join(dir, 'plugin'),
        body: 'OUT=`!echo PWNED`',
      });

      const expanded = await expandSkillPrompt(skill, { cwd: dir });

      expect(expanded).toContain('`!echo PWNED`');
      expect(expanded).not.toContain('OUT=PWNED');
    });
  });
});

describe('non-plugin inline-shell unchanged (contrast)', () => {
  test('a project skill STILL runs inline shell (change is scoped to plugin skills)', async () => {
    await withTmp(async (dir) => {
      const skill = makeSkill({
        source: 'project',
        path: join(dir, 'proj/hello.md'),
        dir: join(dir, 'proj'),
        body: 'OUT=`!echo HELLO`',
      });

      const expanded = await expandSkillPrompt(skill, { cwd: dir });

      expect(expanded).toContain('OUT=HELLO');
      expect(expanded).not.toContain('`!echo HELLO`');
    });
  });
});
