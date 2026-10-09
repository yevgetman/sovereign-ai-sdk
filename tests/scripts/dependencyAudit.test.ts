import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function audit(report: unknown, status = 0, exceptions: unknown[] = []) {
  const scratch = mkdtempSync(join(tmpdir(), 'sov-audit-fixture-'));
  try {
    mkdirSync(join(scratch, 'security'));
    copyFileSync(resolve('scripts/dependency-audit.mjs'), join(scratch, 'audit.mjs'));
    writeFileSync(join(scratch, 'security/dependency-exceptions.json'), JSON.stringify(exceptions));
    const fakeBun = join(scratch, 'bun');
    writeFileSync(
      fakeBun,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exit(${status});\n`,
    );
    chmodSync(fakeBun, 0o755);
    return spawnSync('node', [join(scratch, 'audit.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
const advisory = { severity: 'high', url: 'https://github.com/advisories/GHSA-abcd-1234-efgh' };
describe('dependency advisory gate', () => {
  test('accepts a clean successful registry report', () => expect(audit({}).status).toBe(0));
  test('rejects a registry failure disguised as an empty report', () =>
    expect(audit({}, 1).status).not.toBe(0));
  test('rejects unknown schema and severity', () => {
    expect(audit([]).status).not.toBe(0);
    expect(audit({ pkg: [{ ...advisory, severity: 'unrecognized' }] }).status).not.toBe(0);
  });
  test('blocks high advisories and permits lower severity reports', () => {
    expect(audit({ pkg: [advisory] }, 1).status).toBe(1);
    expect(audit({ pkg: [{ ...advisory, severity: 'moderate' }] }, 1).status).toBe(0);
  });
  test('requires a specific unexpired, documented exception', () => {
    const expires = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const entry = {
      package: 'pkg',
      advisory: 'GHSA-abcd-1234-efgh',
      expires,
      reason: 'Fixture only',
    };
    expect(audit({ pkg: [advisory] }, 1, [entry]).status).toBe(0);
    expect(audit({ pkg: [advisory] }, 1, [{ ...entry, package: 'other' }]).status).toBe(1);
    expect(audit({}, 0, [{ ...entry, expires: '2000-01-01' }]).status).not.toBe(0);
    expect(audit({}, 0, [{ ...entry, expires: '2099-99-99' }]).status).not.toBe(0);
  });
});
