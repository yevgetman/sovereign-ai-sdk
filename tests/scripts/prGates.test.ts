import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function gates(apply: boolean, wrongSource = false, wrongBinding = false) {
  const scratch = mkdtempSync(join(tmpdir(), 'sov-pr-rule-fixture-'));
  try {
    const script = join(scratch, 'gates.mjs');
    copyFileSync(resolve('scripts/enable-pr-gates.mjs'), script);
    const preview = spawnSync('node', [script], { encoding: 'utf8' });
    const names = JSON.parse(preview.stdout).protection.required_status_checks.checks.map(
      (check: { context: string }) => check.context,
    );
    const command = join(scratch, 'gh');
    const calls = join(scratch, 'calls.jsonl');
    const results = names.map((name: string, id: number) => ({
      name,
      id,
      status: 'completed',
      conclusion: 'success',
      app: { slug: wrongSource ? 'other-app' : 'github-actions', id: 15368 },
    }));
    writeFileSync(
      command,
      `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.includes('PUT')) {
  let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
    const result=JSON.parse(input);result.enforce_admins={enabled:result.enforce_admins};
    result.allow_force_pushes={enabled:false};result.allow_deletions={enabled:false};
    if(${wrongBinding}) result.required_status_checks.checks[0].app_id=999;
    console.log(JSON.stringify(result));
  });
} else if(args.some(arg=>arg.includes('check-runs'))) console.log(JSON.stringify({check_runs:${JSON.stringify(results)}}));
else console.log(JSON.stringify({sha:'fixture-master'}));
`,
    );
    chmodSync(command, 0o755);
    mkdirSync(join(scratch, 'unused'));
    const result = spawnSync('node', [script, ...(apply ? ['--apply'] : [])], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` },
    });
    let requests: string[][] = [];
    try {
      requests = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch {}
    return { result, requests };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
describe('PR rule activation guard', () => {
  test('preview does not contact GitHub', () => {
    const { result, requests } = gates(false);
    expect(result.status).toBe(0);
    expect(requests).toHaveLength(0);
  });
  test('rejects success from a different check app before mutation', () => {
    const { result, requests } = gates(true, true);
    expect(result.status).not.toBe(0);
    expect(requests.some((args) => args.includes('PUT'))).toBe(false);
  });
  test('checks the effective returned app binding', () => {
    expect(gates(true, false, true).result.status).not.toBe(0);
    expect(gates(true).result.status).toBe(0);
  });
});
