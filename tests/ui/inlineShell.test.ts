// Unit tests use stdio: 'pipe' so they don't take over the test runner's
// terminal. The 'inherit' code path is exercised in the REPL itself.

import { describe, expect, test } from 'bun:test';
import { isInlineShellInput, runInlineShell, stripPrefix } from '../../src/ui/inlineShell.js';

describe('isInlineShellInput', () => {
  test('matches a leading bang', () => {
    expect(isInlineShellInput('!ls')).toBe(true);
    expect(isInlineShellInput('! ls')).toBe(true);
    expect(isInlineShellInput('!')).toBe(true);
  });

  test('does not match a slash command', () => {
    expect(isInlineShellInput('/help')).toBe(false);
  });

  test('does not match a regular prompt', () => {
    expect(isInlineShellInput('what is 2+2?')).toBe(false);
    expect(isInlineShellInput('hello!')).toBe(false);
  });
});

describe('stripPrefix', () => {
  test('removes the leading bang and whitespace', () => {
    expect(stripPrefix('!ls')).toBe('ls');
    expect(stripPrefix('! ls -la')).toBe('ls -la');
    expect(stripPrefix('!   ls   ')).toBe('ls');
  });

  test('returns empty string for bare bang', () => {
    expect(stripPrefix('!')).toBe('');
    expect(stripPrefix('!   ')).toBe('');
  });

  test('handles leading whitespace before the bang', () => {
    expect(stripPrefix('  !ls')).toBe('ls');
  });
});

describe('runInlineShell', () => {
  test('returns empty:true when no command follows the bang', async () => {
    const result = await runInlineShell('!', { stdio: 'pipe' });
    expect(result).toEqual({ exitCode: 0, empty: true });
  });

  test('returns empty:true when only whitespace follows', async () => {
    const result = await runInlineShell('!   ', { stdio: 'pipe' });
    expect(result.empty).toBe(true);
  });

  test('runs a simple command and returns exit code 0', async () => {
    const result = await runInlineShell('!true', { stdio: 'pipe' });
    expect(result).toEqual({ exitCode: 0, empty: false });
  });

  test('returns non-zero exit code from failing command', async () => {
    const result = await runInlineShell('!exit 7', { stdio: 'pipe' });
    expect(result).toEqual({ exitCode: 7, empty: false });
  });

  test('runs in the supplied cwd', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'inline-shell-cwd-'));
    const expected = resolve(dir);
    try {
      const out = join(dir, 'pwd.out');
      const result = await runInlineShell(`!pwd > ${out}`, {
        stdio: 'pipe',
        cwd: dir,
      });
      expect(result.exitCode).toBe(0);
      // Resolve both sides via realpath to dodge macOS's /tmp → /private/tmp.
      const recorded = (await Bun.file(out).text()).trim();
      const { realpathSync } = await import('node:fs');
      expect(realpathSync(recorded)).toBe(realpathSync(expected));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
