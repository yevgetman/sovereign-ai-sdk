import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillCommands } from '@yevgetman/sov-sdk/skills/commands';
import {
  assertSkillInvocable,
  normalizeSkillDescriptor,
  parseSkillToolList,
  substituteSkillArguments,
} from '@yevgetman/sov-sdk/skills/descriptor';
import { normalizeImportedFrontmatter } from '@yevgetman/sov-sdk/skills/install';
import {
  SkillFrontmatterSchema,
  expandSkillPrompt,
  loadSkills,
} from '@yevgetman/sov-sdk/skills/loader';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { SkillsListTool } from '@yevgetman/sov-sdk/tools/SkillsListTool';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('portable skill descriptors', () => {
  test('portable requests do not silently become restrictions or host approvals', () => {
    const raw = {
      name: 'review',
      description: 'Review code',
      'allowed-tools': 'Read Grep, Bash(git log --format:%h,%an)',
      allowedTools: ['Edit'],
      vendor: { future: true },
    };
    const direct = normalizeSkillDescriptor(raw);
    const imported = normalizeSkillDescriptor(normalizeImportedFrontmatter(raw).frontmatter);
    expect(imported.toolPolicy).toEqual(direct.toolPolicy);
    expect(direct.toolPolicy.restrictedTools).toEqual(['Edit']);
    expect(direct.toolPolicy.preapprovedTools).toEqual([
      'Read',
      'Grep',
      'Bash(git log --format:%h,%an)',
    ]);
    expect(imported.frontmatter.vendor).toEqual({ future: true });
  });

  test('portable arguments remain data and quoted positional values stay together', () => {
    const args = '"two words" safe `!touch NEVER`';
    expect(substituteSkillArguments('$ARGUMENTS[0] | $1 | {{args}} | $ARGUMENTS', args)).toBe(
      `two words | safe | ${args} | ${args}`,
    );
    expect(substituteSkillArguments('$9', args)).toBe('');
  });

  test('writer schema rejects malformed policy flags before commit', () => {
    const base = { name: 'safe', description: 'Safe instructions' };
    expect(SkillFrontmatterSchema.safeParse({ ...base, 'user-invocable': 'false' }).success).toBe(
      false,
    );
    expect(SkillFrontmatterSchema.safeParse({ ...base, 'allowed-tools': [42] }).success).toBe(
      false,
    );
  });

  test('unsupported execution controls refuse activation with actionable diagnostics', () => {
    for (const control of [
      { context: 'fork' },
      { hooks: {} },
      { model: 'future-model' },
      { 'permission-mode': 'bypass' },
    ]) {
      const descriptor = normalizeSkillDescriptor(control);
      expect(descriptor.execution.supported).toBe(false);
      expect(descriptor.execution.diagnostics.some((entry) => entry.severity === 'error')).toBe(
        true,
      );
    }
    expect(
      normalizeSkillDescriptor({ model: 'inherit', context: 'inline' }).execution.supported,
    ).toBe(true);
    expect(() => normalizeSkillDescriptor({ 'user-invocable': 'false' })).toThrow('boolean');
    expect(() => parseSkillToolList([17])).toThrow('strings');
  });

  test('loaded model/manual controls drive command and model catalogs and deny activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-controls-'));
    roots.push(root);
    const dir = join(root, '.harness', 'skills');
    await mkdir(dir, { recursive: true });
    for (const [name, controls] of [
      ['manual', 'disable-model-invocation: true'],
      ['automatic', 'user-invocable: false'],
      ['forked', 'context: fork'],
      ['ordinary', ''],
    ] as const) {
      await writeFile(
        join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: Use when reviewing code\nwhenToUse: User asks for code review\n${controls}\nmetadata:\n  arbitrary-vendor:\n    future-field: value\n---\nInstructions.\n`,
      );
    }
    const warnings: string[] = [];
    const registry = await loadSkills({
      cwd: root,
      harnessHome: join(root, 'isolated-home'),
      warn: (message) => warnings.push(message),
    });
    expect(buildSkillCommands(registry).map((command) => command.name)).toEqual([
      'manual',
      'ordinary',
    ]);
    const listed = await SkillsListTool.call({}, { cwd: root, skills: registry } as ToolContext);
    expect(listed.data.skills.map((entry) => entry.name)).toEqual(['automatic', 'ordinary']);
    const manual = registry.byName.get('manual');
    const automatic = registry.byName.get('automatic');
    const forked = registry.byName.get('forked');
    if (!manual || !automatic || !forked) throw new Error('fixtures failed to load');
    expect(() => assertSkillInvocable(manual, 'model')).toThrow('model');
    expect(() => assertSkillInvocable(automatic, 'command')).toThrow('user');
    expect(() => assertSkillInvocable(forked, 'user')).toThrow('Fork isolation');
    const adapted = await expandSkillPrompt(
      {
        ...manual,
        body: '$ARGUMENTS[0] ${CLAUDE_SKILL_DIR} ${SKILL_DIR} ${CLAUDE_SESSION_ID}',
        allowShellInterpolation: false,
      },
      { cwd: root, args: '"two words"', sessionId: 'example-session' },
    );
    expect(adapted).toBe(`two words ${manual.dir} ${manual.dir} example-session`);
    expect(manual.metadata['arbitrary-vendor']).toEqual({ 'future-field': 'value' });
    expect(manual.descriptor?.frontmatter.metadata).toHaveProperty('arbitrary-vendor');
    expect(warnings.some((message) => message.includes('Fork isolation'))).toBe(true);
  });
});
