// `sov upgrade` — argv builder + dry-run path. Live spawn paths are not
// exercised in unit tests (they would actually re-install the binary).

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_INSTALL_URL,
  PACKAGE_NAME,
  buildUpgradeCommands,
  runUpgrade,
} from '../../src/cli/upgrade.js';

describe('buildUpgradeCommands', () => {
  test('returns [uninstall, install] by default', () => {
    const cmds = buildUpgradeCommands({}, {});
    expect(cmds.length).toBe(2);
    expect(cmds[0]).toEqual(['bun', 'uninstall', '-g', PACKAGE_NAME]);
    expect(cmds[1]).toEqual(['bun', 'install', '-g', DEFAULT_INSTALL_URL]);
  });

  test('skipUninstall returns just the install', () => {
    const cmds = buildUpgradeCommands({ skipUninstall: true }, {});
    expect(cmds.length).toBe(1);
    expect(cmds[0]).toEqual(['bun', 'install', '-g', DEFAULT_INSTALL_URL]);
  });

  test('appends a ref via the standard git #fragment form', () => {
    const cmds = buildUpgradeCommands({ ref: 'v0.2.0' }, {});
    expect(cmds[1]?.[3]).toBe(`${DEFAULT_INSTALL_URL}#v0.2.0`);
  });

  test('honors the SOV_UPGRADE_URL env override', () => {
    const cmds = buildUpgradeCommands(
      {},
      { SOV_UPGRADE_URL: 'git+ssh://git@example.com/fork.git' },
    );
    expect(cmds[1]?.[3]).toBe('git+ssh://git@example.com/fork.git');
  });

  test('opts.installUrl wins over the env var', () => {
    const cmds = buildUpgradeCommands(
      { installUrl: 'git+ssh://git@example.com/from-opt.git' },
      { SOV_UPGRADE_URL: 'git+ssh://git@example.com/from-env.git' },
    );
    expect(cmds[1]?.[3]).toBe('git+ssh://git@example.com/from-opt.git');
  });

  test('ref is concatenated to the override, not the default', () => {
    const cmds = buildUpgradeCommands({
      ref: 'feature-branch',
      installUrl: 'git+ssh://git@example.com/fork.git',
    });
    expect(cmds[1]?.[3]).toBe('git+ssh://git@example.com/fork.git#feature-branch');
  });

  test('the uninstall always targets the canonical PACKAGE_NAME, not the URL', () => {
    const cmds = buildUpgradeCommands({
      installUrl: 'git+ssh://git@example.com/fork.git',
    });
    // Package name is hardcoded — forks override the URL but keep the
    // package identity.
    expect(cmds[0]).toEqual(['bun', 'uninstall', '-g', '@yevgetman/sov']);
  });
});

describe('runUpgrade', () => {
  test('dry-run prints both commands without spawning anything', () => {
    const chunks: string[] = [];
    const errChunks: string[] = [];
    const out = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const err = {
      write: (chunk: string) => {
        errChunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const result = runUpgrade({ dryRun: true, ref: 'v0.2.0' }, out, err);
    expect(result.exitCode).toBe(0);
    expect(result.commands.length).toBe(2);
    expect(result.commands[1]).toEqual(['bun', 'install', '-g', `${DEFAULT_INSTALL_URL}#v0.2.0`]);
    const stdout = chunks.join('');
    expect(stdout).toContain('would run: bun uninstall -g @yevgetman/sov');
    expect(stdout).toContain(`would run: bun install -g ${DEFAULT_INSTALL_URL}#v0.2.0`);
    expect(errChunks).toEqual([]);
  });

  test('dry-run with skipUninstall prints only the install command', () => {
    const chunks: string[] = [];
    const out = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const err = {
      write: () => true,
    } as unknown as NodeJS.WritableStream;
    const result = runUpgrade({ dryRun: true, skipUninstall: true }, out, err);
    expect(result.commands.length).toBe(1);
    expect(chunks.join('')).not.toContain('uninstall');
  });

  test('dry-run with purgeCache reports the cache dir that would be wiped', () => {
    const chunks: string[] = [];
    const out = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const err = { write: () => true } as unknown as NodeJS.WritableStream;
    const result = runUpgrade(
      { dryRun: true, purgeCache: true, cacheDir: '/tmp/fake-bun-cache' },
      out,
      err,
    );
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toContain('would purge: /tmp/fake-bun-cache');
  });

  test('purge is the default — dry-run reports a purge even without explicit purgeCache', () => {
    const chunks: string[] = [];
    const out = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const err = { write: () => true } as unknown as NodeJS.WritableStream;
    const result = runUpgrade({ dryRun: true, cacheDir: '/tmp/fake-bun-cache' }, out, err);
    expect(result.exitCode).toBe(0);
    // Default behavior wipes the cache — no flag required.
    expect(chunks.join('')).toContain('would purge: /tmp/fake-bun-cache');
  });

  test('keepCache opts out of the default purge', () => {
    const chunks: string[] = [];
    const out = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const err = { write: () => true } as unknown as NodeJS.WritableStream;
    const result = runUpgrade(
      { dryRun: true, keepCache: true, cacheDir: '/tmp/fake-bun-cache' },
      out,
      err,
    );
    expect(result.exitCode).toBe(0);
    const stdout = chunks.join('');
    expect(stdout).not.toContain('would purge:');
    expect(stdout).toContain('would skip cache purge');
  });

  test('keepCache wins over an explicit purgeCache=true', () => {
    const chunks: string[] = [];
    const out = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const err = { write: () => true } as unknown as NodeJS.WritableStream;
    const result = runUpgrade(
      {
        dryRun: true,
        keepCache: true,
        purgeCache: true,
        cacheDir: '/tmp/fake-bun-cache',
      },
      out,
      err,
    );
    expect(result.exitCode).toBe(0);
    const stdout = chunks.join('');
    expect(stdout).not.toContain('would purge:');
    expect(stdout).toContain('would skip cache purge');
  });
});

describe('shouldPurgeCache', () => {
  test('defaults to true (the safe-upgrade default since 2026-05-05)', async () => {
    const { shouldPurgeCache } = await import('../../src/cli/upgrade.js');
    expect(shouldPurgeCache({})).toBe(true);
  });

  test('keepCache: true → false', async () => {
    const { shouldPurgeCache } = await import('../../src/cli/upgrade.js');
    expect(shouldPurgeCache({ keepCache: true })).toBe(false);
  });

  test('purgeCache: false → false', async () => {
    const { shouldPurgeCache } = await import('../../src/cli/upgrade.js');
    expect(shouldPurgeCache({ purgeCache: false })).toBe(false);
  });

  test('keepCache: true wins over purgeCache: true', async () => {
    const { shouldPurgeCache } = await import('../../src/cli/upgrade.js');
    expect(shouldPurgeCache({ keepCache: true, purgeCache: true })).toBe(false);
  });
});
