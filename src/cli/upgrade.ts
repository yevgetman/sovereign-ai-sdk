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
// Why purge cache by DEFAULT (since 2026-05-05): even after the
// lockfile is cleared, Bun's binary manifest cache
// (`~/.bun/install/cache/*.npm`) keeps a `URL → SHA` mapping.
// Subsequent `bun install -g <url>` re-uses the cached SHA instead of
// re-resolving against the live remote. We were burned by this enough
// times in real use that the silent-stale-install failure mode is
// strictly worse than the cost of re-fetching every other package's
// manifest on its next install (regenerable, never broken). So
// `sov upgrade` purges the cache by default. `--keep-cache` opts out
// when the user specifically wants to preserve cached manifests for
// other Bun-installed packages.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_INSTALL_URL = 'git+ssh://git@github.com/yevgetman/sovereign-ai-sdk.git';

/** Package name as published in package.json. The pre-uninstall step
 *  needs this exact name to evict the lockfile entry. Hardcoded since
 *  forks override the install URL but keep the package name. */
export const PACKAGE_NAME = '@yevgetman/sov';

/** Phase 21 — public installer URL for binary-mode upgrade. Constant —
 *  the URL is the contract with the sov-releases public repo. If we
 *  ever rename the public repo, this constant moves with it (and so
 *  does the user-facing install command in README.md). */
export const BINARY_INSTALLER_URL =
  'https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh';

/** Install-mode discriminator. 'binary' = installed under ~/.sov/bin/
 *  via the public installer; 'source' = anything else (Bun global
 *  install, `bun src/main.ts` dev loop, project-local bun, etc.). */
export type InstallMode = 'binary' | 'source';

/** Pure predicate for which upgrade strategy to use. Both inputs are
 *  arguments so tests can drive without touching real env / fs.
 *  Binary mode = execPath starts with `${homedir}/.sov/bin/`. Anything
 *  else returns 'source'. */
export function detectInstallMode(input: { execPath: string; homedir: string }): InstallMode {
  const binaryRoot = `${join(input.homedir, '.sov', 'bin')}/`;
  // Prefix-string check is sufficient because the binary install
  // layout is fully under our control (we placed the binary there in
  // install.sh). No realpath needed — execPath is already canonical.
  return input.execPath.startsWith(binaryRoot) ? 'binary' : 'source';
}

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
   *  the git URL against the live remote. **DEFAULT: true** — see file
   *  header for why we burned ourselves enough times to flip the
   *  default. The flag is preserved for explicit opt-in but is
   *  effectively a no-op now (the default already does this). Pass
   *  `keepCache: true` (or `--keep-cache` on the CLI) to opt out. */
  purgeCache?: boolean;
  /** Opt out of the default cache wipe. Use only if you know you have
   *  many other globally-installed Bun packages whose manifest caches
   *  you specifically want to preserve and you trust that bun install
   *  will resolve the git URL freshly anyway (in our experience it
   *  often won't — that's why purge-cache is the default). */
  keepCache?: boolean;
  /** Test seam — overrides DEFAULT_INSTALL_URL and SOV_UPGRADE_URL. */
  installUrl?: string;
  /** Test seam — overrides ~/.bun/install/cache for the purge step. */
  cacheDir?: string;
  /** Test seam — overrides the source checkout used by source-mode upgrades. */
  sourceDir?: string;
  /** Phase 21 — override install-mode detection. Default: auto-detect
   *  from process.execPath via detectInstallMode(). Pass 'source' to
   *  force the legacy bun-install flow even on binary installs (escape
   *  hatch); pass 'binary' to force the public-installer flow even on
   *  source installs (useful for testing). */
  mode?: InstallMode;
};

/** Resolve the effective cache-purge decision from the opt flags.
 *  Binary mode: never purge (Bun's cache is irrelevant when we're not
 *  invoking Bun). Source mode default: purge; explicit purgeCache:false
 *  OR keepCache:true wins. */
