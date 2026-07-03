// Tarball-contents assertion (spec §9.2) for the SDK core package: the packed
// npm artifact must ship ONLY compiled dist + the open src tree + LICENSE +
// README + package.json — never tests, configs, or any proprietary path.
//
// Why src/ ships (the dual-condition exports map): the `"bun"` export
// condition points at ./src/*.ts so Bun consumers (and the in-repo dev loop)
// run the TypeScript source directly with no build step, while `types`/`import`
// point Node consumers at compiled dist. An INSTALLED bun consumer resolves the
// bun condition inside the tarball, so the source tree must be in it — the
// consumer canary (scripts/canary/run-consumer-canary.ts) proves both runtimes.
// The whole package is MIT open-core by construction; shipping its source is
// intentional. The SDK tarball is large (~150 modules × dist js/d.ts + src ts),
// so the allow-list REGEX is the guard here — not a file count.
import { beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

beforeAll(() => {
  // Ensure dist is present + current (dist/ is gitignored, so a fresh checkout has none).
  execFileSync('bun', ['run', 'build'], { cwd: pkgDir });
}, 60_000);

// Explicit 60s timeout: `npm pack` triggers the package's `prepack`
// (`rm -rf dist && bun run build` — a full tsc emit), so this test runs a real
// build. On a cold CI runner that exceeds bun test's 5s default, which is a
// spurious timeout (not a real failure). 60s is ample headroom.
test('sdk tarball ships only dist + src + license + readme + security + package.json', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir }).toString();
  const paths: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);

  // In-tree markdown docs inside the OPEN src tree (e.g. src/bundle/README.md)
  // are categorically documentation and ship with the source they document.
  // SECURITY.md rides along at the root so npm renders the disclosure policy on
  // the package page (added 2026-07-02 polish pass).
  const allowed =
    /^(dist\/.*\.(js|d\.ts)|src\/.*\.ts|src\/(.*\/)?README\.md|LICENSE|README\.md|SECURITY\.md|package\.json)$/;
  const bad = paths.filter((p) => !allowed.test(p));
  expect(bad).toEqual([]);

  // The disclosure policy actually ships.
  expect(paths).toContain('SECURITY.md');

  // ...and all three entry forms of the dual-condition exports map actually
  // ship (types + import → dist, bun → src).
  expect(paths).toContain('dist/sdk.js');
  expect(paths).toContain('dist/sdk.d.ts');
  expect(paths).toContain('src/sdk.ts');

  // Belt-and-suspenders: no tests, no build config, nothing outside the pair
  // of shipped trees.
  expect(paths.some((p) => p.startsWith('tests/'))).toBe(false);
  expect(paths.some((p) => /tsconfig/.test(p))).toBe(false);
}, 60_000);
