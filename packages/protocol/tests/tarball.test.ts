// Tarball-contents assertion (spec §9.2, rebased in Phase 3): the packed npm
// artifact must ship ONLY compiled dist + the open src tree + LICENSE + README
// + package.json — never tests, configs, or any proprietary path.
//
// Why src/ ships (Phase 3, the dual-condition exports map): the `"bun"` export
// condition points at ./src/*.ts so Bun consumers (and the in-repo dev loop)
// run the TypeScript source directly with no build step, while `types`/`import`
// point Node consumers at compiled dist. An INSTALLED bun consumer resolves the
// bun condition inside the tarball, so the source tree must be in it — the
// consumer canary (scripts/canary/run-consumer-canary.ts) proves both runtimes.
// The whole package is MIT open-core by construction; shipping its source is
// intentional, and the allow-list below still guards against everything else.
import { beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

beforeAll(() => {
  // Ensure dist is present + current (dist/ is gitignored, so a fresh checkout has none).
  execFileSync('bun', ['run', 'build'], { cwd: pkgDir });
}, 60_000);

// Explicit 60s timeout: `npm pack` triggers `prepack` (a full tsc emit), so this
// test runs a real build — on a cold CI runner that can exceed bun test's 5s
// default (a spurious timeout, not a real failure).
test('protocol tarball ships only dist + src + license + readme + package.json', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir }).toString();
  const paths: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);

  const allowed = /^(dist\/.*\.(js|d\.ts)|src\/.*\.ts|LICENSE|README\.md|package\.json)$/;
  const bad = paths.filter((p) => !allowed.test(p));
  expect(bad).toEqual([]);

  // ...and both entry forms actually ship (not an empty tarball).
  expect(paths).toContain('dist/index.js');
  expect(paths).toContain('dist/index.d.ts');
  expect(paths).toContain('src/index.ts');

  // Belt-and-suspenders: no tests, no build config, nothing outside the pair
  // of shipped trees.
  expect(paths.some((p) => p.startsWith('tests/'))).toBe(false);
  expect(paths.some((p) => /tsconfig/.test(p))).toBe(false);
}, 60_000);
