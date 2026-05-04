// `sov upgrade` — argv builder + dry-run path. Live spawn paths are not
// exercised in unit tests (they would actually re-install the binary).

import { describe, expect, test } from 'bun:test';
import { DEFAULT_INSTALL_URL, buildUpgradeCommand, runUpgrade } from '../../src/cli/upgrade.js';

describe('buildUpgradeCommand', () => {
  test('uses the default install URL when no ref or override is set', () => {
    const cmd = buildUpgradeCommand({}, {});
    expect(cmd).toEqual(['bun', 'install', '-g', DEFAULT_INSTALL_URL]);
  });

  test('appends a ref via the standard git #fragment form', () => {
    const cmd = buildUpgradeCommand({ ref: 'v0.2.0' }, {});
    expect(cmd[3]).toBe(`${DEFAULT_INSTALL_URL}#v0.2.0`);
  });

  test('honors the SOV_UPGRADE_URL env override', () => {
    const cmd = buildUpgradeCommand({}, { SOV_UPGRADE_URL: 'git+ssh://git@example.com/fork.git' });
    expect(cmd[3]).toBe('git+ssh://git@example.com/fork.git');
  });

  test('opts.installUrl wins over the env var', () => {
    const cmd = buildUpgradeCommand(
      { installUrl: 'git+ssh://git@example.com/from-opt.git' },
      { SOV_UPGRADE_URL: 'git+ssh://git@example.com/from-env.git' },
    );
    expect(cmd[3]).toBe('git+ssh://git@example.com/from-opt.git');
  });

  test('ref is concatenated to the override, not the default', () => {
    const cmd = buildUpgradeCommand({
      ref: 'feature-branch',
      installUrl: 'git+ssh://git@example.com/fork.git',
    });
    expect(cmd[3]).toBe('git+ssh://git@example.com/fork.git#feature-branch');
  });
});

describe('runUpgrade', () => {
  test('dry-run prints the command without spawning anything', () => {
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
    expect(result.command).toEqual(['bun', 'install', '-g', `${DEFAULT_INSTALL_URL}#v0.2.0`]);
    expect(chunks.join('')).toContain('would run:');
    expect(chunks.join('')).toContain(`${DEFAULT_INSTALL_URL}#v0.2.0`);
    expect(errChunks).toEqual([]);
  });
});
