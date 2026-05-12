import { describe, expect, test } from 'bun:test';
import {
  ABOUT_COMMAND,
  PERMISSIONS_COMMAND,
  SKILLS_COMMAND,
  TOOLS_COMMAND,
} from '../../src/commands/info.js';
import type { CommandContext } from '../../src/commands/types.js';
import type { Tool } from '../../src/tool/types.js';

function fakeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionId: 'sess-abc12345',
    cwd: '/tmp/work',
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    bundlePath: '/tmp/bundle',
    harnessHome: '/tmp/.harness',
    profileName: 'default',
    setModel: () => {},
    clearHistory: () => 'cleared',
    getCost: () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedUsd: 0,
    }),
    tools: [],
    skills: { skills: [], byTool: new Map() } as unknown as CommandContext['skills'],
    getPermissions: () => ({ mode: 'default', layers: [] }),
    registry: new Map(),
    requestExit: () => {},
    ...overrides,
  };
}

function fakeTool(name: string, description: string): Tool<unknown, unknown> {
  return {
    name,
    description,
    inputSchema: { type: 'object' },
    call: async () => ({ outputs: [{ type: 'text', text: 'ok' }] }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    userFacingName: () => name,
  } as unknown as Tool<unknown, unknown>;
}

describe('/about', () => {
  test('prints harness identity fields', async () => {
    const out = await ABOUT_COMMAND.call('', fakeCtx());
    expect(out).toContain('sovereign-ai-harness');
    expect(out).toContain('profile: default');
    expect(out).toContain('provider: anthropic');
    expect(out).toContain('model: claude-sonnet-4-6');
    expect(out).toContain('bundle: /tmp/bundle');
    expect(out).toContain('cwd: /tmp/work');
  });

  test('renders "no bundle" when bundlePath is null', async () => {
    const out = await ABOUT_COMMAND.call('', fakeCtx({ bundlePath: null }));
    expect(out).toContain('bundle: no bundle');
  });
});

describe('/tools', () => {
  test('lists each tool by name with description', async () => {
    const ctx = fakeCtx({
      tools: [fakeTool('Read', 'Read files'), fakeTool('Edit', 'Edit files')],
    });
    const out = await TOOLS_COMMAND.call('', ctx);
    expect(out).toContain('Read');
    expect(out).toContain('Read files');
    expect(out).toContain('Edit');
  });

  test('handles empty tool pool', async () => {
    const out = await TOOLS_COMMAND.call('', fakeCtx({ tools: [] }));
    expect(out).toContain('no tools');
  });
});

describe('/skills', () => {
  test('lists each skill by name with description', async () => {
    const skills = {
      skills: [
        { name: 'brainstorming', description: 'design dialogue', triggers: [], toolset: [] },
        { name: 'writing-plans', description: 'plan writer', triggers: [], toolset: [] },
      ],
      byTool: new Map(),
    } as unknown as CommandContext['skills'];
    const ctx = fakeCtx({ skills });
    const out = await SKILLS_COMMAND.call('', ctx);
    expect(out).toContain('brainstorming');
    expect(out).toContain('design dialogue');
    expect(out).toContain('writing-plans');
  });

  test('handles empty skill registry', async () => {
    const skills = { skills: [], byTool: new Map() } as unknown as CommandContext['skills'];
    const out = await SKILLS_COMMAND.call('', fakeCtx({ skills }));
    expect(out).toContain('no skills');
  });
});

describe('/permissions', () => {
  test('prints mode and "no layers" when empty', async () => {
    const ctx = fakeCtx({
      getPermissions: () => ({ mode: 'default', layers: [] }),
    });
    const out = await PERMISSIONS_COMMAND.call('', ctx);
    expect(out).toContain('mode: default');
    expect(out).toContain('no permission rule layers configured');
  });

  test('prints each layer with rule count', async () => {
    const ctx = fakeCtx({
      getPermissions: () => ({
        mode: 'ask',
        layers: [
          {
            source: 'user',
            path: '/home/user/.harness/settings.json',
            rules: [
              { tool: 'Bash', match: 'git status', behavior: 'allow' as const },
              { tool: 'Read', match: '*', behavior: 'allow' as const },
            ],
          } as unknown as ReturnType<typeof ctx.getPermissions>['layers'][number],
        ],
      }),
    });
    const out = await PERMISSIONS_COMMAND.call('', ctx);
    expect(out).toContain('mode: ask');
    expect(out).toContain('user');
    expect(out).toContain('2 rule');
  });
});
