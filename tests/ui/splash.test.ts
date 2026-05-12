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

  test('shows a placeholder line when no bundle is loaded', () => {
    const out = strip(renderSplash({ ...baseInfo, bundlePath: null }));
    expect(out).toContain('no bundle');
    expect(out).not.toContain('/Users/test/code/example-bundle');
  });

  describe('width-aware layout', () => {
    test('uses side-by-side layout at wide terminals (120 cols)', () => {
      const out = strip(renderSplash(baseInfo, 120));
      const lines = out.split('\n');
      // At least one line contains both a logo glyph and the card title.
      const sideBySide = lines.filter((l) => /[█╔]/.test(l) && l.includes('Sovereign AI'));
      expect(sideBySide.length).toBeGreaterThan(0);
    });

    test('regression: stacks at typical 80-col terminals where side-by-side would overflow', () => {
      // Prior heuristic ("budget >= 30") let side-by-side render at
      // cols >= 69, but at 75-80 cols the row width logo + gutter +
      // card was right at the terminal edge, and any font that renders
      // box-drawing characters wider than 1 cell pushed the row past
      // the wrap point — fragmenting the ASCII logo. Now: measure the
      // built card, decide based on whether the row fits (with safety
      // margin) inside cols.
      //
      // Tips/footer lines are intentionally not bounded by cols — they
      // wrap if the terminal is narrow enough. The regression is the
      // LOGO + CARD row overflowing, so we check those specifically.
      for (const cols of [72, 75, 78, 80]) {
        const out = strip(renderSplash(baseInfo, cols));
        const lines = out.split('\n');
        // At these widths the row would have been right at the edge —
        // we want stacked, NOT a logo+card row.
        const overlapping = lines.filter((l) => /[█╔]/.test(l) && l.includes('Sovereign AI'));
        expect(overlapping.length, `cols=${cols} should stack, not side-by-side`).toBe(0);
        // Lines containing logo or card-box characters must fit within
        // the terminal — those are the rows whose mid-row wrap caused
        // the visible "broken splash" regression.
        for (const line of lines) {
          const stripped = strip(line);
          const isLogoOrCard = /[█╔╗╚╝║╭╮╰╯─]/.test(stripped);
          if (!isLogoOrCard) continue;
          expect(
            stripped.length,
            `cols=${cols}: logo/card line "${stripped.slice(0, 40)}…" of length ${stripped.length} exceeds cols`,
          ).toBeLessThanOrEqual(cols);
        }
      }
    });

    test('stacks logo above card at narrow terminals (50 cols)', () => {
      const out = strip(renderSplash(baseInfo, 50));
      const lines = out.split('\n');
      const logoIdx = lines.findIndex((l) => /[█╔]/.test(l));
      const cardIdx = lines.findIndex((l) => l.includes('Sovereign AI'));
      expect(logoIdx).toBeGreaterThan(-1);
      expect(cardIdx).toBeGreaterThan(logoIdx);
      // Logo and card never share a row in stacked mode.
      const overlapping = lines.filter((l) => /[█╔]/.test(l) && l.includes('Sovereign AI'));
      expect(overlapping.length).toBe(0);
    });

    test('drops the logo entirely when the terminal is narrower than the logo (25 cols)', () => {
      const out = strip(renderSplash(baseInfo, 25));
      expect(out).not.toMatch(/[█╔╗╚╝]/);
      expect(out).toContain('Sovereign AI');
      expect(out).toContain('anthropic');
    });

    test('abbreviates a long bundle path with a leading ellipsis', () => {
      const longPath = '/Users/test/code/some/deeply/nested/very/long/bundle/path/here';
      const out = strip(renderSplash({ ...baseInfo, bundlePath: longPath }, 90));
      expect(out).toContain('…/');
      expect(out).toContain('here');
      expect(out).not.toContain('/Users/test/code/some/deeply');
    });

    test('keeps a short bundle path verbatim', () => {
      const out = strip(renderSplash({ ...baseInfo, bundlePath: '/short' }, 120));
      expect(out).toContain('/short');
      expect(out).not.toContain('…/');
    });

    test('preserves tips and footer in every layout', () => {
      for (const cols of [120, 50, 25]) {
        const out = strip(renderSplash(baseInfo, cols));
        expect(out).toContain('Tips:');
        expect(out).toContain('perms:');
        expect(out).toContain('tools:');
      }
    });
  });
});
