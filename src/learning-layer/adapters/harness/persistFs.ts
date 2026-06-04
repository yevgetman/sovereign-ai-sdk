// src/learning-layer/adapters/harness/persistFs.ts
// Adapter #1 Persist port — maps named-blob keys to files under $HARNESS_HOME.
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PersistPort } from '../../ports.js';

export function createFsPersist(harnessHome: string): PersistPort {
  const pathFor = (key: string): string => join(harnessHome, key);
  const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  return {
    async read(key) {
      try {
        return await readFile(pathFor(key), 'utf8');
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async write(key, value) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, value, 'utf8');
    },
    async list(prefix) {
      try {
        const entries = await readdir(pathFor(prefix), { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => join(prefix, e.name));
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
    },
    async remove(key) {
      try {
        await unlink(pathFor(key));
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    },
  };
}
