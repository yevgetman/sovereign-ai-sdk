// /about, /tools, /skills, /stats, /permissions, /quit, /copy formatters.
// Drive each via dispatchSlashCommand against the shared makeCtx so we
// also exercise the registry wiring (alias resolution, dispatch flow).

import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import type { Skill } from '../../src/skills/types.js';
import { makeCtx } from './_makeCtx.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

const fakeSkill = (name: string, description: string): Skill => ({
  name,
  description,
  whenToUse: '',
  allowedTools: [],
  path: `/tmp/${name}.md`,
  realpath: `/tmp/${name}.md`,
  dir: '/tmp',
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
  body: '',
});

describe('/about', () => {
  test('prints version, provider, model, cwd, bundle, session', async () => {
    const ctx = makeCtx({ providerName: 'anthropic', model: 'haiku', bundlePath: '/bundle' });
    const result = await dispatchSlashCommand('/about', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    const text = strip(result.output);
    expect(text).toContain('Sovereign AI');
    expect(text).toContain('anthropic');
    expect(text).toContain('haiku');
    expect(text).toContain('/bundle');
  });

  test('shows generic-agent label when bundlePath is null', async () => {
    const result = await dispatchSlashCommand('/about', makeCtx({ bundlePath: null }));
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('no bundle (generic-agent mode)');
  });
});

describe('/tools', () => {
  test('reports zero tools when none registered', async () => {
    const result = await dispatchSlashCommand('/tools', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('no tools registered');
  });
});

describe('/skills', () => {
  test('reports zero skills when registry empty', async () => {
    const result = await dispatchSlashCommand('/skills', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('no skills loaded');
  });

  test('lists registered skills with source tag', async () => {
    const skill = fakeSkill('simplify', 'Simplify code');
    const ctx = makeCtx({
      skills: { skills: [skill], byName: new Map([[skill.name, skill]]) },
    });
    const result = await dispatchSlashCommand('/skills', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    const text = strip(result.output);
    expect(text).toContain('skills (1)');
    expect(text).toContain('simplify');
    expect(text).toContain('[project]');
    expect(text).toContain('Simplify code');
  });
});

describe('/stats', () => {
  test('renders the same shape as the goodbye summary card', async () => {
    const result = await dispatchSlashCommand('/stats', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    const text = strip(result.output);
    expect(text).toContain('Interaction Summary');
    expect(text).toContain('Tool Calls');
  });
});

describe('/permissions', () => {
  test('shows mode and a hint when no rules loaded', async () => {
    const ctx = makeCtx({
      getPermissions: () => ({ mode: 'ask', alwaysAllow: [], layers: [] }),
    });
    const result = await dispatchSlashCommand('/permissions', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    const text = strip(result.output);
    expect(text).toContain('mode:');
    expect(text).toContain('ask');
    expect(text).toContain('no persistent allow/deny rules');
  });

  test('lists session always-allow rules when present', async () => {
    const ctx = makeCtx({
      getPermissions: () => ({
        mode: 'ask',
        alwaysAllow: ['Bash(git status)', 'Read(src/**)'],
        layers: [],
      }),
    });
    const result = await dispatchSlashCommand('/permissions', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    const text = strip(result.output);
    expect(text).toContain('session always-allow (2)');
    expect(text).toContain('Bash(git status)');
    expect(text).toContain('Read(src/**)');
  });
});

describe('/quit', () => {
  test('calls requestExit and returns goodbye', async () => {
    let exited = false;
    const ctx = makeCtx({
      requestExit: () => {
        exited = true;
      },
    });
    const result = await dispatchSlashCommand('/quit', ctx);
    expect(exited).toBe(true);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('goodbye');
  });

  test('aliases /exit and /q route to the same handler', async () => {
    let exited = 0;
    const ctx = makeCtx({
      requestExit: () => {
        exited++;
      },
    });
    await dispatchSlashCommand('/exit', ctx);
    await dispatchSlashCommand('/q', ctx);
    expect(exited).toBe(2);
  });
});

describe('/copy', () => {
  test('reports nothing to copy when no assistant text', async () => {
    const result = await dispatchSlashCommand('/copy', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('no assistant text');
  });

  test('copies assistant text or surfaces a fallback message', async () => {
    const ctx = makeCtx({
      getLastAssistantText: () => 'hello from the agent',
    });
    const result = await dispatchSlashCommand('/copy', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    // Tools may not be installed in CI — accept either success or
    // fallback path. Both are acceptable; we only assert the command
    // produced reasonable output without throwing.
    const text = strip(result.output);
    expect(text.includes('copied') || text.includes('clipboard tool not available')).toBe(true);
  });
});
