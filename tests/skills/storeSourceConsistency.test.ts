import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sov-source-consistency-')));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const content = '---\nname: note\ndescription: Note workflow\n---\nChecked workflow.\n';

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

for (const operation of ['capture', 'install', 'import']) {
  test(`${operation} refuses an earlier source leaf changed while reading a later resource`, async () => {
    const source = join(scratch, 'source');
    const skills = join(scratch, 'skills');
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), content);
    await writeFile(join(source, 'z-last.txt'), 'CHECKED_RESOURCE');
    const script = `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const source=${JSON.stringify(source)},skills=${JSON.stringify(skills)};
const originalOpen=fsp.open;let changed=false;
fsp.open=async(path,...args)=>{
  const file=await originalOpen(path,...args);
  if(!changed && path===source+'/z-last.txt'){
    changed=true;fs.writeFileSync(source+'/SKILL.md',${JSON.stringify(content.replace('Checked workflow.', 'Updated workflow.'))});
  }
  return file;
};
syncBuiltinESMExports();
const {readSkillSourceTree,InMemorySkillStore}=await import(${JSON.stringify(resolve('packages/sdk/dist/skills/store.js'))});
const {installSkill,importSkill}=await import(${JSON.stringify(resolve('packages/sdk/dist/skills/install.js'))});
const store=new InMemorySkillStore(),events=[];store.subscribe(event=>events.push(event));
try{
  const result=${operation === 'capture' ? 'await readSkillSourceTree(source)' : `${operation}Skill({source,userSkillsRoot:skills,store})`};
  const settled=await result;
  console.log(JSON.stringify({changed,ok:settled.ok,reason:settled.reason,entry:await store.read('note'),events,captured:!!settled.files}));
}catch(error){console.log(JSON.stringify({changed,rejected:String(error),entry:await store.read('note'),events}))}`;
    const result = await runSourceFixture(script);
    expect(result.code).toBe(0);
    const witness = JSON.parse(result.output);
    expect(witness.changed).toBe(true);
    expect(witness.rejected ?? witness.reason).toContain('skill source changed during capture');
    expect(witness.ok).not.toBe(true);
    expect(witness.captured).not.toBe(true);
    expect(witness.entry).toBeUndefined();
    expect(witness.events).toEqual([]);
  });
}

test('import normalizes the same captured source revision as its sidecars', async () => {
  const source = join(scratch, 'source');
  const skills = join(scratch, 'skills');
  const current = content.replace(
    'description: Note workflow',
    'description: Note workflow\nreadOnly: true',
  );
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), content);
  await writeFile(join(source, 'z-last.txt'), 'CHECKED_RESOURCE');
  const script = `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const source=${JSON.stringify(source)},skills=${JSON.stringify(skills)};
const originalRealpath=fsp.realpath;let captured=false;
fsp.realpath=async(path,...args)=>{
  if(!captured && path===source){
    captured=true;fs.writeFileSync(source+'/SKILL.md',${JSON.stringify(current)});
  }
  return originalRealpath(path,...args);
};
syncBuiltinESMExports();
const {InMemorySkillStore}=await import(${JSON.stringify(resolve('packages/sdk/dist/skills/store.js'))});
const {importSkill}=await import(${JSON.stringify(resolve('packages/sdk/dist/skills/install.js'))});
const store=new InMemorySkillStore();
const result=await importSkill({source,userSkillsRoot:skills,store});
console.log(JSON.stringify({captured,result,entry:await store.read('note')}));`;
  const result = await runSourceFixture(script);
  expect(result.code).toBe(0);
  const witness = JSON.parse(result.output);
  expect(witness.captured).toBe(true);
  expect(witness.result.ok).toBe(true);
  expect(witness.entry.content).toContain('readOnly: true');
});

for (const operation of ['install', 'import']) {
  test(`${operation} refuses single-file source modes changed between selection and capture`, async () => {
    const source = join(scratch, 'SKILL.md');
    await writeFile(source, content, { mode: 0o644 });
    const script = `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const source=${JSON.stringify(source)};
const originalStat=fsp.stat;let selections=0,changed=false;
fsp.stat=async(path,...args)=>{
  const info=await originalStat(path,...args);
  if(path===source && ++selections===2){changed=true;fs.chmodSync(source,0o400)}
  return info;
};
syncBuiltinESMExports();
const {InMemorySkillStore}=await import(${JSON.stringify(resolve('packages/sdk/dist/skills/store.js'))});
const {${operation}Skill}=await import(${JSON.stringify(resolve('packages/sdk/dist/skills/install.js'))});
const store=new InMemorySkillStore(),events=[];store.subscribe(event=>events.push(event));
const result=await ${operation}Skill({source,userSkillsRoot:${JSON.stringify(join(scratch, 'skills'))},store});
console.log(JSON.stringify({changed,result,entry:await store.read('note'),events}));`;
    const result = await runSourceFixture(script);
    expect(result.code).toBe(0);
    const witness = JSON.parse(result.output);
    expect(witness.changed).toBe(true);
    expect(witness.result.ok).toBe(false);
    expect(witness.result.reason).toContain('skill source changed during capture');
    expect(witness.entry).toBeUndefined();
    expect(witness.events).toEqual([]);
  });
}