export function shouldPurgeCache(opts: UpgradeOpts): boolean {
  const mode = opts.mode ?? detectInstallMode({ execPath: process.execPath, homedir: homedir() });
  if (mode === 'binary') return false;
  if (opts.keepCache === true) return false;
  if (opts.purgeCache === false) return false;
  return true;
}

export type UpgradeResult = {
  exitCode: number;
  /** The argv list(s) that were (or would be) spawned. With pre-uninstall
   *  enabled there are two; otherwise one. */
  commands: string[][];
};

/** Pure helper: produce the argv list(s) we'd spawn.
 *
 *  Binary mode: single command, `bash -c "curl -fsSL <URL> | bash"`.
 *  Source mode: [uninstall, install] (or just [install] if skipUninstall).
 *
 *  Mode is taken from opts.mode if set, else auto-detected from
 *  process.execPath + homedir at call time. */
export function buildUpgradeCommands(
  opts: UpgradeOpts = {},
  env: NodeJS.ProcessEnv = process.env,
): string[][] {
  const mode = opts.mode ?? detectInstallMode({ execPath: process.execPath, homedir: homedir() });

  if (mode === 'binary') {
    return [['bash', '-c', `curl -fsSL ${BINARY_INSTALLER_URL} | bash`]];
  }

  const sourceDir = sourceDirFor(opts);
  const cloneUrl = normalizeGitCloneUrl(
    opts.installUrl ?? env.SOV_UPGRADE_URL ?? DEFAULT_INSTALL_URL,
  );
  const ref = opts.ref ?? 'master';
  const install = [
    ['git', 'clone', cloneUrl, sourceDir],
    ['git', '-C', sourceDir, 'reset', '--hard', 'HEAD'],
    ['git', '-C', sourceDir, 'fetch', '--tags', '--prune', 'origin'],
    ['git', '-C', sourceDir, 'checkout', ref],
    ...(opts.ref ? [] : [['git', '-C', sourceDir, 'pull', '--ff-only', 'origin', 'master']]),
    ['bun', 'install'],
    ['bun', 'link'],
  ];
  if (opts.skipUninstall === true) return install;
  return [['bun', 'uninstall', '-g', PACKAGE_NAME], ...install];
}

/** Run the upgrade. stdio is inherited so the user sees Bun's progress
 *  output verbatim. Returns the install's exit code; the caller
 *  propagates it via process.exit so shell scripts can tell whether the
 *  upgrade succeeded. The pre-uninstall is best-effort (its exit code is
 *  ignored — we expect failures when sov isn't yet installed).
 *
 *  Binary mode: single `bash -c curl|bash` invocation; no cache
 *  management; no source-mode messaging. */
export function runUpgrade(
  opts: UpgradeOpts = {},
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): UpgradeResult {
  const mode = opts.mode ?? detectInstallMode({ execPath: process.execPath, homedir: homedir() });
  const commands = buildUpgradeCommands({ ...opts, mode });

  if (mode === 'binary') {
    if (opts.dryRun === true) {
      for (const cmd of commands) out.write(`would run: ${cmd.join(' ')}\n`);
      return { exitCode: 0, commands };
    }
    return runInstall(commands[0], commands, out, err);
  }

  // ---- source mode (legacy path) ----
  const willPurge = shouldPurgeCache({ ...opts, mode });
  if (opts.dryRun === true) {
    if (willPurge) {
      out.write(`would purge: ${cacheDirFor(opts)}\n`);
    } else {
      out.write('would skip cache purge (--keep-cache)\n');
    }
    for (const cmd of commands) out.write(`would run: ${cmd.join(' ')}\n`);
    return { exitCode: 0, commands };
  }

  // Pre-uninstall (when present) — failures intentionally ignored.
  // Either the package wasn't installed (first install — fine), or
  // bun is missing (the install step below will surface that error
  // with the proper message).
  if (commands.length > 1) {
    const [uninstall] = commands;
    if (uninstall) {
      const [ubin, ...uargs] = uninstall;
      if (ubin) spawnSync(ubin, uargs, { stdio: 'inherit' });
    }
    if (willPurge) purgeCache(opts, out);
    return runSourceInstall(opts, commands, out, err);
  }
  if (willPurge) purgeCache(opts, out);
  return runSourceInstall(opts, commands, out, err);
}

