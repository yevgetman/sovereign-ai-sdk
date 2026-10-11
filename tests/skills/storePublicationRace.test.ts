import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FilesystemSkillStore } from '@yevgetman/sov-sdk/skills/store';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sov-publication-race-')));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const content = '---\nname: note\ndescription: Note workflow\n---\nChecked workflow.\n';

for (const action of ['edit', 'delete'] as const) {
  test(`${action} preserves an out-of-band edit at the backup rename boundary`, async () => {
    const root = join(scratch, 'skills');
    const regular = new FilesystemSkillStore({ root });
    const first = await regular.mutate({ action: 'create', name: 'note', content });
    if (!first.entry) throw new Error('missing initial entry');
    const external = content.replace('Checked workflow.', 'Concurrent owner edit.');
    const script = join(scratch, 'worker.mjs');
    await writeFile(
      script,
      `import fs from 'node:fs';
import {basename,join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const original = {...fs};
let changed=false;
fs.renameSync=(from,to)=>{
  if (!changed && basename(from)==='note' && basename(to).startsWith('.sov-skill-backup-')) {
    changed=true;
    original.writeFileSync(join(from,'SKILL.md'),${JSON.stringify(external)});
  }
  return original.renameSync(from,to);
};
syncBuiltinESMExports();
await import(${JSON.stringify(resolve('packages/sdk/dist/skills/storeWorkerEntry.js'))});`,
    );
    const store = new FilesystemSkillStore({
      root,
      workerCommand: { executable: 'node', args: [script] },
    });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await expect(
      store.mutate({
        action,
        name: 'note',
        expectedRevision: first.entry.revision,
        ...(action === 'edit' ? { content: content.replace('Checked', 'Requested') } : {}),
      }),
    ).rejects.toThrow('skill changed during transaction');
    expect(await readFile(join(root, 'note', 'SKILL.md'), 'utf8')).toBe(external);
    expect((await regular.read('note'))?.content).toBe(external);
    expect(events).toEqual([]);
  });
}

test('publication refuses a recreated owner tree and retains both accepted copies', async () => {
  const root = join(scratch, 'skills');
  const regular = new FilesystemSkillStore({ root });
  const first = await regular.mutate({ action: 'create', name: 'note', content });
  if (!first.entry) throw new Error('missing initial entry');
  const external = content.replace('Checked workflow.', 'New owner tree.');
  const script = join(scratch, 'worker.mjs');
  await writeFile(
    script,
    `import fs from 'node:fs';
import {basename,join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const original = {...fs};
let changed=false;
fs.renameSync=(from,to)=>{
  original.renameSync(from,to);
  if (!changed && basename(from)==='note' && basename(to).startsWith('.sov-skill-backup-')) {
    changed=true;
    original.mkdirSync(from);
    original.writeFileSync(join(from,'SKILL.md'),${JSON.stringify(external)});
  }
};
syncBuiltinESMExports();
await import(${JSON.stringify(resolve('packages/sdk/dist/skills/storeWorkerEntry.js'))});`,
  );
  const store = new FilesystemSkillStore({
    root,
    workerCommand: { executable: 'node', args: [script] },
  });
  const events: unknown[] = [];
  store.subscribe((event) => events.push(event));
  await expect(
    store.mutate({
      action: 'edit',
      name: 'note',
      expectedRevision: first.entry.revision,
      content: content.replace('Checked', 'Requested'),
    }),
  ).rejects.toThrow('recovery conflict');
  expect(await readFile(join(root, 'note', 'SKILL.md'), 'utf8')).toBe(external);
  const backup = (await readdir(root)).find((name) => name.startsWith('.sov-skill-backup-'));
  if (!backup) throw new Error('original accepted tree was not retained');
  expect(await readFile(join(root, backup, 'SKILL.md'), 'utf8')).toBe(content);
  await expect(regular.read('note')).rejects.toThrow('recovery conflict');
  expect(await readFile(join(root, 'note', 'SKILL.md'), 'utf8')).toBe(external);
  expect(events).toEqual([]);
});
