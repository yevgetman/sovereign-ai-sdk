// scripts/release-build-target.ts — Phase 21 M2 single-target builder.
//
// Usage: bun scripts/release-build-target.ts <target> <version>
//
// Compiles sov (Bun) + sov-tui (Go) for <target>, copies bundle-default
// + LICENSE.txt + README + version into a staging dir, then packages it to
// build/release/<version>/sov-<target>.tar.gz — or sov-<target>.zip for
// windows-x64, where the binaries also carry `.exe` (see artifactName /
// executableName in release-shared.ts).
//
// Required env:
//   SOV_RELEASES_PATH — path to a sov-releases checkout (for LICENSE.txt)

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { exit } from 'node:process';
import {
  TARGETS,
  type Target,
  archiveFormat,
  artifactName,
  die,
  executableName,
  note,
  repoRoot,
  run,
} from './release-shared';
import { writeZip } from './release-zip';

export function resolveTarget(name: string): Target | null {
  return TARGETS.find((t) => t.name === name) ?? null;
}

/**
 * Decide whether a path under `bundle-default/` may be copied into a release
 * tarball. The runtime working state (`bundle-default/state/**`) is gitignored
 * and can accrue captured session trajectories — which may contain secrets and
 * private project data. The local `cpSync` previously copied the whole working
 * tree, so untracked state leaked into v0.2.0–v0.5.11 public tarballs (audit
 * C1, docs/audits/2026-06-10-full-codebase-audit.md). Stage only the tracked
 * `.gitkeep` marker from `state/`; everything else under `state/` is dropped.
 * Everything outside `state/` stages normally.
 */
