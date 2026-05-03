// /theme slash command: inline form, unknown names, persistence to
// the config file. The picker UI itself (TTY-only) is not exercised
// here; that belongs in the live REPL walkthrough.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import { __resetForTests, getTheme } from '../../src/ui/theme.js';
import { makeCtx } from './_makeCtx.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

describe('/theme slash command', () => {
  let dir: string;
  let cfgPath: string;
  const prevEnv = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sov-theme-'));
    cfgPath = join(dir, 'config.json');
    process.env.HARNESS_CONFIG = cfgPath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevEnv;
    __resetForTests();
  });

  test('/theme <name> applies and persists to config', async () => {
    const result = await dispatchSlashCommand('/theme light', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('theme set to light');
    expect(getTheme().name).toBe('light');
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(onDisk.ui?.theme).toBe('light');
  });

  test('/theme rejects unknown names with available list', async () => {
    const result = await dispatchSlashCommand('/theme solarized', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('unknown theme: solarized');
    expect(result.output).toContain('dark');
    expect(result.output).toContain('light');
    expect(result.output).toContain('no-color');
    expect(getTheme().name).toBe('dark'); // unchanged
  });

  test('/theme without args under non-TTY lists themes and current', async () => {
    // bun:test runs without a TTY by default — picker fallback path.
    const result = await dispatchSlashCommand('/theme', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('current theme: dark');
    expect(result.output).toContain('available:');
    expect(result.output).toContain('light');
    expect(result.output).toContain('no-color');
    expect(result.output).toContain('requires a TTY');
  });

  test('/theme no-color round-trips through the config schema', async () => {
    await dispatchSlashCommand('/theme no-color', makeCtx());
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(onDisk.ui.theme).toBe('no-color');
    expect(getTheme().name).toBe('no-color');
  });
});
