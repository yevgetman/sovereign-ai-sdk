import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

  test('unknown target returns error result', async () => {
    const result = await send('telegram', 'hello', '/tmp');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown delivery target');
  });
});
