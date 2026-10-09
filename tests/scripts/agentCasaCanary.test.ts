import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function canary(report: unknown) {
  const scratch = mkdtempSync(join(tmpdir(), 'sov-casa-runner-fixture-'));
  try {
    const source = join(scratch, 'consumer');
    const runner = join(scratch, 'scripts/canary');
    const commands = join(scratch, 'commands');
    for (const path of [source, runner, commands, join(scratch, 'packages/sdk')])
      mkdirSync(path, { recursive: true });
    copyFileSync(resolve('scripts/canary/run-agent-casa-canary.mjs'), join(runner, 'runner.mjs'));
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'real-estate-agent-runtime' }),
    );
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, 'add', 'package.json']);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'fixture',
    ]);
    const fakeNpm = join(commands, 'npm');
    writeFileSync(
      fakeNpm,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'pack') console.log(JSON.stringify([{filename:'fixture.tgz'}]));
if (args[0] === 'install') {
  const target=path.join(process.cwd(),'node_modules/@yevgetman/sov-sdk');
  fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({version:'fixture'}));
}
if (args[0] === 'test') console.log(${JSON.stringify(JSON.stringify(report))});
`,
    );
    chmodSync(fakeNpm, 0o755);
    return spawnSync('node', [join(runner, 'runner.mjs'), source], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${commands}:${process.env.PATH}` },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
describe('actual consumer canary result validation', () => {
  test('rejects empty, missing or inconsistent test evidence', () => {
    expect(
      canary({
        success: true,
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
      }).status,
    ).not.toBe(0);
    expect(canary({ success: true, numFailedTests: 0 }).status).not.toBe(0);
    expect(
      canary({
        success: true,
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
      }).status,
    ).not.toBe(0);
  });
  test('accepts a nonempty passing suite', () => {
    const result = canary({
      success: true,
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 1,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"passed":2');
  });
});
