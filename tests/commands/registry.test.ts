import { describe, expect, test } from 'bun:test';
import { parseSlashCommand } from '../../src/commands/registry.js';

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
