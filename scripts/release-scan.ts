import { createHash } from 'node:crypto';
/** The shared scanner is build-only; consumer payloads never include its rules. */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
): ScanReceipt | undefined {
  const args = ['-m', 'fresh_install', input, '--architecture', target.name];
  if (opts.receipt) args.push('--receipt', opts.receipt);
  for (const path of opts.required ?? []) args.push('--require', path);
  (opts.exec ?? run)(scannerPython(), args, { cwd: import.meta.dir, throwOnError: true });
  if (opts.receipt) {
    const receipt = JSON.parse(readFileSync(opts.receipt, 'utf8')) as ScanReceipt;
    if (receipt.result !== 'clean' || receipt.exit_code !== 0 || !Array.isArray(receipt.inventory))
      throw new Error('package scan did not produce a complete clean receipt');
    return receipt;
  }
}

export interface ScanReceipt {
  result: string;
  exit_code: number;
  inventory: Array<{
    path: string;
    kind: string;
    sha256?: string;
    size?: number;
    mode?: number | null;
    target_sha256?: string;
  }>;
}

/** Content cleanliness does not prove the packer retained the complete stage. */
export function verifyPackagedInventory(
  stage: ScanReceipt | undefined,
  packed: ScanReceipt | undefined,
  archive: string,
  target: Target,
): void {
  if (!stage || !packed || stage.result !== 'clean' || packed.result !== 'clean')
    throw new Error('package inventory requires both complete scan receipts');
  const prefix = `${basename(archive).replace(/\.gz$/, '')}!`;
  const wrappers = new Set([basename(archive), basename(archive).replace(/\.gz$/, '')]);
  function entries(receipt: ScanReceipt, archived: boolean): Map<string, string> {
    const result = new Map<string, string>();
    for (const entry of receipt.inventory) {
      if (entry.kind === 'directory') continue;
      if (archived && !entry.path.startsWith(prefix)) {
        if (wrappers.has(entry.path) && ['gzip', 'tar', 'zip'].includes(entry.kind)) continue;
        throw new Error('unexpected entry outside final package inventory');
      }
      const path = archived ? entry.path.slice(prefix.length) : entry.path;
      if (!path || result.has(path)) throw new Error('ambiguous package inventory');
      // ZIP on Windows has no POSIX execution contract. Tar must retain each
      // top-level resource's mode; nested archive members retain their own bytes.
      const mode = target.goos === 'windows' ? undefined : entry.mode;
      result.set(
        path,
        JSON.stringify([entry.kind, entry.sha256, entry.size, mode, entry.target_sha256]),
      );
    }
    return result;
  }
  const before = entries(stage, false);
  const after = entries(packed, true);
  if (
    before.size !== after.size ||
    [...before].some(([path, identity]) => after.get(path) !== identity)
  )
    throw new Error('final package inventory differs from scanned stage');
}
