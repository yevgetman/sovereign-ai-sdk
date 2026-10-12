import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateSkill, createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import { BashTool } from '@yevgetman/sov-sdk/tools/BashTool';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function activate(body: string, args: string, sessionId = 'literal-output') {
  const cwd = mkdtempSync(join(tmpdir(), 'activation-literal-output-'));
  directories.push(cwd);
  const skill: Skill = {
    name: 'literal',
    description: 'Literal activation output fixture',
    whenToUse: '',
    allowedTools: ['Bash'],
    path: join(cwd, 'SKILL.md'),
    realpath: join(cwd, 'SKILL.md'),
    dir: cwd,
    source: 'project',
    trustTier: 'trusted',
    allowShellInterpolation: true,
    metadata: {
      harness: {
        requiresToolsets: [],
        requiresTools: [],
        fallbackForToolsets: [],
        fallbackForTools: [],
      },
    },
    guard: { action: 'allow', findings: [] },
    body,
  };
  return activateSkill(skill, {
    source: 'user',
    args,
    toolContext: { cwd, sessionId },
    state: createSkillActivationState({
      tools: [BashTool],
      canUseTool: async () => ({ behavior: 'allow' }),
    }),
    resolveSkill: async (current) => current,
    allowedResourceRoots: [],
  });
}

test('approved stdout with argument markers stays literal beside authored prose arguments', async () => {
  const body = "!`printf '\\173\\173args\\175\\175'`\nRequest: {{args}}";
  const result = await activate(body, 'replacement');
  expect(result.prompt).toBe('{{args}}\nRequest: replacement');
});

test('approved stdout cannot replace the fallback argument suffix', async () => {
  const result = await activate("!`printf '\\173\\173args\\175\\175'`", 'replacement');
  expect(result.prompt).toBe('{{args}}\n\nUser arguments: replacement');
});

test('an argument marker inside an author command is literal command data', async () => {
  const result = await activate("!`printf '{{args}}'`", 'replacement');
  expect(result.prompt).toBe('{{args}}\n\nUser arguments: replacement');
});

test('environment prose values with argument markers remain literal data', async () => {
  const result = await activate(
    '${HARNESS_SESSION_ID}\nRequest: {{args}}',
    'replacement',
    'session-{{args}}',
  );
  expect(result.prompt).toBe('session-{{args}}\nRequest: replacement');
});
