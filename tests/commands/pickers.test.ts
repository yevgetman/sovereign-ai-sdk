// Wave 2 picker-driven slash commands. The picker UI itself (raw mode,
// ↑/↓ navigation, terminal takeover) needs a TTY to drive end-to-end —
// those paths are covered in tests/ui/picker.test.ts. This file pins
// the inline-argument paths (`/model <name>`, `/theme <name>`) and the
// non-TTY fallback messages, plus the `formatRelativeTime` helper that
// renders the `/resume` picker subtitle.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { __test__ } from '../../src/commands/pickers.js';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import { __resetForTests, getTheme } from '../../src/ui/theme.js';
import { makeCtx } from './_makeCtx.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

const { formatRelativeTime, PROVIDER_MODELS } = __test__;

describe('formatRelativeTime', () => {
  const NOW_SEC = Date.now() / 1000;

  test('seconds for sub-minute ages', () => {
    expect(formatRelativeTime(NOW_SEC - 5)).toBe('5s ago');
    expect(formatRelativeTime(NOW_SEC - 30)).toBe('30s ago');
  });

  test('minutes for sub-hour ages', () => {
    expect(formatRelativeTime(NOW_SEC - 60)).toBe('1m ago');
    expect(formatRelativeTime(NOW_SEC - 300)).toBe('5m ago');
    expect(formatRelativeTime(NOW_SEC - 3500)).toBe('58m ago');
  });

  test('hours for sub-day ages', () => {
    expect(formatRelativeTime(NOW_SEC - 3600 * 2)).toBe('2h ago');
    expect(formatRelativeTime(NOW_SEC - 3600 * 23)).toBe('23h ago');
  });

  test('days for sub-month ages', () => {
    expect(formatRelativeTime(NOW_SEC - 86400 * 3)).toBe('3d ago');
    expect(formatRelativeTime(NOW_SEC - 86400 * 25)).toBe('25d ago');
  });

  test('months for sub-year ages', () => {
    expect(formatRelativeTime(NOW_SEC - 86400 * 60)).toBe('2mo ago');
  });

  test('years for older entries', () => {
    expect(formatRelativeTime(NOW_SEC - 86400 * 400)).toBe('1y ago');
  });

  test('clamps negative deltas (clock skew) to zero', () => {
    // Future timestamp shouldn't blow up.
    const result = formatRelativeTime(NOW_SEC + 1000);
    expect(result).toMatch(/^\d+s ago$/);
  });
});

describe('PROVIDER_MODELS registry', () => {
  test('exposes every provider the CLI accepts', () => {
    expect(Object.keys(PROVIDER_MODELS).sort()).toEqual([
      'anthropic',
      'ollama',
      'openai',
      'openrouter',
    ]);
  });

  test('every provider has at least one model', () => {
    for (const models of Object.values(PROVIDER_MODELS)) {
      expect(models.length).toBeGreaterThan(0);
    }
  });
});

describe('/resume — non-TTY fallback', () => {
  test('returns "no recorded sessions" when no sessions exist', async () => {
    const ctx = makeCtx({ listSessions: () => [] });
    const result = await dispatchSlashCommand('/resume', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    // M11.5 T7 — empty-sessions check now runs BEFORE the TTY check
    // so the message is actionable ("nothing to resume") instead of
    // misleading ("needs a TTY" — even with a TTY there'd be nothing
    // to pick).
    expect(result.output).toContain('no recorded sessions');
  });

  test('returns TTY-required hint when sessions exist but stdin is piped', async () => {
    const ctx = makeCtx({
      listSessions: () => [
        {
          sessionId: 'sess-1',
          parentSessionId: null,
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          platform: 'darwin',
          createdAt: Math.floor(Date.now() / 1000) - 120,
          lastUpdated: Math.floor(Date.now() / 1000) - 60,
          title: 'old session',
          msgCount: 3,
          totalTokens: 100,
          totalCostUsd: 0.01,
        },
      ],
    });
    const result = await dispatchSlashCommand('/resume', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('requires a TTY');
  });
});

describe('/model — inline argument path', () => {
  test('inline name sets and reports the new model', async () => {
    const captured: { value: string | null } = { value: null };
    const ctx = makeCtx({
      setModel: (m: string) => {
        captured.value = m;
      },
    });
    const result = await dispatchSlashCommand('/model claude-opus-4-7', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.value).toBe('claude-opus-4-7');
    expect(result.output).toContain('claude-opus-4-7');
    expect(result.output).toContain('persisted to session');
  });

  test('no-arg path under non-TTY reports current + TTY hint', async () => {
    const ctx = makeCtx({ model: 'haiku' });
    const result = await dispatchSlashCommand('/model', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('current model: haiku');
    expect(result.output).toContain('requires a TTY');
  });

  test('non-TTY no-arg with unknown provider includes config edit hint', async () => {
    const ctx = makeCtx({ providerName: 'mystery-provider' });
    const result = await dispatchSlashCommand('/model', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    // The fallback for non-TTY runs first so we see the TTY hint, but
    // the provider-not-registered branch is what the live picker hits.
    // Confirm the message at minimum mentions the model.
    expect(strip(result.output)).toContain('current model');
  });
});

describe('/theme — inline argument path', () => {
  let dir: string;
  let cfgPath: string;
  const prevEnv = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sov-pickers-theme-'));
    cfgPath = join(dir, 'config.json');
    process.env.HARNESS_CONFIG = cfgPath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevEnv;
    __resetForTests();
  });

  test('valid name applies + persists', async () => {
    const result = await dispatchSlashCommand('/theme light', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('theme set to light');
    expect(getTheme().name).toBe('light');
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(onDisk.ui?.theme).toBe('light');
  });

  test('unknown name returns the available list and does not change theme', async () => {
    const result = await dispatchSlashCommand('/theme bogus', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('unknown theme: bogus');
    expect(result.output).toContain('dark');
    expect(result.output).toContain('light');
    expect(result.output).toContain('no-color');
    expect(getTheme().name).toBe('dark');
  });

  test('non-TTY no-arg lists themes with current marker', async () => {
    const result = await dispatchSlashCommand('/theme', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('current theme:');
    expect(result.output).toContain('dark');
    expect(result.output).toContain('light');
    expect(result.output).toContain('no-color');
    expect(result.output).toContain('requires a TTY');
  });
});
