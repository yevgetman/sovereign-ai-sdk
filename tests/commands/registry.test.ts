import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-command-registry-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
      return 'conversation history cleared into child session session-2';
    },
    getCost: () => ({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      estimatedCostUsd: 0.0123,
      compactionInputTokens: 0,
      compactionOutputTokens: 0,
      estimatedCompactionCostUsd: 0,
    }),
    compact: async () => ({
      parentSessionId: 'session-1',
      newSessionId: 'session-2',
      summary: 'summary',
      tail: [],
      compactedMessages: 3,
      estimatedBeforeTokens: 1200,
      estimatedAfterTokens: 300,
      usedAuxiliary: false,
    }),
    rollback: async () => 'rolled back to parent session session-1',
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
    expect(result.output).toContain('child session');
  });

  test('/cost formats token and dollar totals', async () => {
    const result = await dispatchSlashCommand('/cost', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local command result');
    expect(result.output).toContain('total=100');
    expect(result.output).toContain('$0.01');
  });

  test('/compact and /rollback delegate to session callbacks', async () => {
    const compact = await dispatchSlashCommand('/compact', makeCtx());
    if (compact.kind !== 'local') throw new Error('expected local command result');
    expect(compact.output).toContain('session-1 -> session-2');
    expect(compact.output).toContain('aux=fallback');

    const rollback = await dispatchSlashCommand('/rollback', makeCtx());
    if (rollback.kind !== 'local') throw new Error('expected local command result');
    expect(rollback.output).toContain('rolled back');
  });

  test('/commit is a prompt command with git-only Bash scope', async () => {
    const result = await dispatchSlashCommand('/commit include tests', makeCtx());
    expect(result.kind).toBe('prompt');
    if (result.kind !== 'prompt') return;
    expect(result.command.allowedTools).toContain('Bash(git status)');
    expect(result.command.allowedTools).toContain('Bash(git commit **)');
    expect(result.content[0]?.type).toBe('text');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain(process.cwd());
    expect(text).toContain('Do not use cd');
    expect(text).toContain('Use only direct git status, git diff, git add, and git commit');
    expect(text).toContain('include tests');
  });

  test('loaded skills register as prompt commands', async () => {
    await withTmp(async (dir) => {
      const skillPath = join(dir, 'simplify.md');
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(
        skillPath,
        `---
name: simplify
description: Review code for reuse and quality
allowedTools: [Read, Edit]
whenToUse: User asks to simplify code
---
Simplify {{args}}.
`,
      );
      const skill: Skill = {
        name: 'simplify',
        description: 'Review code for reuse and quality',
        whenToUse: 'User asks to simplify code',
        allowedTools: ['Read', 'Edit'],
        path: skillPath,
        realpath: skillPath,
        dir: dirname(skillPath),
        source: 'project',
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
        body: 'Simplify {{args}}.',
      };
      const skills: SkillRegistry = {
        skills: [skill],
        byName: new Map([[skill.name, skill]]),
      };
      const registry = buildCommandRegistry([...COMMANDS, ...buildSkillCommands(skills)]);
      const ctx = { ...makeCtx(), cwd: dir, registry };
      const result = await dispatchSlashCommand('/simplify src/main.ts', ctx);
      expect(result.kind).toBe('prompt');
      if (result.kind !== 'prompt') return;
      expect(result.command.allowedTools).toEqual(['Read', 'Edit']);
      expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain(
        'src/main.ts',
      );
    });
  });
});
