import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { boxify, visibleWidth } from '../../src/ui/box.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

describe('visibleWidth', () => {
  test('counts visible characters, ignoring ANSI escapes', () => {
    expect(visibleWidth('hello')).toBe(5);
    expect(visibleWidth(chalk.red('hello'))).toBe(5);
    expect(visibleWidth(`${chalk.bold('a')}${chalk.dim('bc')}`)).toBe(3);
    expect(visibleWidth('')).toBe(0);
  });
});

describe('boxify', () => {
  test('produces a bordered block with consistent right-edge alignment', () => {
    const lines = boxify(['short', 'a longer line', 'x']);
    const stripped = lines.map(strip);
    // top, content × 3, bottom
    expect(stripped).toHaveLength(5);
    const top = stripped[0] ?? '';
    const bottom = stripped[stripped.length - 1] ?? '';
    const widths = stripped.map((l) => l.length);
    // every row is the same total visible width
    expect(new Set(widths).size).toBe(1);
    expect(top.startsWith('╭') && top.endsWith('╮')).toBe(true);
    expect(bottom.startsWith('╰')).toBe(true);
    expect(bottom.endsWith('╯')).toBe(true);
  });

  test('aligns rows correctly when content has ANSI styling of varying lengths', () => {
    const lines = boxify([chalk.bold('one'), chalk.cyan('twothreefour')]);
    const widths = lines.map((l) => strip(l).length);
    expect(new Set(widths).size).toBe(1);
  });

  test('respects custom padding', () => {
    const tight = boxify(['x'], { padding: 0 });
    const loose = boxify(['x'], { padding: 4 });
    expect(strip(tight[0] ?? '').length).toBeLessThan(strip(loose[0] ?? '').length);
  });
});
