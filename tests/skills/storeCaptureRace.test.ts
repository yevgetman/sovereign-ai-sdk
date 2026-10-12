import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FilesystemSkillStore } from '@yevgetman/sov-sdk/skills/store';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sov-store-capture-')));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const content = '---\nname: note\ndescription: Note workflow\n---\nChecked workflow.\n';

for (const action of ['create', 'edit'] as const) {
  for (const change of ['replace-leaf', 'change-mode', 'change-earlier-leaf', 'add-resource']) {
    test(`${action} rejects ${change} during final publication capture without a receipt`, async () => {
      const root = join(scratch, 'skills');
      const regular = new FilesystemSkillStore({ root });
      const previous =
        action === 'edit'
          ? (await regular.mutate({ action: 'create', name: 'note', content })).entry
          : undefined;
      const script = join(scratch, 'worker.mjs');
      await writeFile(
        script,
        `import fs from 'node:fs';
import {basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const original={...fs};let published=false,changed=false;
fs.renameSync=(from,to)=>{
  const result=original.renameSync(from,to);
  if(basename(from).startsWith('.sov-skill-stage-')&&basename(to)==='note')published=true;
  return result;
};
fs.openSync=(path,...args)=>{
  const fd=original.openSync(path,...args);
  if(published&&!changed&&path===${JSON.stringify(change === 'change-earlier-leaf' ? 'z-last.txt' : 'SKILL.md')}) {
    changed=true;
    const change=${JSON.stringify(change)};
    if(change==='replace-leaf') {
      original.renameSync('SKILL.md','parked.md');
      original.writeFileSync('SKILL.md',${JSON.stringify(content.replace('Checked workflow.', 'Unaccepted replacement.'))});
      original.unlinkSync('parked.md');
    } else if(change==='change-mode') original.chmodSync('SKILL.md',0o644);
    else if(change==='change-earlier-leaf') original.writeFileSync('SKILL.md',${JSON.stringify(content.replace('Checked workflow.', 'Unaccepted earlier edit.'))});
    else original.writeFileSync('unexpected.txt','UNACCEPTED_RESOURCE');
  }
  return fd;
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
          content,
          files: new Map([['z-last.txt', { data: Buffer.from('CHECKED_RESOURCE') }]]),
          ...(previous ? { expectedRevision: previous.revision } : {}),
        }),
      ).rejects.toThrow('changed during capture');
      expect((await regular.read('note'))?.revision).toBe(previous?.revision);
      if (previous) expect(await readFile(join(root, 'note', 'SKILL.md'), 'utf8')).toBe(content);
      expect(events).toEqual([]);
      expect((await regular.list()).names).toEqual(previous ? ['note'] : []);
      expect(
        (await readdir(root)).filter(
          (name) => name.startsWith('.sov-skill-stage-') || name.startsWith('.sov-skill-backup-'),
        ),
      ).toEqual([]);
    });
  }
}
