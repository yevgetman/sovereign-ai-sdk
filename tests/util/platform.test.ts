// Platform helper tests — the Windows branches are driven from a POSIX box via
// the explicit `platform` / `env` / `exists` seams; the POSIX branches assert
// the byte-identical historical behavior (`bash -c` / `bash -lc`, bare name).

import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import {
  NO_SHELL_MESSAGE,
  bashPath,
  exeName,
  homeDir,
  isWindows,
  resolveShell,
  shellCommand,
  shellCommandFor,
} from '@yevgetman/sov-sdk/util/platform';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.EXE';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.EXE';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE';

const WIN_ENV: NodeJS.ProcessEnv = {
  PATH: [
    'C:\\Windows\\System32',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files\\PowerShell\\7',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  ].join(';'),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
};

/** A mocked PATH lookup: only the listed absolute paths "exist". */
function existsOnly(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('isWindows / exeName', () => {
  test('isWindows is true only for win32', () => {
    expect(isWindows('win32')).toBe(true);
    expect(isWindows('darwin')).toBe(false);
    expect(isWindows('linux')).toBe(false);
  });

  test('exeName appends .exe on win32 and is identity on posix', () => {
    expect(exeName('sov-tui', 'win32')).toBe('sov-tui.exe');
    expect(exeName('sov-tui', 'darwin')).toBe('sov-tui');
    expect(exeName('sov-tui', 'linux')).toBe('sov-tui');
  });

  test('exeName defaults to the live platform', () => {
    const expected = process.platform === 'win32' ? 'sov.exe' : 'sov';
    expect(exeName('sov')).toBe(expected);
  });
});

describe('homeDir', () => {
  test('prefers HOME when set', () => {
    expect(homeDir({ HOME: '/Users/test', USERPROFILE: 'C:\\Users\\test' })).toBe('/Users/test');
  });

  test('falls back to USERPROFILE when HOME is unset', () => {
    expect(homeDir({ USERPROFILE: 'C:\\Users\\test' })).toBe('C:\\Users\\test');
  });

  test('treats an empty HOME as unset', () => {
    expect(homeDir({ HOME: '', USERPROFILE: 'C:\\Users\\test' })).toBe('C:\\Users\\test');
  });

  test('falls back to os.homedir() when neither is set', () => {
    expect(homeDir({})).toBe(homedir());
  });
});

describe('resolveShell — posix', () => {
  test('returns bare `bash` with no PATH lookup', () => {
    // `exists` never consulted: even a lookup that finds nothing yields bash.
    const shell = resolveShell({ platform: 'darwin', env: { PATH: '' }, exists: () => false });
    expect(shell).toEqual({ kind: 'bash', cmd: 'bash' });
    expect(resolveShell({ platform: 'linux', env: {}, exists: () => false })).toEqual({
      kind: 'bash',
      cmd: 'bash',
    });
  });
});

describe('resolveShell — win32 (mocked PATH lookup)', () => {
  test('prefers Git for Windows bash when it is on PATH', () => {
    const shell = resolveShell({
      platform: 'win32',
      env: WIN_ENV,
      exists: existsOnly(GIT_BASH, PWSH, POWERSHELL),
    });
    expect(shell).toEqual({ kind: 'bash', cmd: GIT_BASH });
  });

  test('falls back to pwsh when bash is absent', () => {
    const shell = resolveShell({
      platform: 'win32',
      env: WIN_ENV,
      exists: existsOnly(PWSH, POWERSHELL),
    });
    expect(shell).toEqual({ kind: 'pwsh', cmd: PWSH });
  });

  test('falls back to powershell when bash and pwsh are absent', () => {
    const shell = resolveShell({
      platform: 'win32',
      env: WIN_ENV,
      exists: existsOnly(POWERSHELL),
    });
    expect(shell).toEqual({ kind: 'powershell', cmd: POWERSHELL });
  });

  test('returns null when no shell is on PATH', () => {
    expect(resolveShell({ platform: 'win32', env: WIN_ENV, exists: () => false })).toBeNull();
  });

  test('honors PATHEXT and falls back to the default extension list', () => {
    const cmdBash = 'C:\\Program Files\\Git\\bin\\bash.CMD';
    expect(
      resolveShell({
        platform: 'win32',
        env: { ...WIN_ENV, PATHEXT: '.CMD' },
        exists: existsOnly(cmdBash, GIT_BASH),
      }),
    ).toEqual({ kind: 'bash', cmd: cmdBash });
    // No PATHEXT at all → the built-in default still finds bash.EXE.
    expect(
      resolveShell({
        platform: 'win32',
        env: { PATH: WIN_ENV.PATH },
        exists: existsOnly(GIT_BASH),
      }),
    ).toEqual({ kind: 'bash', cmd: GIT_BASH });
  });

  test('reads a lowercase `Path` variable too', () => {
    const shell = resolveShell({
      platform: 'win32',
      env: { Path: WIN_ENV.PATH, PATHEXT: WIN_ENV.PATHEXT },
      exists: existsOnly(GIT_BASH),
    });
    expect(shell).toEqual({ kind: 'bash', cmd: GIT_BASH });
  });
});

describe('resolveShell — caching', () => {
  test('the no-argument form is cached; the seam form is not', () => {
    expect(resolveShell()).toBe(resolveShell());
    const a = resolveShell({ platform: 'darwin' });
    const b = resolveShell({ platform: 'darwin' });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('shellCommandFor / shellCommand', () => {
  test('bash → `-c script`; login → `-lc script`', () => {
    const bash = { kind: 'bash' as const, cmd: 'bash' };
    expect(shellCommandFor(bash, 'echo hi')).toEqual({ cmd: 'bash', args: ['-c', 'echo hi'] });
    expect(shellCommandFor(bash, 'echo hi', { login: true })).toEqual({
      cmd: 'bash',
      args: ['-lc', 'echo hi'],
    });
  });

  test('pwsh / powershell → `-NoProfile -Command script` (login ignored)', () => {
    expect(shellCommandFor({ kind: 'pwsh', cmd: PWSH }, 'Get-Date')).toEqual({
      cmd: PWSH,
      args: ['-NoProfile', '-Command', 'Get-Date'],
    });
    expect(
      shellCommandFor({ kind: 'powershell', cmd: POWERSHELL }, 'Get-Date', { login: true }),
    ).toEqual({ cmd: POWERSHELL, args: ['-NoProfile', '-Command', 'Get-Date'] });
  });

  test('throws the actionable message when no shell resolved', () => {
    expect(() => shellCommandFor(null, 'echo hi')).toThrow(NO_SHELL_MESSAGE);
  });

  test('shellCommand on a posix host is the historical `bash -c` argv', () => {
    if (process.platform === 'win32') return;
    expect(shellCommand('echo hi')).toEqual({ cmd: 'bash', args: ['-c', 'echo hi'] });
    expect(shellCommand('echo hi', { login: true })).toEqual({
      cmd: 'bash',
      args: ['-lc', 'echo hi'],
    });
  });
});

describe('bashPath', () => {
  test('posix → bare `bash`', () => {
    expect(bashPath({ platform: 'linux', env: {}, exists: () => false })).toBe('bash');
  });

  test('win32 → the resolved Git bash, or null when only PowerShell is present', () => {
    expect(bashPath({ platform: 'win32', env: WIN_ENV, exists: existsOnly(GIT_BASH) })).toBe(
      GIT_BASH,
    );
    expect(bashPath({ platform: 'win32', env: WIN_ENV, exists: existsOnly(PWSH) })).toBeNull();
  });
});
