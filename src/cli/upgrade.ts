// `sov upgrade` — one-keystroke upgrade. Shells out to
// `bun install -g <git+ssh-url>` so the user doesn't have to remember the
// full URL.
//
// The install URL is the private repo over SSH (no public registry).
// Access control is the user's GitHub SSH key — same gate as `git clone`.
//
// `SOV_UPGRADE_URL` env var overrides the default, useful for forks /
// development clones or for users who maintain their own mirror.

import { spawnSync } from 'node:child_process';

export const DEFAULT_INSTALL_URL = 'git+ssh://git@github.com/yevgetman/sovereign-ai-harness.git';

export type UpgradeOpts = {
  /** Branch, tag, or commit hash to install. Default: whatever the
   *  remote's default branch resolves to. */
  ref?: string;
  /** Print the command without running it. */
  dryRun?: boolean;
  /** Test seam — overrides DEFAULT_INSTALL_URL and SOV_UPGRADE_URL. */
  installUrl?: string;
};

export type UpgradeResult = {
  exitCode: number;
  /** The argv that was (or would be) spawned. Useful for tests + dry-run. */
  command: string[];
};

/** Pure helper: produce the argv we'd spawn. */
export function buildUpgradeCommand(
  opts: UpgradeOpts = {},
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const base = opts.installUrl ?? env.SOV_UPGRADE_URL ?? DEFAULT_INSTALL_URL;
  const url = opts.ref ? `${base}#${opts.ref}` : base;
  return ['bun', 'install', '-g', url];
}

/** Run the upgrade. stdio is inherited so the user sees Bun's progress
 *  output verbatim. Returns the spawn's exit code; the caller propagates
 *  it via process.exit so shell scripts can tell whether the upgrade
 *  succeeded. */
export function runUpgrade(
  opts: UpgradeOpts = {},
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): UpgradeResult {
  const command = buildUpgradeCommand(opts);
  if (opts.dryRun === true) {
    out.write(`would run: ${command.join(' ')}\n`);
    return { exitCode: 0, command };
  }

  out.write(`upgrading sov via: ${command.join(' ')}\n`);
  const [bin, ...args] = command;
  if (bin === undefined) {
    err.write('sov upgrade: empty command\n');
    return { exitCode: 1, command };
  }
  const result = spawnSync(bin, args, { stdio: 'inherit' });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      err.write(
        'sov upgrade: `bun` is not on PATH.\n' +
          'Install Bun first: curl -fsSL https://bun.sh/install | bash\n',
      );
    } else {
      err.write(`sov upgrade: ${result.error.message}\n`);
    }
    return { exitCode: 1, command };
  }

  const exitCode = result.status ?? 1;
  if (exitCode === 0) {
    out.write('sov upgrade: done. The next `sov` invocation uses the new binary.\n');
  } else {
    err.write(`sov upgrade: bun install exited ${exitCode}\n`);
  }
  return { exitCode, command };
}
