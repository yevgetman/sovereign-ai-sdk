// tests/learning-layer/persistFs.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';

const home = mkdtempSync(join(tmpdir(), 'persist-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('createFsPersist', () => {
  test('write then read round-trips and creates parent dirs', async () => {
    const p = createFsPersist(home);
    await p.write('learning/proj/instincts/a.md', 'hello');
    expect(await p.read('learning/proj/instincts/a.md')).toBe('hello');
  });
  test('read of a missing key returns null', async () => {
    expect(await createFsPersist(home).read('nope/missing.md')).toBeNull();
  });
  test('list returns file keys under a prefix; missing prefix -> []', async () => {
    const p = createFsPersist(home);
    await p.write('learning/proj/instincts/b.md', 'x');
    const keys = await p.list('learning/proj/instincts');
    expect(keys).toContain('learning/proj/instincts/a.md');
    expect(keys).toContain('learning/proj/instincts/b.md');
    expect(await p.list('learning/empty')).toEqual([]);
  });
  test('remove is idempotent', async () => {
    const p = createFsPersist(home);
    await p.write('learning/proj/instincts/c.md', 'x');
    await p.remove('learning/proj/instincts/c.md');
    await p.remove('learning/proj/instincts/c.md'); // no throw
    expect(await p.read('learning/proj/instincts/c.md')).toBeNull();
  });
});
