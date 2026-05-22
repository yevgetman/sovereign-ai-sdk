// scripts/release.ts — Phase 21 M1 manual release pipeline.
//
// Invoked as: bun run release v0.2.0 [--dry-run]
//
// Builds per-platform tarballs and uploads them to the public
// sov-releases repo via `gh release create`. Pre-flight enforces a
// clean git tree, master branch, green pre-commit gate, gh auth, Bun
// + Go versions. --dry-run produces all artifacts under
// build/release/<tag>/ but skips git-tag-push + upload — useful for
// verifying artifacts before committing to a tag.
//
// Requires SOV_RELEASES_PATH to point at a local clone of
// yevgetman/sov-releases (LICENSE.txt is sourced from there to keep
// the source-of-truth single).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { exit } from 'node:process';

const OWNER = 'yevgetman';
const PUBLIC_REPO = 'sov-releases';
const ROOT = resolve(import.meta.dir, '..');

type Target = {
  name: 'darwin-arm64' | 'darwin-x64' | 'linux-x64';
  bunTarget: string;
  goos: 'darwin' | 'linux';
  goarch: 'arm64' | 'amd64';
};

const TARGETS: Target[] = [
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', goos: 'darwin', goarch: 'arm64' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', goos: 'darwin', goarch: 'amd64' },
  { name: 'linux-x64', bunTarget: 'bun-linux-x64', goos: 'linux', goarch: 'amd64' },
];

function die(msg: string): never {
  process.stderr.write(`release: ${msg}\n`);
  exit(1);
}

function note(msg: string): void {
  process.stdout.write(`release: ${msg}\n`);
}

function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const result = spawnSync(bin, args, {
    stdio: 'inherit',
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
  });
  if (result.status !== 0) {
    die(`${bin} ${args.join(' ')} → exit ${result.status}`);
  }
}

function capture(bin: string, args: string[], opts: { cwd?: string } = {}): string {
  const result = spawnSync(bin, args, { cwd: opts.cwd ?? ROOT });
  if (result.status !== 0) {
    die(`${bin} ${args.join(' ')} → exit ${result.status}`);
  }
  return result.stdout.toString().trim();
}

