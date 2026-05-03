// Pre-prompt footer renderer — segment composition, threshold colors,
// disabled state, no-TTY skip.

import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { ContextMeter } from '../../src/ui/contextMeter.js';
import { type FooterInfo, printPrePromptFooter, renderFooter } from '../../src/ui/footer.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

class StringSink {
  out = '';
  write(chunk: string): boolean {
    this.out += chunk;
    return true;
  }
}

function baseInfo(overrides: Partial<FooterInfo> = {}): FooterInfo {
  return {
    providerName: 'anthropic',
    model: 'claude-opus-4-7',
    bundleLabel: null,
    permissionMode: 'ask',
    toolCount: 14,
    costUsd: 0,
    ...overrides,
  };
}

describe('renderFooter', () => {
  test('shows provider, model, cost, perms, tools by default', () => {
    const out = strip(renderFooter(baseInfo()));
    expect(out).toContain('anthropic');
    expect(out).toContain('claude-opus-4-7');
    expect(out).toContain('perms:ask');
    expect(out).toContain('tools:14');
    expect(out).toContain('$0.00');
  });

  test('includes a context segment when a meter is provided', () => {
    const meter = new ContextMeter({ contextLength: 1000 });
    meter.update({ inputTokens: 250 });
    const out = strip(renderFooter(baseInfo({ meter })));
    expect(out).toContain('ctx 25%');
  });

  test('omits context segment when meter is absent', () => {
    const out = strip(renderFooter(baseInfo()));
    expect(out).not.toContain('ctx ');
  });

  test('shows bundle label when set', () => {
    const out = strip(renderFooter(baseInfo({ bundleLabel: 'sovereign-ai-docs' })));
    expect(out).toContain('bundle:sovereign-ai-docs');
  });

  test('formats small costs as <$0.01 and sub-dollar costs at three decimals', () => {
    expect(strip(renderFooter(baseInfo({ costUsd: 0.0005 })))).toContain('<$0.01');
    expect(strip(renderFooter(baseInfo({ costUsd: 0.123 })))).toContain('$0.123');
    expect(strip(renderFooter(baseInfo({ costUsd: 4.7 })))).toContain('$4.70');
  });

  test('returns empty string when disabled', () => {
    expect(renderFooter(baseInfo(), { enabled: false })).toBe('');
  });

  test('context segment is yellow at warn, red at danger', () => {
    const meter = new ContextMeter({
      contextLength: 1000,
      warnAtPercent: 60,
      dangerAtPercent: 80,
    });
    meter.update({ inputTokens: 700 });
    const warn = renderFooter(baseInfo({ meter }));
    // yellow → \x1b[33m
    expect(warn).toContain(`${ESC}[33m`);
    meter.update({ inputTokens: 900 });
    const danger = renderFooter(baseInfo({ meter }));
    // red → \x1b[31m
    expect(danger).toContain(`${ESC}[31m`);
  });
});

describe('printPrePromptFooter', () => {
  test('writes the rendered line + newline to the sink when TTY', () => {
    const sink = new StringSink();
    // Force TTY=true on stdout for this test (printPrePromptFooter checks
    // process.stdout.isTTY directly). Save and restore.
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      printPrePromptFooter(sink, baseInfo());
      expect(strip(sink.out)).toContain('anthropic');
      expect(sink.out.endsWith('\n')).toBe(true);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  test('no-op when disabled', () => {
    const sink = new StringSink();
    printPrePromptFooter(sink, baseInfo(), { enabled: false });
    expect(sink.out).toBe('');
  });

  test('no-op when not a TTY', () => {
    const sink = new StringSink();
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      printPrePromptFooter(sink, baseInfo());
      expect(sink.out).toBe('');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });
});
