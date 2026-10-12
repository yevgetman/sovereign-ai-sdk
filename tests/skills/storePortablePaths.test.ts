import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemSkillStore, InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sov-portable-resource-')));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const content = '---\nname: note\ndescription: Note workflow\n---\nChecked workflow.\n';

test('Windows drive-relative resource selects a drive directory outside the stage', () => {
  const result = spawnSync('node', [
    '--input-type=module',
    '-e',
    `import {win32} from 'node:path';
console.log(JSON.stringify({directory:win32.dirname('D:outside.txt'),leaf:win32.basename('D:outside.txt'),resolved:win32.resolve('C:\\\\store\\\\stage','D:outside.txt')}));`,
  ]);
  expect(result.status).toBe(0);
  const witness = JSON.parse(result.stdout.toString());
  expect(witness.directory).toBe('D:');
  expect(witness.leaf).toBe('outside.txt');
  expect(witness.resolved.startsWith('D:\\')).toBe(true);
});

for (const resource of [
  'D:outside.txt',
  'D:/outside.txt',
  'SKILL.md:private',
  'references/D:outside.txt',
  'references/guide.txt:private',
]) {
  for (const treeEntry of ['file', 'directory']) {
    test(`${treeEntry} ${resource} refuses before store creation or a committed event`, async () => {
      const root = join(scratch, 'skills');
      for (const store of [new InMemorySkillStore(), new FilesystemSkillStore({ root })]) {
        const events: unknown[] = [];
        store.subscribe((event) => events.push(event));
        await expect(
          store.mutate({
            action: 'create',
            name: 'note',
            content,
            ...(treeEntry === 'file'
              ? { files: new Map([[resource, { data: Buffer.from('CHECKED_RESOURCE') }]]) }
              : { directoryModes: new Map([[resource, 0o700]]) }),
          }),
        ).rejects.toThrow('unsafe skill resource path');
        expect(existsSync(root)).toBe(false);
        expect(events).toEqual([]);
      }
    });
  }
}

for (const resource of ['D:outside.txt', 'SKILL.md:private']) {
  test(`refused ${resource} edit retains the accepted complete revision`, async () => {
    for (const store of [
      new InMemorySkillStore(),
      new FilesystemSkillStore({ root: join(scratch, 'skills') }),
    ]) {
      const created = await store.mutate({ action: 'create', name: 'note', content });
      if (!created.entry) throw new Error('missing accepted entry');
      const events: unknown[] = [];
      store.subscribe((event) => events.push(event));
      await expect(
        store.mutate({
          action: 'edit',
          name: 'note',
          expectedRevision: created.entry.revision,
          files: new Map([[resource, { data: Buffer.from('CHECKED_RESOURCE') }]]),
          content,
        }),
      ).rejects.toThrow('unsafe skill resource path');
      expect((await store.read('note'))?.revision).toBe(created.entry.revision);
      expect(events).toEqual([]);
    }
  });
}
