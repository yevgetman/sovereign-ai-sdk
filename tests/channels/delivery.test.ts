import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send } from '../../src/channels/delivery.js';

describe('send', () => {
  const toClean: string[] = [];
  afterEach(() => {
    for (const d of toClean) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    toClean.length = 0;
  });

  function tmpHome(): string {
    const d = mkdtempSync(join(tmpdir(), 'sov-delivery-'));
    toClean.push(d);
    return d;
  }

  test('local target writes content to outbox/local/', async () => {
    const home = tmpHome();
    const result = await send('local', 'hello world', home);
    expect(result.ok).toBe(true);
    const files = readdirSync(join(home, 'outbox', 'local'));
    expect(files.length).toBe(1);
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error('expected one file in outbox');
    const content = readFileSync(join(home, 'outbox', 'local', firstFile), 'utf8');
    expect(content).toBe('hello world');
  });

  test('writes to outbox/local for free-form local delivery', async () => {
    const home = tmpHome();
    const res = await send('local', 'hello', home);
    expect(res.ok).toBe(true);
    const files = readdirSync(join(home, 'outbox', 'local'));
    expect(files.length).toBe(1);
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error('expected one file in outbox');
    expect(readFileSync(join(home, 'outbox', 'local', firstFile), 'utf8')).toBe('hello');
  });

  test('writes to cron-outbox when cronJobId provided', async () => {
    const home = tmpHome();
    const res = await send('local', 'hello', home, { cronJobId: 'job-abc' });
    expect(res.ok).toBe(true);
    const files = readdirSync(join(home, 'cron', 'outbox', 'job-abc'));
    expect(files.length).toBe(1);
  });

  test('returns silent:true and skips write when [SILENT] prefix present', async () => {
    const home = tmpHome();
    const res = await send('local', '[SILENT] hello', home);
    expect(res.ok).toBe(true);
    expect(res.silent).toBe(true);
    // No file written.
    expect(existsSync(join(home, 'outbox', 'local'))).toBe(false);
  });

  test('case-insensitive prefix match', async () => {
    const home = tmpHome();
    const res = await send('local', '[silent] hello', home);
    expect(res.silent).toBe(true);
  });

  test('trims leading whitespace before checking', async () => {
    const home = tmpHome();
    const res = await send('local', '  [SILENT] hello', home);
    expect(res.silent).toBe(true);
  });

  test('unknown target returns error result', async () => {
    const result = await send('telegram', 'hello', '/tmp');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown delivery target');
  });

  test('outbox writes leave no .tmp residue on success', async () => {
    // Atomic temp+rename pattern: writes go to <path>.<pid>.<ts>.tmp then
    // renameSync to the final .txt path. After a successful write only the
    // .txt should exist — no .tmp sibling.
    const home = tmpHome();
    await send('local', 'hello', home);
    const files = readdirSync(join(home, 'outbox', 'local'));
    expect(files.length).toBe(1);
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error('expected one file in outbox');
    expect(firstFile.endsWith('.txt')).toBe(true);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