export function shouldStageBundlePath(bundleRoot: string, srcPath: string): boolean {
  const stateRoot = resolve(bundleRoot, 'state');
  const resolved = resolve(srcPath);
  if (resolved === stateRoot) return true; // keep the state/ dir shell for .gitkeep
  const rel = relative(stateRoot, resolved);
  const underState = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (!underState) return true; // outside state/ → always stage
  return rel === '.gitkeep'; // inside state/: only the tracked marker survives
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

/** The staged binary paths for a target: `bin/sov` + `bin/sov-tui`, with
 *  `.exe` appended on windows. */
export function stagedBinaryPaths(stageDir: string, target: Target): { sov: string; tui: string } {
  return {
    sov: join(stageDir, 'bin', executableName('sov', target)),
    tui: join(stageDir, 'bin', executableName('sov-tui', target)),
  };
}

/** Where the packaged artifact for a target lands inside the release dir. */
export function archivePathFor(releaseDir: string, target: Target): string {
  return join(releaseDir, artifactName(target));
}

/** Package a staged tree: zip on windows (no `tar` there), tar.gz elsewhere.
 *  Both formats carry the identical internal layout (bin/, bundle-default/,
 *  version, LICENSE.txt, README.md) rooted at the archive top level. */
export function packageStage(target: Target, stageDir: string, archivePath: string): void {
  if (archiveFormat(target) === 'zip') {
    writeZip(archivePath, stageDir);
    return;
  }
  run('tar', ['-czf', archivePath, '-C', stageDir, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
}

/**
 * Bun 1.3.13 embeds `/Users/runner/work/_temp/webkit-release/...` inside the
 * runtime that `bun build --compile` links in. A builder whose home is exactly
 * that account cannot treat the prefix as a leak signal. Any other home can.
 */
const RUNNER_ACCOUNT_HOMES = new Set(['/Users/runner', '/home/runner']);

function canonicalHome(home: string): string {
  return home.replace(/[\\/]+$/, '').replace(/\\/g, '/');
}

/** Byte strings that must not survive in a published `bin/sov`. */
export function findBuilderLeak(bytes: Buffer, home: string): string | null {
  const prefix = home.replace(/[\\/]+$/, '');
  const markers: string[] = [];
  if (prefix.length > 1 && !RUNNER_ACCOUNT_HOMES.has(canonicalHome(prefix))) {
    markers.push(prefix);
  }
  markers.push('~/code');
  for (const marker of markers) {
    if (bytes.includes(marker)) return marker;
  }
  return null;
}

/**
 * `realDir` is a realpath. Reject $HOME and /var/folders (both contain the
 * username on macOS). Accept only a directory under /tmp, which realpaths to
 * /private/tmp on macOS. Windows Node maps `/tmp` to `<drive>:\tmp`.
 */
export function unsafeCompileDirReason(realDir: string, home: string): string | null {
  const dir = canonicalHome(realDir);
  const homePrefix = canonicalHome(home);
  if (homePrefix.length > 1 && (dir === homePrefix || dir.startsWith(`${homePrefix}/`))) {
    return `inside home ${homePrefix}`;
  }
  if (dir === '/var/folders' || dir.startsWith('/var/folders/')) return 'under /var/folders';
  const underTmp =
    dir.startsWith('/tmp/') || dir.startsWith('/private/tmp/') || /^[A-Za-z]:\/tmp\//.test(dir);
  if (!underTmp) return 'not under /tmp';
  return null;
}

function bunCompileTempParent(): string {
  // Never os.tmpdir(): on macOS that is /var/folders/<...>/<user>/T.
  if (!existsSync('/tmp')) {
    if (process.platform !== 'win32') throw new Error('bun compile requires /tmp');
    mkdirSync('/tmp', { recursive: true });
  }
  const parent = realpathSync('/tmp');
  const why = unsafeCompileDirReason(join(parent, 'sov-bun-compile-probe'), homedir());
  if (why !== null) throw new Error(`refusing bun compile temp parent ${parent}: ${why}`);
  return parent;
}

function shouldCopyForBunCompile(root: string, srcPath: string): boolean {
  const rel = relative(root, srcPath);
  if (rel === '' || rel === '.') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  if (parts.some((part) => part === '.git')) return false;
  if (parts[0] === 'build') return false;
  return true;
}

/** Dereference so bun's realpath cannot escape back to the checkout. */
function copyForBunCompile(root: string, dest: string): void {
  cpSync(root, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => shouldCopyForBunCompile(root, src),
  });
}

function assertNoBuilderPathLeak(binaryPath: string, home: string): void {
  if (!existsSync(binaryPath)) {
    throw new Error(`bun compile did not produce ${binaryPath}`);
  }
  const leak = findBuilderLeak(readFileSync(binaryPath), home);
  if (leak !== null) {
    throw new Error(`bin/sov contains builder path ${JSON.stringify(leak)}`);
  }
}

/**
 * Compile sov + sov-tui into `stageDir`.
 *
 * `bun build --compile` (1.3.13) writes every bundled file's path into the
 * executable as a `// <path>` banner, relative to cwd, after realpath. Build
 * from a mode-0700 copy under /tmp so the banner cannot name the checkout,
 * then refuse to continue if `bin/sov` still contains the builder's home
 * prefix or the bytes `~/code`.
 */
export function compileBinaries(
  target: Target,
  stageDir: string,
  opts: {
    run?: typeof run;
    root?: string;
    home?: string;
  } = {},
): void {
  const exec = opts.run ?? run;
  const root = opts.root ?? repoRoot();
  const home = opts.home ?? homedir();
  const bins = stagedBinaryPaths(stageDir, target);
  const scratch = mkdtempSync(join(bunCompileTempParent(), 'sov-bun-compile-'));
  try {
    chmodSync(scratch, 0o700);
    const compileDir = realpathSync(scratch);
    const why = unsafeCompileDirReason(compileDir, homedir());
    if (why !== null) throw new Error(`bun compile dir ${compileDir} is unsafe: ${why}`);
    copyForBunCompile(root, compileDir);

    note(`[${target.name}] bun build --compile...`);
    exec(
      'bun',
      [
        'build',
        '--compile',
        `--target=${target.bunTarget}`,
        `--outfile=${bins.sov}`,
        'src/main.ts',
      ],
      { cwd: compileDir, throwOnError: true },
    );
    assertNoBuilderPathLeak(bins.sov, home);

    note(`[${target.name}] go build sov-tui (${target.goos}/${target.goarch})...`);
    exec('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', bins.tui, './cmd/sov-tui'], {
      cwd: join(root, 'packages', 'tui'),
      env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch },
      throwOnError: true,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function stageBundleAndMetadata(
  target: Target,
  stageDir: string,
  version: string,
  publicRepoPath: string,
): void {
  const root = repoRoot();
  note(`[${target.name}] copying bundle-default/ (excluding runtime state/)...`);
  const bundleRoot = join(root, 'bundle-default');
  cpSync(bundleRoot, join(stageDir, 'bundle-default'), {
    recursive: true,
    // Never stage gitignored runtime state — it can carry captured secrets.
    filter: (src) => shouldStageBundlePath(bundleRoot, src),
  });

  cpSync(join(publicRepoPath, 'LICENSE.txt'), join(stageDir, 'LICENSE.txt'));
  cpSync(join(root, 'README.binary.md'), join(stageDir, 'README.md'));
  writeFileSync(join(stageDir, 'version'), `${version}\n`);
}

function buildOne(target: Target, version: string, publicRepoPath: string): string {
  const releaseDir = join(repoRoot(), 'build', 'release', version);
  const stageDir = join(releaseDir, target.name);
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, 'bin'), { recursive: true });

  try {
    compileBinaries(target, stageDir);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  stageBundleAndMetadata(target, stageDir, version, publicRepoPath);

  const archive = archivePathFor(releaseDir, target);
  note(`[${target.name}] packaging (${archiveFormat(target)}) → ${archive}`);
  packageStage(target, stageDir, archive);
  const size = statSync(archive).size;
  note(`[${target.name}] artifact size: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return archive;
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
