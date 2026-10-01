/** Build provenance and the deliberately narrow source-copy boundary. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const INPUT_ROOTS = [
  'src',
  'packages',
  'bundle-default',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'README.binary.md',
];
const PRIVATE_PARTS = new Set([
  '.git',
  '.env',
  '.env.local',
  '.harness',
  '.sov',
  '.claude',
  '.cache',
  '.DS_Store',
]);

export function isReleaseSourceInput(path: string): boolean {
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => PRIVATE_PARTS.has(part) || part.startsWith('.env.'))) return false;
  if (parts.includes('state')) return path === 'bundle-default/state/.gitkeep';
  if (parts.some((part) => ['tests', 'build', 'dist', 'node_modules'].includes(part))) return false;
  return INPUT_ROOTS.some((input) => path === input || path.startsWith(`${input}/`));
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('release provenance requires a readable Git checkout');
  return result.stdout.trim();
}

export function reviewedInputs(root: string): {
  revision: string;
  files: string[];
  digest: string;
} {
  const revision = git(root, ['rev-parse', 'HEAD']);
  const candidates = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const files = candidates.filter(isReleaseSourceInput).sort();
  if (!files.includes('src/main.ts') || !files.includes('bun.lock')) {
    throw new Error('release source inventory is incomplete');
  }
  // Both staged and unstaged edits differ from the exact revision being recorded.
  const dirty = git(root, ['diff', '--name-only', 'HEAD']);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter((path) => path && isReleaseSourceInput(path));
  if (dirty || untracked.length)
    throw new Error('release source inputs must be committed and clean');
  const hash = createHash('sha256');
  for (const file of files) {
    const path = join(root, file);
    if (!lstatSync(path).isFile()) throw new Error('tracked release sources must be regular files');
    hash.update(`${file}\0`).update(readFileSync(path));
  }
  return { revision, files, digest: hash.digest('hex') };
}

export function reviewedLicense(
  root: string,
  expectedRevision: string,
): { revision: string; sha256: string } {
  if (!/^[a-f0-9]{40}$/.test(expectedRevision)) {
    throw new Error('SOV_RELEASES_REVISION must pin the reviewed 40-character license commit');
  }
  const revision = git(root, ['rev-parse', 'HEAD']);
  if (
    revision !== expectedRevision ||
    git(root, ['diff', '--name-only', 'HEAD', '--', 'LICENSE.txt'])
  ) {
    throw new Error('license checkout does not match the reviewed revision');
  }
  const license = readFileSync(join(root, 'LICENSE.txt'));
  const committed = spawnSync('git', ['-C', root, 'show', `${revision}:LICENSE.txt`]);
  if (committed.status !== 0 || !license.equals(committed.stdout))
    throw new Error('license bytes differ from reviewed source');
  return { revision, sha256: createHash('sha256').update(license).digest('hex') };
}

/** Copy tracked source only. Installed dependencies are explicitly allowed,
 * dereferenced into the private scratch tree, and hashed after copying. */
export function copyReviewedSources(root: string, dest: string, files: string[]): string {
  for (const file of files) {
    const target = join(dest, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, file), target, { dereference: true });
  }
  if (!existsSync(join(root, 'node_modules')))
    throw new Error('release compile requires installed frozen-lockfile dependencies');
  cpSync(join(root, 'node_modules'), join(dest, 'node_modules'), {
    recursive: true,
    dereference: true,
    filter: (src) =>
      !relative(join(root, 'node_modules'), src)
        .split(sep)
        .some((part) => PRIVATE_PARTS.has(part) || part.startsWith('.env.')),
  });
  // Workspace imports must read this exact source snapshot, not symlink targets
  // from another checkout. Other local dependencies are recorded by byte digest.
  for (const [name, pkg] of [
    ['sov-sdk', 'sdk'],
    ['sov-protocol', 'protocol'],
  ] as const) {
    const link = join(dest, 'node_modules', '@yevgetman', name);
    rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), join(dest, 'packages', pkg)), link, 'junction');
  }
  const hash = createHash('sha256');
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = relative(dest, path).split(sep).join('/');
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) hash.update(`${rel}\0`).update(readFileSync(path));
      else if (!stat.isSymbolicLink()) throw new Error('unsupported dependency input');
    }
  }
  walk(join(dest, 'node_modules'));
  return hash.digest('hex');
}
