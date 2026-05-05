// Phase 10.7 — argv-side parsing of the top-level `-p/--profile` flag.
// We test the pure scanner; the env-mutation side of main.ts is exercised
// separately by the e2e profile-subcommand tests.

import { describe, expect, test } from 'bun:test';
import { parseProfileFlag } from '../../src/cli/profileFlag.js';

const NODE = '/usr/local/bin/bun';
const SCRIPT = '/usr/local/bin/sov';

function argv(...rest: string[]): string[] {
  return [NODE, SCRIPT, ...rest];
}

describe('parseProfileFlag', () => {
  test('returns no flag when none is present', () => {
    const { flagValue, rest } = parseProfileFlag(argv('chat', '--no-preflight'));
    expect(flagValue).toBeUndefined();
    expect(rest).toEqual(argv('chat', '--no-preflight'));
  });

  test('parses `-p <name>` and strips both tokens', () => {
    const { flagValue, rest } = parseProfileFlag(argv('-p', 'work', 'chat', '--bundle', '/x'));
    expect(flagValue).toBe('work');
    expect(rest).toEqual(argv('chat', '--bundle', '/x'));
  });

  test('parses `--profile <name>` (separate value)', () => {
    const { flagValue, rest } = parseProfileFlag(argv('--profile', 'personal', 'chat'));
    expect(flagValue).toBe('personal');
    expect(rest).toEqual(argv('chat'));
  });

  test('parses `--profile=<name>` (joined value)', () => {
    const { flagValue, rest } = parseProfileFlag(argv('--profile=lab', 'chat'));
    expect(flagValue).toBe('lab');
    expect(rest).toEqual(argv('chat'));
  });

  test("accepts the reserved 'default' name without going through assertProfileName", () => {
    const { flagValue, rest } = parseProfileFlag(argv('-p', 'default', 'chat'));
    expect(flagValue).toBe('default');
    expect(rest).toEqual(argv('chat'));
  });

  test('stops scanning at the first subcommand token', () => {
    // -p AFTER `chat` is a chat-level flag, not a top-level profile flag —
    // leave it alone for commander to handle.
    const { flagValue, rest } = parseProfileFlag(argv('chat', '-p', 'work'));
    expect(flagValue).toBeUndefined();
    expect(rest).toEqual(argv('chat', '-p', 'work'));
  });

  test('rejects --profile with no value', () => {
    expect(() => parseProfileFlag(argv('--profile'))).toThrow(/profile name/);
  });

  test('rejects --profile= with empty value', () => {
    expect(() => parseProfileFlag(argv('--profile='))).toThrow(/profile name/);
  });

  test('rejects -p with empty next token', () => {
    expect(() => parseProfileFlag(argv('-p', ''))).toThrow(/profile name/);
  });

  test('rejects names that fail the profile-name regex', () => {
    expect(() => parseProfileFlag(argv('-p', 'has spaces', 'chat'))).toThrow(/invalid profile/);
    expect(() => parseProfileFlag(argv('--profile=.leading-dot', 'chat'))).toThrow(
      /invalid profile/,
    );
  });

  test('only the first profile flag wins; later occurrences are left for commander', () => {
    const { flagValue, rest } = parseProfileFlag(argv('-p', 'work', '--profile=other', 'chat'));
    expect(flagValue).toBe('work');
    // Second --profile=other is left untouched (it would now be a chat-level
    // unknown — commander will surface the error if any).
    expect(rest).toEqual(argv('--profile=other', 'chat'));
  });

  test('preserves unrelated top-level flags ahead of the subcommand', () => {
    const { flagValue, rest } = parseProfileFlag(argv('--version', 'chat'));
    expect(flagValue).toBeUndefined();
    expect(rest).toEqual(argv('--version', 'chat'));
  });
});
