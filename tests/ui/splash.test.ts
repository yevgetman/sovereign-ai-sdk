import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { renderSplash } from '../../src/ui/splash.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

describe('renderSplash', () => {
  const baseInfo = {
    providerLabel: 'anthropic',
    authLabel: 'API Key',
    model: 'claude-haiku-4-5-20251001',
    bundlePath: '/Users/test/code/example-bundle',
    permissionMode: 'default',
    toolCount: 12,
    cacheOn: true,
    sessionLabel: 'new abc12345',
    exitHint: '/quit or Ctrl-D to exit',
  };

  test('includes provider, model, and bundle path in the output', () => {
    const out = strip(renderSplash(baseInfo));
    expect(out).toContain('Sovereign AI');
    expect(out).toContain('anthropic');
    expect(out).toContain('claude-haiku-4-5-20251001');
    expect(out).toContain('/Users/test/code/example-bundle');
    expect(out).toContain('API Key');
  });

  test('includes the perms/tools/cache footer derived from info', () => {
    const out = strip(renderSplash({ ...baseInfo, permissionMode: 'bypass', cacheOn: false }));
    expect(out).toContain('perms: bypass');
    expect(out).toContain('tools: 12');
    expect(out).toContain('cache: off');
    expect(out).toContain('new abc12345');
  });

  test('renders a 6-row block-letter logo to the left of the card', () => {
    const lines = renderSplash(baseInfo).split('\n');
    // 6 logo rows plus card; just verify the logo lines contain block chars
    const blocky = lines.filter((l) => /[█╔╗╚╝║]/.test(strip(l)));
    expect(blocky.length).toBe(6);
  });
});
