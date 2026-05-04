// `sov upgrade` — one-keystroke upgrade. Shells out to
// `bun install -g <git+ssh-url>` so the user doesn't have to remember the
// full URL.
//
// The install URL is the private repo over SSH (no public registry).
// Access control is the user's GitHub SSH key — same gate as `git clone`.
//
// `SOV_UPGRADE_URL` env var overrides the default, useful for forks /
// development clones or for users who maintain their own mirror.
//
// Why pre-uninstall: Bun's lockfile pins the resolved git SHA per URL.
// Without pre-uninstall, `bun install -g <url>` either reuses the
// pinned SHA or fails with `DependencyLoop` when a different ref is
// requested. Uninstalling first evicts the lockfile entry so a fresh
// install can resolve cleanly.
//
// Why --purge-cache: even after the lockfile is cleared, Bun's binary
// manifest cache (`~/.bun/install/cache/*.npm`) keeps a `URL → SHA`
// mapping. Subsequent `bun install -g <url>` re-uses the cached SHA
// instead of re-resolving against the live remote. The flag wipes
// `~/.bun/install/cache/` so the next install must re-fetch from
// remote. This is the "I want LATEST master, no kidding" hammer; it
// also evicts the npm-package manifest cache for every other package
// (mostly harmless — Bun re-fetches on next install).

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_INSTALL_URL = 'git+ssh://git@github.com/yevgetman/sovereign-ai-harness.git';

/** Package name as published in package.json. The pre-uninstall step
 *  needs this exact name to evict the lockfile entry. Hardcoded since
 *  forks override the install URL but keep the package name. */
export const PACKAGE_NAME = '@yevgetman/sov';

export type UpgradeOpts = {
  /** Branch, tag, or commit hash to install. Default: whatever the
   *  remote's default branch resolves to. */
  ref?: string;
  /** Print the commands without running them. */
  dryRun?: boolean;
  /** Skip the pre-uninstall step. Bun's git-cache will then dictate
   *  the resolved SHA. Useful when you actually want the cached version
   *  and to save the ~1s of uninstall round-trip. */
  skipUninstall?: boolean;
  /** Wipe `~/.bun/install/cache/` before installing so Bun re-resolves
   *  the git URL against the live remote. Use when `sov upgrade` keeps
   *  serving an older SHA than the current `master` HEAD. Also evicts
   *  every other Bun install's manifest cache (regenerable). */
  purgeCache?: boolean;
  /** Test seam — overrides DEFAULT_INSTALL_URL and SOV_UPGRADE_URL. */
  installUrl?: string;
  /** Test seam — overrides ~/.bun/install/cache for the purge step. */
  cacheDir?: string;
};

export type UpgradeResult = {
  exitCode: number;
  /** The argv list(s) that were (or would be) spawned. With pre-uninstall
   *  enabled there are two; otherwise one. */
  commands: string[][];
};

/** Pure helper: produce the argv list(s) we'd spawn. The first command
 *  is the optional uninstall; the second is the install. With
 *  `skipUninstall: true`, only the install command is returned. */
export function buildUpgradeCommands(
  opts: UpgradeOpts = {},
  env: NodeJS.ProcessEnv = process.env,
): string[][] {
  const base = opts.installUrl ?? env.SOV_UPGRADE_URL ?? DEFAULT_INSTALL_URL;
  const url = opts.ref ? `${base}#${opts.ref}` : base;
  const install = ['bun', 'install', '-g', url];
  if (opts.skipUninstall === true) return [install];
  return [['bun', 'uninstall', '-g', PACKAGE_NAME], install];
}

/** Run the upgrade. stdio is inherited so the user sees Bun's progress
 *  output verbatim. Returns the install's exit code; the caller
 *  propagates it via process.exit so shell scripts can tell whether the
 *  upgrade succeeded. The pre-uninstall is best-effort (its exit code is
 *  ignored — we expect failures when sov isn't yet installed). */
export function runUpgrade(
  opts: UpgradeOpts = {},
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): UpgradeResult {
  const commands = buildUpgradeCommands(opts);
  if (opts.dryRun === true) {
    if (opts.purgeCache === true) {
      out.write(`would purge: ${cacheDirFor(opts)}\n`);
    }
    for (const cmd of commands) out.write(`would run: ${cmd.join(' ')}\n`);
    return { exitCode: 0, commands };
  }

  // Pre-uninstall (when present) — failures intentionally ignored.
  // Either the package wasn't installed (first install — fine), or
  // bun is missing (the install step below will surface that error
  // with the proper message).
  if (commands.length > 1) {
    const [uninstall, ...rest] = commands;
    if (uninstall) {
      const [ubin, ...uargs] = uninstall;
      if (ubin) spawnSync(ubin, uargs, { stdio: 'inherit' });
    }
    if (opts.purgeCache === true) purgeCache(opts, out);
    return runInstall(rest[0], commands, out, err);
  }
  if (opts.purgeCache === true) purgeCache(opts, out);
  return runInstall(commands[0], commands, out, err);
}

function cacheDirFor(opts: UpgradeOpts): string {
  return opts.cacheDir ?? join(homedir(), '.bun', 'install', 'cache');
}

function purgeCache(opts: UpgradeOpts, out: NodeJS.WritableStream): void {
  const dir = cacheDirFor(opts);
  out.write(`purging Bun install cache: ${dir}\n`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Cache dir might not exist on a fresh machine; that's fine.
  }
}

function runInstall(
  install: string[] | undefined,
  commands: string[][],
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): UpgradeResult {
  if (!install) {
    err.write('sov upgrade: empty install command\n');
    return { exitCode: 1, commands };
  }
  out.write(`upgrading sov via: ${install.join(' ')}\n`);
  const [bin, ...args] = install;
  if (bin === undefined) {
    err.write('sov upgrade: empty command\n');
    return { exitCode: 1, commands };
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
    return { exitCode: 1, commands };
  }

  const exitCode = result.status ?? 1;
  if (exitCode === 0) {
    out.write('sov upgrade: done. The next `sov` invocation uses the new binary.\n');
  } else {
    err.write(`sov upgrade: bun install exited ${exitCode}\n`);
  }
  return { exitCode, commands };
}
