import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemSkillStore, InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sov-store-validation-')));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const content = '---\nname: note\ndescription: Note workflow\n---\nChecked workflow.\n';

for (const mode of [0o000, 0o400, 0o100, 0o050]) {
  test(`directory mode ${mode.toString(8)} is refused before staging or publication`, async () => {
    const root = join(scratch, 'skills');
    for (const store of [new InMemorySkillStore(), new FilesystemSkillStore({ root })]) {
      const events: unknown[] = [];
      store.subscribe((event) => events.push(event));
      await expect(
        store.mutate({
          action: 'create',
          name: 'note',
          content,
          directoryModes: new Map([['hidden', mode]]),
        }),
      ).rejects.toThrow('owner read and execute permissions');
      expect(await store.read('note')).toBeUndefined();
      expect((await store.list()).names).toEqual([]);
      expect(events).toEqual([]);
      const created = await store.mutate({ action: 'create', name: 'note', content });
      expect(created.entry?.content).toBe(content);
    }
    expect((await readdir(root)).filter((name) => name.startsWith('.sov-skill-stage-'))).toEqual(
      [],
    );
  });
}

for (const mode of [0o000, 0o200, 0o040]) {
  test(`file mode ${mode.toString(8)} is refused before accepting an unreadable resource`, async () => {
    const root = join(scratch, 'skills');
    for (const store of [new InMemorySkillStore(), new FilesystemSkillStore({ root })]) {
      await expect(
        store.mutate({
          action: 'create',
          name: 'note',
          content,
          files: new Map([['hidden.txt', { data: Buffer.from('CHECKED_RESOURCE'), mode }]]),
        }),
      ).rejects.toThrow('owner read permission');
      expect(await store.read('note')).toBeUndefined();
      expect((await store.list()).names).toEqual([]);
    }
  });
}

test('read-only resources and directories preserve supported restrictive modes', async () => {
  for (const store of [
    new InMemorySkillStore(),
    new FilesystemSkillStore({ root: join(scratch, 'skills') }),
  ]) {
    const committed = await store.mutate({
      action: 'create',
      name: 'note',
      content,
      files: new Map([
        ['references/checked.txt', { data: Buffer.from('CHECKED_RESOURCE'), mode: 0o440 }],
      ]),
      directoryModes: new Map([['references', 0o550]]),
    });
    if (!committed.entry) throw new Error('missing committed entry');
    expect((await store.read('note'))?.revision).toBe(committed.entry.revision);
    expect(committed.entry.files.get('references/checked.txt')?.mode).toBe(0o440);
    expect(committed.entry.directoryModes?.get('references')).toBe(0o550);
    await store.mutate({
      action: 'delete',
      name: 'note',
      expectedRevision: committed.entry.revision,
    });
    expect(await store.read('note')).toBeUndefined();
  }
});

for (const resource of ['__proto__/run.sh', 'constructor/run.sh', 'toString/run.sh']) {
  test(`implicit ${resource} parent belongs to the complete tree in both stores`, async () => {
    for (const store of [
      new InMemorySkillStore(),
      new FilesystemSkillStore({ root: join(scratch, 'skills') }),
    ]) {
      const created = await store.mutate({
        action: 'create',
        name: 'note',
        content,
        files: new Map([[resource, { data: Buffer.from('echo CHECKED_RESOURCE') }]]),
      });
      if (!created.entry) throw new Error('missing committed entry');
      expect(created.entry.directoryModes?.get(resource.split('/')[0] ?? '')).toBe(0o700);
      expect((await store.read('note'))?.revision).toBe(created.entry.revision);
      const edited = await store.mutate({
        action: 'edit',
        name: 'note',
        content: content.replace('Checked', 'Updated'),
        expectedRevision: created.entry.revision,
      });
      expect((await store.read('note'))?.revision).toBe(edited.entry?.revision);
    }
  });
}