function sha256(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function satisfies(have: string, need: string): boolean {
  const parse = (v: string) => v.split('.').map((p) => parseInt(p, 10));
  const a = parse(have);
  const b = parse(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

function preflight(version: string, dryRun: boolean): void {
  note('pre-flight checks...');

  // 1. Version format
  if (!/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    die(`bad version "${version}" — expected vMAJOR.MINOR.PATCH (optionally -suffix)`);
  }

  // 2. Clean git tree
  const status = capture('git', ['status', '--porcelain']);
  if (status !== '') die(`git working tree not clean:\n${status}`);

  // 3. On master
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'master') die(`not on master (on "${branch}")`);

  // 4. Pre-commit gate
  note('running lint...');
  run('bun', ['run', 'lint']);
  note('running typecheck...');
  run('bun', ['run', 'typecheck']);
  note('running test...');
  run('bun', ['run', 'test']);

  // 5. gh CLI authenticated for sov-releases (skip on dry-run since we
  //    won't actually upload). We use `env -u GH_TOKEN` upstream to
  //    bypass a stale token; here we just check the keyring login.
  if (!dryRun) {
    const ghStatus = spawnSync('gh', ['auth', 'status'], {
      env: { ...process.env, GH_TOKEN: '' },
    });
    if (ghStatus.status !== 0) die('gh CLI not authenticated — run: gh auth login');
  }

  // 6. Bun version ≥1.2.0
  const bunVer = capture('bun', ['--version']);
  if (!satisfies(bunVer, '1.2.0')) die(`bun version too old: ${bunVer} (need ≥1.2.0)`);

  // 7. Go version ≥1.24
  const goVerLine = capture('go', ['version']); // "go version go1.24.0 darwin/arm64"
  const goVer = goVerLine.match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? '0';
  if (!satisfies(goVer, '1.24.0')) die(`go version too old: ${goVer} (need ≥1.24)`);

  // 8. Public repo clone present
  const publicRoot = process.env.SOV_RELEASES_PATH;
  if (!publicRoot || !existsSync(join(publicRoot, 'LICENSE.txt'))) {
    die(
      'SOV_RELEASES_PATH must point at a local clone of yevgetman/sov-releases ' +
        '(LICENSE.txt not found there).',
    );
  }

  note('pre-flight ok');
}

function buildOne(target: Target, version: string, releaseDir: string): string {
  const stageDir = join(releaseDir, target.name);
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, 'bin'), { recursive: true });

  // 1. Bun compile
  note(`[${target.name}] bun build --compile...`);
  run('bun', [
    'build',
    '--compile',
    `--target=${target.bunTarget}`,
    `--outfile=${join(stageDir, 'bin', 'sov')}`,
    'src/main.ts',
  ]);

  // 2. Go cross-compile TUI
  note(`[${target.name}] go build sov-tui (${target.goos}/${target.goarch})...`);
  run(
    'go',
    ['build', '-o', join(stageDir, 'bin', 'sov-tui'), './cmd/sov-tui'],
    {
      cwd: join(ROOT, 'packages', 'tui'),
      env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch },
    },
  );

  // 3. Copy bundle-default/
  note(`[${target.name}] copying bundle-default/...`);
  cpSync(join(ROOT, 'bundle-default'), join(stageDir, 'bundle-default'), { recursive: true });

  // 4. Copy LICENSE.txt from the public repo clone
  const publicLicense = join(process.env.SOV_RELEASES_PATH ?? '', 'LICENSE.txt');
  cpSync(publicLicense, join(stageDir, 'LICENSE.txt'));

  // 5. Copy README.binary.md → README.md inside the tarball
  cpSync(join(ROOT, 'README.binary.md'), join(stageDir, 'README.md'));

  // 6. Write version file inside the tarball (mirrors what install.sh writes)
  writeFileSync(join(stageDir, 'version'), `${version}\n`);

  // 7. Tar
  const tarball = join(releaseDir, `sov-${target.name}.tar.gz`);
  note(`[${target.name}] tarring → ${tarball}`);
  run('tar', ['-czf', tarball, '-C', stageDir, '.']);
  const size = statSync(tarball).size;
  note(`[${target.name}] tarball size: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return tarball;
}

function writeSums(tarballs: string[], releaseDir: string): string {
  const lines = tarballs
    .map((p) => {
      const hash = sha256(p);
      const name = basename(p);
      return `${hash}  ${name}`;
    })
    .join('\n');
  const out = join(releaseDir, 'SHA256SUMS');
  writeFileSync(out, `${lines}\n`);
  note(`wrote ${out}`);
  return out;
}

function tagAndPush(version: string): void {
  note(`tagging ${version}...`);
  run('git', ['tag', version]);
  run('git', ['push', 'origin', version]);
}

function uploadRelease(version: string, assets: string[]): void {
  note(`uploading to gh release ${version}...`);
  const args = [
    'release',
    'create',
    version,
    '--repo',
    `${OWNER}/${PUBLIC_REPO}`,
    '--title',
    `Sovereign AI Harness ${version}`,
    '--notes',
    `Binary release ${version}. See CHANGELOG.md in the public repo.`,
    ...assets,
  ];
  // Unset GH_TOKEN so gh uses the keyring login (the env token may be
  // stale on this machine).
  run('gh', args, { env: { ...process.env, GH_TOKEN: '' } });
  note(`released: https://github.com/${OWNER}/${PUBLIC_REPO}/releases/tag/${version}`);
}

// ---------- main ----------

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!version) {
  die('usage: bun run release v0.x.y [--dry-run]');
}

preflight(version, dryRun);

const releaseDir = join(ROOT, 'build', 'release', version);
mkdirSync(releaseDir, { recursive: true });

const tarballs: string[] = [];
for (const target of TARGETS) {
  tarballs.push(buildOne(target, version, releaseDir));
}
const sums = writeSums(tarballs, releaseDir);

if (dryRun) {
  note(`dry-run complete. Artifacts in ${releaseDir}`);
  note('skipped: git tag/push, gh release create');
  exit(0);
}

tagAndPush(version);
uploadRelease(version, [...tarballs, sums]);
note('done.');
