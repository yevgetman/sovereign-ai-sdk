// `sov upgrade` on Windows — binary-mode self-upgrade is not supported yet
// (the binary is laid down by the Telekit installer, not install.sh), so the
// command must explain that and exit non-zero WITHOUT spawning `bash -c curl`.
// Driven through the `platform` seam so it runs deterministically on POSIX.

import { describe, expect, test } from 'bun:test';
import {
  BINARY_INSTALLER_URL,
  WINDOWS_BINARY_UPGRADE_MESSAGE,
  buildUpgradeCommands,
  detectInstallMode,
  runUpgrade,
} from '../../src/cli/upgrade.js';

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = {
    write: (c: string) => {
      chunks.push(c);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => chunks.join('') };
}

describe('buildUpgradeCommands — binary mode on Windows', () => {
  test('returns no commands (nothing to spawn)', () => {
    expect(buildUpgradeCommands({ mode: 'binary', platform: 'win32' }, {})).toEqual([]);
  });

  test('the posix curl|bash command is unchanged for darwin/linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const cmds = buildUpgradeCommands({ mode: 'binary', platform }, {});
      expect(cmds).toEqual([['bash', '-c', `curl -fsSL ${BINARY_INSTALLER_URL} | bash`]]);
    }
  });

  test('source mode on Windows is untouched by the short-circuit', () => {
    const cmds = buildUpgradeCommands(
      { mode: 'source', platform: 'win32', sourceDir: '/tmp/sov-source-checkout' },
      {},
    );
    expect(cmds.length).toBe(8);
  });
});

describe('runUpgrade — binary mode on Windows', () => {
  test('prints the Telekit app/installer pointer and exits 1', () => {
    const out = sink();
    const err = sink();
    const result = runUpgrade({ mode: 'binary', platform: 'win32' }, out.stream, err.stream);
    expect(result.exitCode).toBe(1);
    expect(result.commands).toEqual([]);
    expect(err.text()).toBe(WINDOWS_BINARY_UPGRADE_MESSAGE);
    expect(err.text()).toContain('Telekit');
    expect(out.text()).toBe('');
  });

  test('dry-run reports the same unsupported message rather than a would-run line', () => {
    const out = sink();
    const err = sink();
    const result = runUpgrade(
      { mode: 'binary', platform: 'win32', dryRun: true },
      out.stream,
      err.stream,
    );
    expect(result.exitCode).toBe(1);
    expect(err.text()).toBe(WINDOWS_BINARY_UPGRADE_MESSAGE);
    expect(out.text()).not.toContain('would run');
  });
});

describe('detectInstallMode — separator-aware root', () => {
  test('posix paths still match on this host', () => {
    if (process.platform === 'win32') return;
    expect(detectInstallMode({ execPath: '/home/a/.sov/bin/sov', homedir: '/home/a' })).toBe(
      'binary',
    );
    // A sibling dir that merely shares the prefix must NOT match.
    expect(detectInstallMode({ execPath: '/home/a/.sov/binx/sov', homedir: '/home/a' })).toBe(
      'source',
    );
  });
});
