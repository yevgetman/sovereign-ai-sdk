import { describe, expect, test } from 'bun:test';
import {
  COMMANDS,
  COMMAND_REGISTRY,
  buildCommandRegistry,
  dispatchSlashCommand,
  parseSlashCommand,
} from '../../src/commands/registry.js';
import type { CommandContext } from '../../src/commands/types.js';
import { buildSkillCommands } from '../../src/skills/commands.js';
import type { Skill, SkillRegistry } from '../../src/skills/types.js';

function makeCtx(): CommandContext {
  let model = 'claude-sonnet-4-6';
  let cleared = false;
  return {
    sessionId: 'session-1',
    cwd: process.cwd(),
    providerName: 'anthropic',
    get model() {
      return model;
    },
    setModel: (next) => {
      model = next;
    },
    clearHistory: () => {
      cleared = true;
    },
    getCost: () => ({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      estimatedCostUsd: 0.0123,
    }),
    tools: [],
    registry: COMMAND_REGISTRY,
    get cleared() {
      return cleared;
    },
  } as CommandContext & { cleared: boolean };
}

describe('slash command registry', () => {
  test('parseSlashCommand splits command name and args', () => {
    expect(parseSlashCommand('/model claude-opus-4-7')).toEqual({
      name: 'model',
      args: 'claude-opus-4-7',
    });
    expect(parseSlashCommand('hello')).toBeNull();
  });

  test('/help lists registered commands', async () => {
    const result = await dispatchSlashCommand('/help', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local command result');
    expect(result.output).toContain('/commit');
    expect(result.output).toContain('/cost');
  });

  test('/model switches model and reports current model without args', async () => {
    const ctx = makeCtx();
    const set = await dispatchSlashCommand('/model claude-opus-4-7', ctx);
    if (set.kind !== 'local') throw new Error('expected local command result');
    expect(set.output).toContain('claude-opus-4-7');

    const current = await dispatchSlashCommand('/model', ctx);
    if (current.kind !== 'local') throw new Error('expected local command result');
    expect(current.output).toContain('claude-opus-4-7');
  });

  test('/clear clears history via context callback', async () => {
    const ctx = makeCtx() as CommandContext & { cleared: boolean };
    const result = await dispatchSlashCommand('/clear', ctx);
    if (result.kind !== 'local') throw new Error('expected local command result');
    expect(ctx.cleared).toBe(true);
  });

  test('/cost formats token and dollar totals', async () => {
    const result = await dispatchSlashCommand('/cost', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local command result');
    expect(result.output).toContain('total=100');
    expect(result.output).toContain('$0.01');
  });

  test('/commit is a prompt command with git-only Bash scope', async () => {
    const result = await dispatchSlashCommand('/commit include tests', makeCtx());
    expect(result.kind).toBe('prompt');
    if (result.kind !== 'prompt') return;
    expect(result.command.allowedTools).toContain('Bash(git status)');
    expect(result.command.allowedTools).toContain('Bash(git commit **)');
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain(
      'include tests',
    );
  });

  test('loaded skills register as prompt commands', async () => {
    const skill: Skill = {
      name: 'simplify',
      description: 'Review code for reuse and quality',
      whenToUse: 'User asks to simplify code',
      allowedTools: ['Read', 'Edit'],
      path: '/tmp/simplify.md',
      realpath: '/tmp/simplify.md',
      source: 'project',
      body: 'Simplify {{args}}.',
    };
    const skills: SkillRegistry = {
      skills: [skill],
      byName: new Map([[skill.name, skill]]),
    };
    const registry = buildCommandRegistry([...COMMANDS, ...buildSkillCommands(skills)]);
    const ctx = { ...makeCtx(), registry };
    const result = await dispatchSlashCommand('/simplify src/main.ts', ctx);
    expect(result.kind).toBe('prompt');
    if (result.kind !== 'prompt') return;
    expect(result.command.allowedTools).toEqual(['Read', 'Edit']);
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain(
      'src/main.ts',
    );
  });
});
