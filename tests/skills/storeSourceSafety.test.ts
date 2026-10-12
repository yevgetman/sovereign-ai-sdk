import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSkillSourceFile, readSkillSourceTree } from '@yevgetman/sov-sdk/skills/store';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sov-source-review-')));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runSourceFixture(script: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code, output }));
  });
}

for (const kind of ['tree', 'file']) {
  for (const concealDuringCheck of [false, true]) {
    test(`source ${kind} rejects an ancestor swap restored after capture (${concealDuringCheck ? 'concealed checks' : 'direct swap'})`, async () => {
      const root = join(scratch, 'source');
      const scripts = join(root, 'scripts');
      const parked = join(root, 'parked');
      const outside = join(scratch, 'outside');
      const selected = join(scripts, 'checked.txt');
      await mkdir(scripts, { recursive: true });
      await mkdir(outside);
      await writeFile(join(root, 'SKILL.md'), 'Checked body.');
      await writeFile(selected, 'ACCEPTED_RESOURCE');
      await writeFile(join(outside, 'checked.txt'), 'OUTSIDE_SECRET_FIXTURE');
      const script = `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const scripts=${JSON.stringify(scripts)},parked=${JSON.stringify(parked)},outside=${JSON.stringify(outside)},selected=${JSON.stringify(selected)};
const originalLstat=fsp.lstat,originalOpen=fsp.open;
let swapped=false,restored=false,temporaryRestores=0;
fsp.lstat=async(path,...args)=>{
  if(!swapped && path===selected){swapped=true;fs.renameSync(scripts,parked);fs.symlinkSync(outside,scripts)}
  // An adversary can restore an ancestor only during pathname checks. The
  // captured leaf must still agree with the opened handle after the read.
  if(${concealDuringCheck} && swapped && !restored && path===scripts){
    fs.unlinkSync(scripts);fs.renameSync(parked,scripts);
    const info=await originalLstat(path,...args);
    fs.renameSync(scripts,parked);fs.symlinkSync(outside,scripts);temporaryRestores++;
    return info;
  }
  return originalLstat(path,...args);
};
fsp.open=async(path,...args)=>{
  const handle=await originalOpen(path,...args);
  if(path===selected){const originalRead=handle.read.bind(handle);handle.read=async(...readArgs)=>{
    const result=await originalRead(...readArgs);
    if(!restored){restored=true;fs.unlinkSync(scripts);fs.renameSync(parked,scripts)}
    return result;
  }}
  return handle;
};
syncBuiltinESMExports();
const {readSkillSourceTree,readSkillSourceFile}=await import(${JSON.stringify(resolve('packages/sdk/dist/skills/store.js'))});
try{
  const captured=${kind === 'file' ? 'await readSkillSourceFile(selected)' : `(await readSkillSourceTree(${JSON.stringify(root)})).files.get('scripts/checked.txt').data`};
  console.log(JSON.stringify({swapped,restored,captured:Buffer.from(captured).toString()}));
}catch(error){console.log(JSON.stringify({swapped,restored,temporaryRestores,rejected:String(error)}))}`;
      const result = await runSourceFixture(script);
      expect(result.code).toBe(0);
      const witness = JSON.parse(result.output);
      expect(witness.swapped).toBe(true);
      expect(witness.rejected).toContain('skill source changed during capture');
      expect(witness.captured).toBeUndefined();
      if (concealDuringCheck) {
        expect(witness.restored).toBe(true);
        expect(witness.temporaryRestores).toBeGreaterThan(0);
      }
    });
  }
}

test('stable in-tree source aliases retain captured bytes and modes', async () => {
  const root = join(scratch, 'source');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'SKILL.md'), 'Checked body.');
  await writeFile(join(root, 'scripts', 'checked.txt'), 'ACCEPTED_RESOURCE');
  await chmod(join(root, 'scripts', 'checked.txt'), 0o640);
  await symlink('scripts/checked.txt', join(root, 'alias.txt'));
  await symlink('scripts', join(root, 'alias-directory'));
  const captured = await readSkillSourceTree(root);
  for (const path of ['scripts/checked.txt', 'alias.txt', 'alias-directory/checked.txt']) {
    expect(Buffer.from(captured.files.get(path)?.data ?? []).toString()).toBe('ACCEPTED_RESOURCE');
    expect(captured.files.get(path)?.mode).toBe(0o640);
  }
  expect(Buffer.from(await readSkillSourceFile(join(root, 'alias.txt'))).toString()).toBe(
    'ACCEPTED_RESOURCE',
  );
});
