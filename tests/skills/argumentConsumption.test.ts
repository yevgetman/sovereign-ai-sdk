import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandSkillText, loadSkillFromPath } from '@yevgetman/sov-sdk/skills/loader';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';

let root: string;
let skill: Skill;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sov-argument-consumption-'));
  const path = join(root, 'review.md');
  await writeFile(path, '---\nname: review\ndescription: Review changes\n---\nReview changes.\n');
  const loaded = await loadSkillFromPath(path, { source: 'project', trustTier: 'trusted' });
  if (!loaded) throw new Error('fixture skill did not load');
  skill = loaded;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

for (const command of [
  "awk '{print $1}' checked.txt",
  "printf '%s' '$ARGUMENTS'",
  "printf '%s' '{{args}}'",
]) {
  test(`shell ${command} does not consume the caller's prose arguments`, async () => {
    const commands: string[] = [];
    const args = 'target.ts !`touch NEVER_RUN`';
    const result = await expandSkillText(skill, `Review the target. Context: !\`${command}\``, {
      cwd: root,
      args,
      runShellCommand: async (command) => {
        commands.push(command);
        return 'REPORT_READY';
      },
    });
    expect(commands).toEqual([command]);
    expect(result).toBe(`Review the target. Context: REPORT_READY\n\nUser arguments: ${args}`);
  });
}

test('a longer shell variable name is not a supported argument placeholder', async () => {
  const result = await expandSkillText(skill, 'Review $ARGUMENTS_EXTRA.', {
    cwd: root,
    args: 'target.ts',
  });
  expect(result).toBe('Review $ARGUMENTS_EXTRA.\n\nUser arguments: target.ts');
});

test('actual prose positional templates suppress the fallback only when expanded', async () => {
  const result = await expandSkillText(skill, 'Review $ARGUMENTS[0]. Context: !`echo $1`', {
    cwd: root,
    args: 'target.ts',
    runShellCommand: async () => '$ARGUMENTS[0]',
  });
  expect(result).toBe('Review target.ts. Context: $ARGUMENTS[0]');
});

test('shell removal cannot join separate prose regions into an argument template', async () => {
  const result = await expandSkillText(skill, '$ARG!`echo checked`UMENTS', {
    cwd: root,
    args: 'target.ts',
    runShellCommand: async () => '',
  });
  expect(result).toBe('$ARGUMENTS\n\nUser arguments: target.ts');
});
