// `sov upgrade` — argv builder + dry-run path. Live spawn paths are not
// exercised in unit tests (they would actually re-install the binary).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BINARY_INSTALLER_URL,
  DEFAULT_INSTALL_URL,
  PACKAGE_NAME,
  buildUpgradeCommands,
  detectInstallMode,
  runUpgrade,
} from '../../src/cli/upgrade.js';

const REPO_ROOT = join(import.meta.dir, '..', '..');

describe('buildUpgradeCommands', () => {
  const sourceDir = '/tmp/sov-source-checkout';

  test('returns source-checkout upgrade commands by default', () => {
    const cmds = buildUpgradeCommands({ sourceDir }, {});
    expect(cmds.length).toBe(7);
    expect(cmds[0]).toEqual(['bun', 'uninstall', '-g', PACKAGE_NAME]);
    expect(cmds[1]).toEqual([
      'git',
      'clone',
      DEFAULT_INSTALL_URL.replace('git+ssh://', 'ssh://'),
      sourceDir,
    ]);
    expect(cmds.at(-2)).toEqual(['bun', 'install']);
    expect(cmds.at(-1)).toEqual(['bun', 'link']);
  });

  test('skipUninstall omits the pre-uninstall command', () => {
    const cmds = buildUpgradeCommands({ skipUninstall: true, sourceDir }, {});
    expect(cmds[0]?.[0]).toBe('git');
    expect(cmds.some((cmd) => cmd.join(' ') === `bun uninstall -g ${PACKAGE_NAME}`)).toBe(false);
  });

  test('checks out an explicit ref in the source checkout', () => {
    const cmds = buildUpgradeCommands({ ref: 'v0.2.0', sourceDir }, {});
    expect(cmds).toContainEqual(['git', '-C', sourceDir, 'checkout', 'v0.2.0']);
    expect(cmds).not.toContainEqual([
      'git',
      '-C',
      sourceDir,
      'pull',
      '--ff-only',
      'origin',
      'master',
    ]);
  });

  test('honors the SOV_UPGRADE_URL env override', () => {
    const cmds = buildUpgradeCommands(
      { sourceDir },
      { SOV_UPGRADE_URL: 'git+ssh://git@example.com/fork.git' },
    );
    expect(cmds[1]).toEqual(['git', 'clone', 'ssh://git@example.com/fork.git', sourceDir]);
  });

  test('opts.installUrl wins over the env var', () => {
    const cmds = buildUpgradeCommands(
      { installUrl: 'git+ssh://git@example.com/from-opt.git', sourceDir },
      { SOV_UPGRADE_URL: 'git+ssh://git@example.com/from-env.git' },
    );
    expect(cmds[1]).toEqual(['git', 'clone', 'ssh://git@example.com/from-opt.git', sourceDir]);
  });

  test('ref checkout composes with the override, not the default', () => {
    const cmds = buildUpgradeCommands({
      ref: 'feature-branch',
      installUrl: 'git+ssh://git@example.com/fork.git',
      sourceDir,
    });
    expect(cmds[1]).toEqual(['git', 'clone', 'ssh://git@example.com/fork.git', sourceDir]);
    expect(cmds).toContainEqual(['git', '-C', sourceDir, 'checkout', 'feature-branch']);
  });

  test('the uninstall always targets the canonical PACKAGE_NAME, not the URL', () => {
    const cmds = buildUpgradeCommands({
      installUrl: 'git+ssh://git@example.com/fork.git',
      sourceDir,
    });
    // Package name is hardcoded — forks override the URL but keep the
    // package identity.
    expect(cmds[0]).toEqual(['bun', 'uninstall', '-g', '@yevgetman/sov']);
  });
});

describe('source install packaging', () => {
  test('root CLI package uses file deps for internal packages, not workspace protocol', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.['@yevgetman/sov-protocol']).toBe('file:packages/protocol');
    expect(pkg.dependencies?.['@yevgetman/sov-sdk']).toBe('file:packages/sdk');
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
    expect(result.commands.length).toBeGreaterThanOrEqual(5);
    const stdout = chunks.join('');
    expect(stdout).toContain('would run: bun uninstall -g @yevgetman/sov');
    expect(stdout).toContain('would run: git clone');
    expect(stdout).toContain('would run: git -C');
    expect(stdout).toContain('would run: bun link');
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
    expect(chunks.join('')).not.toContain('uninstall');
    expect(result.commands[0]?.[0]).toBe('git');
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

  test('binary mode short-circuits to false (Bun cache irrelevant)', async () => {
    const { shouldPurgeCache } = await import('../../src/cli/upgrade.js');
    expect(shouldPurgeCache({ mode: 'binary' })).toBe(false);
    // Even with explicit purgeCache: true, binary mode wins.
    expect(shouldPurgeCache({ mode: 'binary', purgeCache: true })).toBe(false);
  });
});