function cacheDirFor(opts: UpgradeOpts): string {
  return opts.cacheDir ?? join(homedir(), '.bun', 'install', 'cache');
}

function sourceDirFor(opts: UpgradeOpts): string {
  return opts.sourceDir ?? join(homedir(), '.cache', 'sov', 'source', 'sovereign-ai-sdk');
}

function normalizeGitCloneUrl(url: string): string {
  if (url.startsWith('git+ssh://')) return `ssh://${url.slice('git+ssh://'.length)}`;
  if (url.startsWith('git+https://')) return `https://${url.slice('git+https://'.length)}`;
  return url;
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

function runSourceInstall(
  opts: UpgradeOpts,
  commands: string[][],
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): UpgradeResult {
  const sourceDir = sourceDirFor(opts);
  const cloneUrl = normalizeGitCloneUrl(
    opts.installUrl ?? process.env.SOV_UPGRADE_URL ?? DEFAULT_INSTALL_URL,
  );
  const ref = opts.ref ?? 'master';

  try {
    mkdirSync(dirname(sourceDir), { recursive: true });
  } catch (cause) {
    err.write(`sov upgrade: failed to create source checkout parent: ${String(cause)}\n`);
    return { exitCode: 1, commands };
  }

  if (existsSync(join(sourceDir, '.git'))) {
    out.write(`updating sov source checkout: ${sourceDir}\n`);
    const reset = runStep(['git', '-C', sourceDir, 'reset', '--hard', 'HEAD'], err);
    if (reset !== 0) return { exitCode: reset, commands };

    const fetch = runStep(['git', '-C', sourceDir, 'fetch', '--tags', '--prune', 'origin'], err);
    if (fetch !== 0) return { exitCode: fetch, commands };
  } else if (existsSync(sourceDir)) {
    err.write(`sov upgrade: source checkout exists but is not a git repo: ${sourceDir}\n`);
    return { exitCode: 1, commands };
  } else {
    out.write(`cloning sov source checkout: ${cloneUrl} -> ${sourceDir}\n`);
    const clone = runStep(['git', 'clone', cloneUrl, sourceDir], err);
    if (clone !== 0) return { exitCode: clone, commands };
  }

  const checkout = runStep(['git', '-C', sourceDir, 'checkout', ref], err);
  if (checkout !== 0) return { exitCode: checkout, commands };

  if (!opts.ref) {
    const pull = runStep(['git', '-C', sourceDir, 'pull', '--ff-only', 'origin', 'master'], err);
    if (pull !== 0) return { exitCode: pull, commands };
  }

  out.write(`installing source dependencies: ${sourceDir}\n`);
  const install = runStep(['bun', 'install'], err, sourceDir);
  if (install !== 0) return { exitCode: install, commands };

  out.write(`linking sov globally from source checkout: ${sourceDir}\n`);
  const link = runStep(['bun', 'link'], err, sourceDir);
  if (link !== 0) return { exitCode: link, commands };

  out.write('sov upgrade: done. The next `sov` invocation uses the linked source checkout.\n');
  return { exitCode: 0, commands };
}

function runStep(cmd: string[], err: NodeJS.WritableStream, cwd?: string): number {
  const [bin, ...args] = cmd;
  if (!bin) {
    err.write('sov upgrade: empty command\n');
    return 1;
  }

  const result = spawnSync(bin, args, { stdio: 'inherit', cwd });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (bin === 'bun' && code === 'ENOENT') {
      err.write(
        'sov upgrade: `bun` is not on PATH.\n' +
          'Install Bun first: curl -fsSL https://bun.sh/install | bash\n',
      );
    } else if (bin === 'git' && code === 'ENOENT') {
      err.write('sov upgrade: `git` is not on PATH.\n');
    } else {
      err.write(`sov upgrade: ${result.error.message}\n`);
    }
    return 1;
  }
  return result.status ?? 1;
}
