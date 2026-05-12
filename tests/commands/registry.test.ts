import { describe, expect, test } from 'bun:test';
import {
  HELP_COMMAND,
  buildCommandRegistry,
  dispatchSlashCommand,
  formatHelp,
  parseSlashCommand,
} from '../../src/commands/registry.js';
import type { CommandContext, SlashCommand } from '../../src/commands/types.js';

describe('parseSlashCommand', () => {
  test('returns null for non-slash input', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('  hello /world')).toBeNull();
  });

  test('parses bare slash as empty name', () => {
    expect(parseSlashCommand('/')).toEqual({ name: '', args: '' });
  });

  test('parses single-word command', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: '' });
  });

  test('parses command with single arg', () => {
    expect(parseSlashCommand('/model claude-opus')).toEqual({
      name: 'model',
      args: 'claude-opus',
    });
  });

  test('parses command with multi-word args (collapses leading whitespace only)', () => {
    expect(parseSlashCommand('/config set foo.bar baz')).toEqual({
      name: 'config',
      args: 'set foo.bar baz',
    });
  });

  test('trims surrounding whitespace', () => {
    expect(parseSlashCommand('   /help   ')).toEqual({ name: 'help', args: '' });
  });
});

function fakeCommand(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    type: 'local',
    name: 'fake',
    description: 'fake command',
    call: async () => 'fake output',
    ...overrides,
  };
}

function fakeCtx(registry: ReturnType<typeof buildCommandRegistry>): CommandContext {
  return {
    sessionId: 's1',
    cwd: '/tmp',
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    bundlePath: null,
    harnessHome: '/tmp/harness',
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
    registry,
    requestExit: () => {},
  };
}

describe('buildCommandRegistry', () => {
  test('registers names and aliases without overwriting earlier entries', () => {
    const a = fakeCommand({ name: 'help', aliases: ['h', '?'] });
    const b = fakeCommand({ name: 'h' }); // collides with alias
    const registry = buildCommandRegistry([a, b]);
    expect(registry.get('help')).toBe(a);
    expect(registry.get('h')).toBe(a); // earlier wins
    expect(registry.get('?')).toBe(a);
  });
});

describe('dispatchSlashCommand', () => {
  test('returns unknown for non-slash input', async () => {
    const registry = buildCommandRegistry([fakeCommand()]);
    const result = await dispatchSlashCommand('hello', fakeCtx(registry));
    expect(result.kind).toBe('unknown');
  });

  test('returns unknown with help hint for unregistered command', async () => {
    const registry = buildCommandRegistry([fakeCommand()]);
    const result = await dispatchSlashCommand('/nope', fakeCtx(registry));
    expect(result.kind).toBe('unknown');
    expect(result.output).toContain('unknown command: /nope');
    expect(result.output).toContain('type /help');
  });

  test('calls the registered handler', async () => {
    const command = fakeCommand({
      name: 'echo',
      call: async (args) => `echo: ${args}`,
    });
    const registry = buildCommandRegistry([command]);
    const result = await dispatchSlashCommand('/echo hello world', fakeCtx(registry));
    expect(result).toEqual({ kind: 'local', output: 'echo: hello world' });
  });
});

describe('/help', () => {
  test('formatHelp lists every command name with description', () => {
    const cmd1: SlashCommand = {
      type: 'local',
      name: 'one',
      description: 'first cmd',
      call: async () => '',
    };
    const cmd2: SlashCommand = {
      type: 'local',
      name: 'two',
      description: 'second cmd',
      aliases: ['t'],
      call: async () => '',
    };
    const registry = buildCommandRegistry([cmd1, cmd2]);
    const out = formatHelp(registry);
    expect(out).toContain('/one');
    expect(out).toContain('first cmd');
    expect(out).toContain('/two');
    expect(out).toContain('second cmd');
    expect(out).toContain('(t)'); // alias hint
  });

  test('HELP_COMMAND.call returns formatHelp output', async () => {
    const ctx = fakeCtx(buildCommandRegistry([HELP_COMMAND]));
    const out = await HELP_COMMAND.call('', ctx);
    expect(out).toContain('/help');
  });
});
