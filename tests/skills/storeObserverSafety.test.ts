import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const content = '---\nname: note\ndescription: Note workflow\n---\nUse the checked workflow.\n';

test('Node contains rejected asynchronous committed-store observers', async () => {
  const module = resolve('packages/sdk/dist/skills/store.js');
  const script = `import {InMemorySkillStore} from ${JSON.stringify(module)};
const store=new InMemorySkillStore();store.subscribe(async()=>{throw Error('OBSERVER_FAILURE')});
await store.mutate({action:'create',name:'note',content:${JSON.stringify(content)}});
await new Promise(resolve=>setTimeout(resolve,25));
console.log('COMMIT_RETAINED',Boolean(await store.read('note')));`;
  const result = await new Promise<{ code: number | null; output: string }>(
    (resolveResult, reject) => {
      const child = spawn(
        'node',
        ['--unhandled-rejections=strict', '--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolveResult({ code, output }));
    },
  );
  expect(result.output).toContain('COMMIT_RETAINED true');
  expect(result.code).toBe(0);
});
