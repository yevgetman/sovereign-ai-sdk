// Tarball-contents assertion (spec §9.2): the packed npm artifact must ship
// ONLY compiled dist + LICENSE + README + package.json — never .ts source or
// any proprietary path. Guards the `files` allow-list.
import { beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

beforeAll(() => {
  // Ensure dist is present + current (dist/ is gitignored, so a fresh checkout has none).
  execFileSync('bun', ['run', 'build'], { cwd: pkgDir });
});

test('protocol tarball ships only dist + license + readme + package.json', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir }).toString();
  const paths: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);

  const allowed = /^(dist\/.*\.(js|d\.ts)|LICENSE|README\.md|package\.json)$/;
  const bad = paths.filter((p) => !allowed.test(p));
  expect(bad).toEqual([]);

  // ...and the compiled entry actually ships (not an empty tarball).
  expect(paths).toContain('dist/index.js');
  expect(paths).toContain('dist/index.d.ts');

  // Belt-and-suspenders: no TypeScript source, no src/ tree.
  expect(paths.some((p) => /\.ts$/.test(p) && !/\.d\.ts$/.test(p))).toBe(false);
  expect(paths.some((p) => p.startsWith('src/'))).toBe(false);
});
