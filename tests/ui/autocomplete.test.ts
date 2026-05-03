// Pure completion tests — input + cursor → suggestions. The
// inputEditor's apply / cycle behavior is covered separately.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { complete } from '../../src/ui/autocomplete.js';

const COMMANDS = ['help', 'config', 'clear', 'compact', 'cost', 'commit', 'cancel-something'];

describe('autocomplete.complete — slash commands', () => {
  test('empty slash → all commands sorted', () => {
    const r = complete({ text: '/', cursor: 1, cwd: '.', commandNames: COMMANDS });
    expect(r.kind).toBe('slash');
    expect(r.suggestions[0]).toBe('/cancel-something');
    expect(r.suggestions).toContain('/help');
  });

  test('prefix narrows the list', () => {
    const r = complete({ text: '/co', cursor: 3, cwd: '.', commandNames: COMMANDS });
    expect(r.suggestions).toEqual(
      ['cancel-something', 'commit', 'compact', 'config', 'cost']
        .sort()
        .filter((n) => n.startsWith('co'))
        .map((n) => `/${n}`),
    );
  });

  test('prefix is case-insensitive', () => {
    const r = complete({ text: '/HE', cursor: 3, cwd: '.', commandNames: COMMANDS });
    expect(r.suggestions).toContain('/help');
  });

  test('replaceFrom marks the start of the slash token', () => {
    const r = complete({ text: 'hi /he', cursor: 6, cwd: '.', commandNames: COMMANDS });
    expect(r.replaceFrom).toBe(3);
    expect(r.prefix).toBe('/he');
  });

  test('mid-line text without slash → no completion', () => {
    const r = complete({ text: 'plain text', cursor: 10, cwd: '.', commandNames: COMMANDS });
    expect(r.kind).toBe('none');
    expect(r.suggestions).toEqual([]);
  });
});

describe('autocomplete.complete — @file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sov-autocomplete-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'src', 'ui'));
    writeFileSync(join(dir, 'src', 'main.ts'), '');
    writeFileSync(join(dir, 'src', 'ui', 'theme.ts'), '');
    writeFileSync(join(dir, 'README.md'), '');
    writeFileSync(join(dir, '.hidden'), '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('@<empty> lists cwd entries with directories first', () => {
    const r = complete({ text: '@', cursor: 1, cwd: dir, commandNames: [] });
    expect(r.kind).toBe('file');
    // src/ first (dir), then README.md (file)
    expect(r.suggestions[0]).toBe('@src/');
    expect(r.suggestions).toContain('@README.md');
  });

  test('hides dotfiles', () => {
    const r = complete({ text: '@', cursor: 1, cwd: dir, commandNames: [] });
    expect(r.suggestions).not.toContain('@.hidden');
  });

  test('@src/ lists subdirectory entries', () => {
    const r = complete({ text: '@src/', cursor: 5, cwd: dir, commandNames: [] });
    expect(r.suggestions).toContain('@src/main.ts');
    expect(r.suggestions).toContain('@src/ui/');
  });

  test('@src/ma narrows by leaf prefix', () => {
    const r = complete({ text: '@src/ma', cursor: 7, cwd: dir, commandNames: [] });
    expect(r.suggestions).toEqual(['@src/main.ts']);
  });

  test('@nonsense yields empty list, not error', () => {
    const r = complete({ text: '@/totally/missing/', cursor: 18, cwd: dir, commandNames: [] });
    expect(r.kind).toBe('file');
    expect(r.suggestions).toEqual([]);
  });

  test('replaceFrom marks the start of the @ token', () => {
    const r = complete({ text: 'see @src', cursor: 8, cwd: dir, commandNames: [] });
    expect(r.replaceFrom).toBe(4);
    expect(r.prefix).toBe('@src');
  });
});
