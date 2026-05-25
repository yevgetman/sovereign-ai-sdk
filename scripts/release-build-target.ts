// scripts/release-build-target.ts — Phase 21 M2 single-target builder.
//
// Usage: bun scripts/release-build-target.ts <target> <version>
//
// Compiles sov (Bun) + sov-tui (Go) for <target>, copies bundle-default
// + LICENSE.txt + README + version into a staging dir, tars to
// build/release/<version>/sov-<target>.tar.gz.
//
// Required env:
//   SOV_RELEASES_PATH — path to a sov-releases checkout (for LICENSE.txt)

import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';
import {
  type Target,
  TARGETS,
  die,
  note,
  repoRoot,
  run,
} from './release-shared';

export function resolveTarget(name: string): Target | null {
  return TARGETS.find((t) => t.name === name) ?? null;
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

export function validateBuildInputs(opts: {
  target: string;
  version: string;
  publicRepoPath: string;
}): ValidateResult {
  if (resolveTarget(opts.target) === null) {
    return {
      ok: false,
      error: `unknown target "${opts.target}" — expected one of: ${TARGETS.map((t) => t.name).join(', ')}`,
    };
  }
  if (!/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(opts.version)) {
    return {
      ok: false,
      error: `bad version "${opts.version}" — expected vMAJOR.MINOR.PATCH (optionally -suffix)`,
    };
  }
  if (!opts.publicRepoPath || !existsSync(join(opts.publicRepoPath, 'LICENSE.txt'))) {
    return {
      ok: false,
      error:
        'SOV_RELEASES_PATH must point at a sov-releases checkout (LICENSE.txt not found there)',
    };
  }
  return { ok: true };
}

function buildOne(target: Target, version: string, publicRepoPath: string): string {
  const root = repoRoot();
  const releaseDir = join(root, 'build', 'release', version);
  const stageDir = join(releaseDir, target.name);
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, 'bin'), { recursive: true });

  note(`[${target.name}] bun build --compile...`);
  run('bun', [
    'build',
    '--compile',
    `--target=${target.bunTarget}`,
    `--outfile=${join(stageDir, 'bin', 'sov')}`,
    'src/main.ts',
  ]);

  note(`[${target.name}] go build sov-tui (${target.goos}/${target.goarch})...`);
  run(
    'go',
    ['build', '-o', join(stageDir, 'bin', 'sov-tui'), './cmd/sov-tui'],
    {
      cwd: join(root, 'packages', 'tui'),
      env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch },
    },
  );

  note(`[${target.name}] copying bundle-default/...`);
  cpSync(join(root, 'bundle-default'), join(stageDir, 'bundle-default'), { recursive: true });

  cpSync(join(publicRepoPath, 'LICENSE.txt'), join(stageDir, 'LICENSE.txt'));
  cpSync(join(root, 'README.binary.md'), join(stageDir, 'README.md'));
  writeFileSync(join(stageDir, 'version'), `${version}\n`);

  const tarball = join(releaseDir, `sov-${target.name}.tar.gz`);
  note(`[${target.name}] tarring → ${tarball}`);
  run('tar', ['-czf', tarball, '-C', stageDir, '.']);
  const size = statSync(tarball).size;
  note(`[${target.name}] tarball size: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return tarball;
}

// CLI entry: only runs when invoked directly, not when imported by tests.
if (import.meta.path === Bun.main) {
  const args = process.argv.slice(2);
  const targetName = args[0];
  const version = args[1];
  if (!targetName || !version) {
    die('usage: bun scripts/release-build-target.ts <target> <version>');
  }
  const publicRepoPath = process.env.SOV_RELEASES_PATH ?? '';
  const v = validateBuildInputs({ target: targetName, version, publicRepoPath });
  if (!v.ok) die(v.error);

  const target = resolveTarget(targetName);
  if (!target) die(`unknown target "${targetName}"`); // unreachable after validate

  buildOne(target, version, publicRepoPath);
  note(`[${target.name}] done`);
  exit(0);
}
