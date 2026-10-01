import { createHash } from 'node:crypto';
/** The shared scanner is build-only; consumer payloads never include its rules. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Target, executableName, run } from './release-shared';

export function scannerPython(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function packageInventory(target: Target): string[] {
  return [
    `bin/${executableName('sov', target)}`,
    `bin/${executableName('sov-tui', target)}`,
    'bundle-default/index.yaml',
    'bundle-default/BUNDLE-CONTRACT.md',
    'README.md',
    'LICENSE.txt',
    'version',
    'build-inputs.json',
  ];
}

export function validateScannerSnapshot(snapshot = join(import.meta.dir, 'fresh_install')): void {
  if (!existsSync(join(snapshot, 'manifest.json')))
    throw new Error('missing pinned build-only scanner snapshot');
  const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8')) as {
    schema_version: number;
    policy_version: string;
    scanner_version: string;
    source_revision: string;
    source_base_commit: string;
    source_repository: string;
    files: Record<string, string>;
  };
  const names = ['__init__.py', '__main__.py', 'cli.py', 'policy.json', 'scanner.py'];
  if (
    manifest.schema_version !== 1 ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(names) ||
    manifest.source_repository !== 'https://github.com/yevgetman/kernel-installer' ||
    !/^[a-f0-9]{40}$/.test(manifest.source_base_commit)
  ) {
    throw new Error('invalid build-only scanner snapshot manifest');
  }
  for (const name of names) {
    const digest = createHash('sha256')
      .update(readFileSync(join(snapshot, name)))
      .digest('hex');
    if (manifest.files[name] !== digest)
      throw new Error('build-only scanner snapshot hash mismatch');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(manifest.files).sort())))
    .digest('hex');
  const policy = JSON.parse(readFileSync(join(snapshot, 'policy.json'), 'utf8')) as {
    version: string;
  };
  const scannerVersion = readFileSync(join(snapshot, 'scanner.py'), 'utf8').match(
    /^SCANNER_VERSION = ["']([^"']+)["']/m,
  )?.[1];
  if (
    manifest.source_revision !== `sha256:${digest}` ||
    manifest.policy_version !== policy.version ||
    manifest.scanner_version !== scannerVersion ||
    !scannerVersion
  ) {
    throw new Error('build-only scanner snapshot revision mismatch');
  }
}

export function preflightPackageScanner(exec: typeof run = run): void {
  validateScannerSnapshot();
  exec(scannerPython(), ['--version'], { throwOnError: true });
}

export function scanReleasePayload(
  input: string,
  target: Target,
  opts: { receipt?: string; required?: string[]; exec?: typeof run } = {},
): void {
  const args = ['-m', 'fresh_install', input, '--architecture', target.name];
  if (opts.receipt) args.push('--receipt', opts.receipt);
  for (const path of opts.required ?? []) args.push('--require', path);
  (opts.exec ?? run)(scannerPython(), args, { cwd: import.meta.dir, throwOnError: true });
}