describe('detectInstallMode', () => {
  test('returns "binary" when execPath is under ~/.sov/bin/', () => {
    expect(
      detectInstallMode({ execPath: '/home/alice/.sov/bin/sov', homedir: '/home/alice' }),
    ).toBe('binary');
  });

  test('returns "binary" for the macOS-style ~/.sov/bin path', () => {
    expect(
      detectInstallMode({ execPath: '/Users/julie/.sov/bin/sov', homedir: '/Users/julie' }),
    ).toBe('binary');
  });

  test('returns "source" when execPath is the Bun runtime', () => {
    expect(
      detectInstallMode({ execPath: '/Users/julie/.bun/bin/bun', homedir: '/Users/julie' }),
    ).toBe('source');
  });

  test('returns "source" when execPath is a project-local node_modules entry', () => {
    expect(
      detectInstallMode({
        execPath: '/Users/julie/code/sov/node_modules/.bin/bun',
        homedir: '/Users/julie',
      }),
    ).toBe('source');
  });

  test('returns "source" when execPath is unrelated', () => {
    expect(detectInstallMode({ execPath: '/usr/local/bin/bun', homedir: '/Users/julie' })).toBe(
      'source',
    );
  });

  test('does not match a similar-but-different prefix (e.g. ~/.sovereign-other)', () => {
    expect(
      detectInstallMode({
        execPath: '/Users/julie/.sovereign-other/bin/sov',
        homedir: '/Users/julie',
      }),
    ).toBe('source');
  });
});

describe('buildUpgradeCommands — binary mode', () => {
  test('returns single bash -c curl|bash command', () => {
    const cmds = buildUpgradeCommands({ mode: 'binary' }, {});
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.[0]).toBe('bash');
    expect(cmds[0]?.[1]).toBe('-c');
    expect(cmds[0]?.[2]).toContain('curl');
    expect(cmds[0]?.[2]).toContain(BINARY_INSTALLER_URL);
    expect(cmds[0]?.[2]).toContain('| bash');
  });

  test('binary mode ignores skipUninstall / installUrl / ref', () => {
    const cmds = buildUpgradeCommands(
      {
        mode: 'binary',
        skipUninstall: true,
        installUrl: 'git+ssh://git@example.com/fork.git',
        ref: 'v0.3.0',
      },
      {},
    );
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.[2]).toContain(BINARY_INSTALLER_URL);
    expect(cmds[0]?.[2]).not.toContain('fork.git');
    expect(cmds[0]?.[2]).not.toContain('v0.3.0');
  });

  test('explicit mode "source" preserves the source-checkout behavior', () => {
    const cmds = buildUpgradeCommands(
      { mode: 'source', sourceDir: '/tmp/sov-source-checkout' },
      {},
    );
    expect(cmds.length).toBe(7);
    expect(cmds[0]).toEqual(['bun', 'uninstall', '-g', PACKAGE_NAME]);
    expect(cmds.at(-1)).toEqual(['bun', 'link']);
  });
});

describe('runUpgrade — binary mode', () => {
  test('dry-run prints the curl|bash command without source-mode cache messaging', () => {
    const chunks: string[] = [];
    const errChunks: string[] = [];
    const out = {
      write: (c: string) => {
        chunks.push(c);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const err = {
      write: (c: string) => {
        errChunks.push(c);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const result = runUpgrade({ mode: 'binary', dryRun: true }, out, err);
    expect(result.exitCode).toBe(0);
    const stdout = chunks.join('');
    expect(stdout).toContain('would run: bash -c');
    expect(stdout).toContain(BINARY_INSTALLER_URL);
    // Binary mode doesn't touch Bun's cache; neither "would purge:"
    // nor "would skip cache purge (--keep-cache)" should appear — both
    // are source-mode wording.
    expect(stdout).not.toContain('would purge');
    expect(stdout).not.toContain('would skip cache purge');
  });
});
