// Platform helpers — the ONE place the SDK and the wrapper ask "are we on
// Windows, and what does that change?". Every answer is byte-identical to the
// prior hardcoded behavior on macOS/Linux; only the `win32` branches are new.
//
//   - exeName('sov-tui')  → 'sov-tui' on POSIX, 'sov-tui.exe' on Windows.
//   - homeDir()           → $HOME, else %USERPROFILE%, else os.homedir().
//   - resolveShell()      → POSIX: bare `bash` (no lookup — the exact argv the
//                           call sites always spawned). Windows: the first of
//                           `bash` (Git for Windows) → `pwsh` → `powershell`
//                           found on PATH, cached for the process lifetime.
//   - shellCommand(script) → the argv to run `script` in that shell.
//
// Every function takes an explicit `platform` / `env` / `exists` override so
// the Windows branches are unit-testable from a POSIX box; production calls
// pass nothing and read the live process.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/** Append `.exe` to a bare executable name on Windows; identity elsewhere. */
export function exeName(base: string, platform: NodeJS.Platform = process.platform): string {
  return isWindows(platform) ? `${base}.exe` : base;
}

/** The user's home directory. `$HOME` keeps precedence (tests and users
 *  override it; POSIX `os.homedir()` honors it too) and `%USERPROFILE%` is the
 *  Windows equivalent that `os.homedir()` reads on win32. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

export type ShellKind = 'bash' | 'pwsh' | 'powershell';

export type ShellSpec = {
  kind: ShellKind;
  /** Bare `bash` on POSIX; the resolved absolute path on Windows. */
  cmd: string;
};

export type ShellCommand = { cmd: string; args: string[] };

export type ResolveShellOpts = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** File-existence predicate for the PATH scan (test seam). */
  exists?: (path: string) => boolean;
};

/** Windows shell preference order. Git for Windows' bash keeps the Bash tool's
 *  POSIX semantics intact, so it wins whenever it is on PATH. */
const WINDOWS_SHELLS: readonly ShellKind[] = ['bash', 'pwsh', 'powershell'];

const DEFAULT_PATHEXT = '.EXE;.CMD;.BAT;.COM';

export const NO_SHELL_MESSAGE =
  'no shell found on PATH: install Git for Windows (bash) or PowerShell 7 (pwsh)';

/** Lookup for one executable on PATH, honoring PATHEXT on Windows. */
function findOnPath(name: string, opts: Required<ResolveShellOpts>): string | null {
  const onWindows = isWindows(opts.platform);
  const pathApi = onWindows ? win32 : posix;
  const dirs = (opts.env.PATH ?? opts.env.Path ?? '').split(pathApi.delimiter).filter(Boolean);
  const exts = onWindows ? (opts.env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = pathApi.join(dir, `${name}${ext}`);
      if (opts.exists(candidate)) return candidate;
    }
  }
  return null;
}

function resolveShellUncached(opts: Required<ResolveShellOpts>): ShellSpec | null {
  // POSIX: keep the exact historical invocation — an unresolved `bash` that
  // the spawn resolves on PATH itself. No lookup, no behavior change.
  if (!isWindows(opts.platform)) return { kind: 'bash', cmd: 'bash' };
  for (const kind of WINDOWS_SHELLS) {
    const cmd = findOnPath(kind, opts);
    if (cmd) return { kind, cmd };
  }
  return null;
}

let cachedShell: ShellSpec | null | undefined;

/** Resolve the shell to run script strings in. The no-argument form reads the
 *  live process and is cached; passing any override bypasses the cache (test
 *  seam) and never populates it. */
export function resolveShell(opts?: ResolveShellOpts): ShellSpec | null {
  if (opts) {
    return resolveShellUncached({
      platform: opts.platform ?? process.platform,
      env: opts.env ?? process.env,
      exists: opts.exists ?? existsSync,
    });
  }
  if (cachedShell === undefined) {
    cachedShell = resolveShellUncached({
      platform: process.platform,
      env: process.env,
      exists: existsSync,
    });
  }
  return cachedShell;
}

/** Pure: the argv to run `script` in `shell`. `login` selects bash's `-lc`
 *  (the skills loader) over `-c` (the Bash tool); PowerShell ignores it. */
export function shellCommandFor(
  shell: ShellSpec | null,
  script: string,
  opts: { login?: boolean } = {},
): ShellCommand {
  if (!shell) throw new Error(NO_SHELL_MESSAGE);
  if (shell.kind === 'bash') {
    return { cmd: shell.cmd, args: [opts.login ? '-lc' : '-c', script] };
  }
  return { cmd: shell.cmd, args: ['-NoProfile', '-Command', script] };
}

/** The argv to run `script` in the process's resolved shell. Throws
 *  {@link NO_SHELL_MESSAGE} when Windows has no usable shell on PATH. */
export function shellCommand(script: string, opts: { login?: boolean } = {}): ShellCommand {
  return shellCommandFor(resolveShell(), script, opts);
}

/** `bash` to execute a `.sh` script file with, or null when the resolved
 *  shell is not bash (Windows without Git for Windows). Bare `bash` on POSIX. */
export function bashPath(opts?: ResolveShellOpts): string | null {
  const shell = resolveShell(opts);
  return shell?.kind === 'bash' ? shell.cmd : null;
}
