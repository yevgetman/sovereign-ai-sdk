// Theme registry, setTheme/getTheme/resolveThemeName, no-color identity,
// reset between cases.

import { afterEach, describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import {
  __resetForTests,
  getTheme,
  isThemeName,
  listThemes,
  resolveThemeName,
  setTheme,
  theme,
} from '../../src/ui/theme.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

afterEach(() => __resetForTests());

describe('theme registry', () => {
  test('listThemes returns the three built-in themes', () => {
    const names = listThemes().map((t) => t.name);
    expect(names).toContain('dark');
    expect(names).toContain('light');
    expect(names).toContain('no-color');
  });

  test('isThemeName recognises built-ins and rejects unknowns', () => {
    expect(isThemeName('dark')).toBe(true);
    expect(isThemeName('no-color')).toBe(true);
    expect(isThemeName('solarized')).toBe(false);
  });

  test('default theme is dark', () => {
    expect(getTheme().name).toBe('dark');
  });
});

describe('setTheme', () => {
  test('switches the active theme and is reflected via getTheme()', () => {
    setTheme('light');
    expect(getTheme().name).toBe('light');
    expect(theme.name).toBe('light');
  });

  test('throws on unknown theme name', () => {
    expect(() => setTheme('nonsense')).toThrow(/unknown theme/);
  });

  test('renderers using `theme.tokens` see the new theme on next call', () => {
    const before = theme.tokens.accent('hello');
    expect(strip(before)).toBe('hello');
    expect(before).not.toBe('hello'); // colored under dark

    setTheme('no-color');
    const after = theme.tokens.accent('hello');
    expect(after).toBe('hello'); // identity under no-color
  });
});

describe('no-color theme', () => {
  test('every token is the identity function (no ANSI)', () => {
    setTheme('no-color');
    const t = theme.tokens;
    const samples = [
      t.text('a'),
      t.textMuted('b'),
      t.textBold('c'),
      t.accent('d'),
      t.statusSuccess('e'),
      t.statusError('f'),
      t.diffAdded('g'),
      t.diffRemoved('h'),
      t.codeInline('i'),
      t.codeFence('j'),
      t.headerH1('k'),
    ];
    for (const s of samples) {
      expect(s).not.toContain(ESC);
    }
    expect(samples.join('')).toBe('abcdefghijk');
  });
});

describe('resolveThemeName', () => {
  test('returns the configured theme when valid', () => {
    expect(resolveThemeName({ configured: 'light', env: {} })).toBe('light');
  });

  test('falls back to dark when configured value is unknown or omitted', () => {
    expect(resolveThemeName({ configured: 'mystery', env: {} })).toBe('dark');
    expect(resolveThemeName({ env: {} })).toBe('dark');
  });

  test('NO_COLOR overrides configured value', () => {
    expect(resolveThemeName({ configured: 'light', env: { NO_COLOR: '1' } })).toBe('no-color');
    expect(resolveThemeName({ env: { NO_COLOR: '1' } })).toBe('no-color');
  });

  test('empty NO_COLOR is ignored (per the spec)', () => {
    expect(resolveThemeName({ configured: 'light', env: { NO_COLOR: '' } })).toBe('light');
  });
});

describe('theme tokens behavior under dark', () => {
  test('accent and statusSuccess produce ANSI escape sequences', () => {
    const t = theme.tokens;
    expect(t.accent('x')).toContain(ESC);
    expect(t.statusSuccess('y')).toContain(ESC);
  });

  test('diff tokens visually differentiate added vs removed', () => {
    const t = theme.tokens;
    const added = t.diffAdded('+ foo');
    const removed = t.diffRemoved('- bar');
    expect(strip(added)).toBe('+ foo');
    expect(strip(removed)).toBe('- bar');
    expect(added).not.toBe(removed);
  });
});
