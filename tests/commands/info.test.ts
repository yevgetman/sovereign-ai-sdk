// /about, /tools, /skills, /stats, /permissions, /quit, /copy formatters.
// Drive each via dispatchSlashCommand against the shared makeCtx so we
// also exercise the registry wiring (alias resolution, dispatch flow).

import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '@yevgetman/sov-sdk/commands/types';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import chalk from 'chalk';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
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

  // Round-7 [HIGH] — the /tools render helper resolved each tool's description
  // synchronously and, on a Promise return, dropped it WITHOUT a `.catch()`.
  // A third-party tool whose async description rejects on the sentinel input
  // left an unhandled promise rejection that terminates the process (exit 1 on
  // Node ≥15 AND bun). /tools must render without crashing, degrading the entry
  // to the tool name (never leaking the rejection).
  test('does not crash on a tool whose async description rejects', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const badTool = {
        name: 'boomtool',
        description: async (): Promise<string> => {
          throw new Error('async description boom');
        },
      } as unknown as CommandContext['tools'][number];
      const ctx = makeCtx({ tools: [badTool] });
      const result = await dispatchSlashCommand('/tools', ctx);
      if (result.kind !== 'local') throw new Error('expected local');
      // Let any dropped rejection surface on the macrotask queue.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
      // The tool still lists (degraded to its name), never crashing.
      expect(strip(result.output)).toContain('boomtool');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
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

describe('/expand', () => {
  test('default arg expands the most recent block (n=1)', async () => {
    const calls: number[] = [];
    const ctx = makeCtx({
      expandToolBlock: (n) => {
        calls.push(n);
        return { ok: true, total: 3 };
      },
    });
    const result = await dispatchSlashCommand('/expand', ctx);
    expect(calls).toEqual([1]);
    if (result.kind !== 'local') throw new Error('expected local');
    // The slot writes the expanded content to stdout directly; the
    // command's output is empty so the dispatch layer doesn't append
    // a redundant trailer.
    expect(result.output).toBe('');
  });

  test('numeric arg routes to that index', async () => {
    const calls: number[] = [];
    const ctx = makeCtx({
      expandToolBlock: (n) => {
        calls.push(n);
        return { ok: true, total: 5 };
      },
    });
    await dispatchSlashCommand('/expand 3', ctx);
    expect(calls).toEqual([3]);
  });

  test('returns helpful error when N is out of range', async () => {
    const ctx = makeCtx({
      expandToolBlock: () => ({ ok: false, total: 2 }),
    });
    const result = await dispatchSlashCommand('/expand 5', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('out of range');
    expect(result.output).toContain('5');
    expect(result.output).toContain('this session has 2');
  });

  test('returns helpful message when no blocks have completed', async () => {
    const ctx = makeCtx({
      expandToolBlock: () => ({ ok: false, total: 0 }),
    });
    const result = await dispatchSlashCommand('/expand', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('no tool blocks completed');
  });

  test('rejects non-positive N with usage hint', async () => {
    let called = false;
    const ctx = makeCtx({
      expandToolBlock: () => {
        called = true;
        return { ok: true, total: 1 };
      },
    });
    const result = await dispatchSlashCommand('/expand 0', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('usage:');
    expect(called).toBe(false);
  });

  test('rejects non-numeric N with usage hint', async () => {
    const result = await dispatchSlashCommand('/expand abc', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('usage:');
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

describe('/context-budget', () => {
  test('renders the budget report passed in via getBudgetReport', async () => {
    const ctx = makeCtx({
      getBudgetReport: () => ({
        components: [
          {
            kind: 'tool-schema',
            name: 'Bash',
            tokens: 280,
            bloat: null,
            classification: 'always',
          },
          {
            kind: 'skill',
            name: 'react-patterns',
            tokens: 950,
            bloat: 'extreme',
            classification: 'sometimes',
            path: '/tmp/react-patterns.md',
          },
        ],
        totals: { estimated: 1230, window: 200_000, utilization: 0.00615 },
      }),
    });
    const result = await dispatchSlashCommand('/context-budget', ctx);
    expect(result.kind).toBe('local');
    if (result.kind !== 'local') return;
    const text = strip(result.output);
    expect(text).toContain('total estimate');
    expect(text).toContain('Bash');
    expect(text).toContain('react-patterns');
    expect(text).toContain('extreme');
    expect(text).toContain('sometimes');
  });
});
