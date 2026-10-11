import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FilesystemSkillStore, InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sov-storage-review-')));
});
afterEach(async () => {
  const permitFixtureCleanup = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(path, 0o700);
    for (const child of await readdir(path)) await permitFixtureCleanup(join(path, child));
  };
  await permitFixtureCleanup(scratch);
  await rm(scratch, { recursive: true, force: true });
});
const content = '---\nname: note\ndescription: Note workflow\n---\nUse the checked workflow.\n';

async function instrumentedStore(root: string, instrumentation: string) {
  const script = join(scratch, 'worker.mjs');
  await writeFile(
    script,
    `import fs from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const original = {...fs};
${instrumentation}
syncBuiltinESMExports();
await import(${JSON.stringify(resolve('packages/sdk/dist/skills/storeWorkerEntry.js'))});`,
  );
  return new FilesystemSkillStore({ root, workerCommand: { executable: 'node', args: [script] } });
}

test.skipIf(process.platform === 'win32')(
  'a regular resource swapped to a FIFO fails without blocking',
  async () => {
    const root = join(scratch, 'skills');
    await new FilesystemSkillStore({ root }).mutate({
      action: 'create',
      name: 'note',
      content,
      files: new Map([['checked.txt', { data: Buffer.from('CHECKED') }]]),
    });
    const store = await instrumentedStore(
      root,
      `const {spawnSync}=await import('node:child_process');let swapped=false;
    fs.openSync=(path,...args)=>{
      if(!swapped && basename(typeof path==='string'?path:'')==='checked.txt') {
        swapped=true;original.unlinkSync(path);const result=spawnSync('mkfifo',[path]);if(result.status!==0)throw Error('mkfifo fixture failed');
      }
      return original.openSync(path,...args);
    };`,
    );
    await expect(store.read('note')).rejects.toThrow('skill resource changed during capture');
  },
  30_000,
);

test('complete directory modes include implicit parents and preserve immediate CAS', async () => {
  for (const store of [
    new InMemorySkillStore(),
    new FilesystemSkillStore({ root: join(scratch, 'skills') }),
  ]) {
    const first = await store.mutate({
      action: 'create',
      name: 'note',
      content,
      directoryModes: new Map([['one/two/three', 0o750]]),
    });
    if (!first.entry) throw new Error('missing committed entry');
    expect((await store.read('note'))?.revision).toBe(first.entry?.revision);
    expect(first.entry?.directoryModes?.get('one')).toBe(0o700);
    expect(first.entry?.directoryModes?.get('one/two')).toBe(0o700);
    await store.mutate({
      action: 'delete',
      name: 'note',
      expectedRevision: first.entry.revision,
    });
    expect(await store.read('note')).toBeUndefined();
  }
});

test('file-directory conflicts reject identically before accepting a tree', async () => {
  for (const store of [
    new InMemorySkillStore(),
    new FilesystemSkillStore({ root: join(scratch, 'skills') }),
  ]) {
    await expect(
      store.mutate({
        action: 'create',
        name: 'note',
        content,
        files: new Map([['one', { data: Buffer.from('resource') }]]),
        directoryModes: new Map([['one/two', 0o700]]),
      }),
    ).rejects.toThrow('both file and directory');
    expect(await store.read('note')).toBeUndefined();
  }
});

test('a nested directory swap during capture never returns outside bytes', async () => {
  const root = join(scratch, 'skills');
  const scripts = join(root, 'note', 'scripts');
  const parked = join(root, 'note', 'parked');
  const outside = join(scratch, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_SECRET');
  await new FilesystemSkillStore({ root }).mutate({
    action: 'create',
    name: 'note',
    content,
    files: new Map([['scripts/checked.txt', { data: Buffer.from('CHECKED_RESOURCE') }]]),
  });
  const store = await instrumentedStore(
    root,
    `let swapped = false;
fs.readdirSync = (path,...args) => {
  if (!swapped && original.realpathSync(path) === ${JSON.stringify(scripts)}) {
    swapped = true;
    original.renameSync(${JSON.stringify(scripts)},${JSON.stringify(parked)});
    original.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(scripts)});
  }
  return original.readdirSync(path,...args);
};`,
  );
  await expect(store.read('note')).rejects.toThrow('unsafe store directory');
  expect(await readFile(join(parked, 'checked.txt'), 'utf8')).toBe('CHECKED_RESOURCE');
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('OUTSIDE_SECRET');
});

test('durable publication syncs nested directories, transaction parent and backup', async () => {
  const root = join(scratch, 'skills');
  await new FilesystemSkillStore({ root }).mutate({ action: 'create', name: 'note', content });
  const previous = await new FilesystemSkillStore({ root }).read('note');
  if (!previous) throw new Error('missing accepted entry');
  const log = join(scratch, 'sync-events.json');
  const store = await instrumentedStore(
    root,
    `const events = [];
const handles = new Map();
fs.openSync = (path,...args) => { const fd = original.openSync(path,...args); if(typeof path === 'string') handles.set(fd,resolve(path)); return fd; };
fs.closeSync = fd => { handles.delete(fd); return original.closeSync(fd); };
fs.fsyncSync = fd => { events.push({op:'sync',path:handles.get(fd)}); return original.fsyncSync(fd); };
fs.renameSync = (from,to) => { events.push({op:'rename',from:resolve(from),to:resolve(to)}); original.writeFileSync(${JSON.stringify(log)},JSON.stringify(events)); return original.renameSync(from,to); };`,
  );
  const next = await store.mutate({
    action: 'edit',
    name: 'note',
    expectedRevision: previous.revision,
    files: new Map([['scripts/nested/checked.txt', { data: Buffer.from('CHECKED') }]]),
    content,
  });
  const events = JSON.parse(await readFile(log, 'utf8')) as {
    op: string;
    path?: string;
    from?: string;
    to?: string;
  }[];
  const backupIndex = events.findIndex((event) => event.to?.includes('/.sov-skill-backup-'));
  const publishIndex = events.findIndex((event) => event.from?.includes('/.sov-skill-stage-'));
  const beforeBackup = events.slice(0, backupIndex);
  expect(beforeBackup.some((event) => event.path === join(root, '.sov-skill-store'))).toBe(true);
  expect(beforeBackup.some((event) => event.path?.endsWith('/scripts/nested'))).toBe(true);
  expect(beforeBackup.some((event) => event.path?.endsWith('/scripts'))).toBe(true);
  expect(events.slice(backupIndex + 1, publishIndex).some((event) => event.path === root)).toBe(
    true,
  );
  expect((await new FilesystemSkillStore({ root }).read('note'))?.revision).toBe(
    next.entry?.revision,
  );
});

test('the first write syncs every newly created root ancestor before descent', async () => {
  const root = join(scratch, 'new', 'ancestor', 'skills');
  const store = await instrumentedStore(
    root,
    `const roots=new Set(${JSON.stringify([join(scratch, 'new'), join(scratch, 'new', 'ancestor'), root])});
    const created=new Set(),synced=new Set(),handles=new Map();
    const chdir=process.chdir.bind(process);
    fs.mkdirSync=(path,...args)=>{const value=original.mkdirSync(path,...args);const absolute=resolve(path);if(roots.has(absolute))created.add(absolute);return value;};
    fs.openSync=(path,...args)=>{const fd=original.openSync(path,...args);if(typeof path==='string')handles.set(fd,resolve(path));return fd;};
    fs.fsyncSync=fd=>{synced.add(handles.get(fd));return original.fsyncSync(fd);};
    process.chdir=path=>{const absolute=resolve(path);if(created.has(absolute)&&!synced.has(dirname(absolute)))throw Error('MISSING_ROOT_PARENT_SYNC');return chdir(path);};`,
  );
  expect((await store.mutate({ action: 'create', name: 'note', content })).entry?.content).toBe(
    content,
  );
});

test('an internal directory replacement cannot redirect staging or lock cleanup', async () => {
  const root = join(scratch, 'skills');
  const outside = join(scratch, 'outside');
  const internal = join(root, '.sov-skill-store');
  await mkdir(outside);
  await writeFile(join(outside, 'lock'), 'OUTSIDE_LOCK_SENTINEL');
  const store = await instrumentedStore(
    root,
    `let swapped = false;
fs.mkdirSync = (path,...args) => {
  const result = original.mkdirSync(path,...args);
  if(!swapped && /^txn-[a-f0-9-]+$/.test(basename(path))) {
    swapped = true;
    original.mkdirSync(${JSON.stringify(outside)}+'/'+basename(path));
    original.renameSync(${JSON.stringify(internal)},${JSON.stringify(join(root, 'parked-internal'))});
    original.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(internal)});
  }
  return result;
};`,
  );
  await expect(store.mutate({ action: 'create', name: 'note', content })).rejects.toThrow();
  expect(await readFile(join(outside, 'lock'), 'utf8')).toBe('OUTSIDE_LOCK_SENTINEL');
  const transaction = (await readdir(outside)).find((name) => name.startsWith('txn-'));
  if (!transaction) throw new Error('instrumentation did not replace internal directory');
  expect(await readdir(join(outside, transaction))).toEqual([]);
});

test('failed parent restoration performs no lock cleanup in the replacement root', async () => {
  const root = join(scratch, 'skills');
  const outside = join(scratch, 'outside');
  await mkdir(join(outside, 'note', 'scripts'), { recursive: true });
  await mkdir(join(outside, '.sov-skill-store'));
  await writeFile(join(outside, '.sov-skill-store', 'lock'), 'OUTSIDE_LOCK_SENTINEL');
  await new FilesystemSkillStore({ root }).mutate({
    action: 'create',
    name: 'note',
    content,
    files: new Map([['scripts/checked.txt', { data: Buffer.from('SAFE') }]]),
  });
  const store = await instrumentedStore(
    root,
    `let swapped=false;
fs.readdirSync = (path,...args) => {
  if(!swapped && original.realpathSync(path) === ${JSON.stringify(join(root, 'note', 'scripts'))}) {
    swapped=true;
    original.renameSync(${JSON.stringify(root)},${JSON.stringify(join(scratch, 'parked-root'))});
    original.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(root)});
  }
  return original.readdirSync(path,...args);
};`,
  );
  await expect(store.read('note')).rejects.toThrow('parent directory changed');
  expect(await readFile(join(outside, '.sov-skill-store', 'lock'), 'utf8')).toBe(
    'OUTSIDE_LOCK_SENTINEL',
  );
  const recovered = new FilesystemSkillStore({ root: join(scratch, 'parked-root') });
  expect((await recovered.read('note'))?.content).toBe(content);
  expect((await readdir(join(scratch, 'parked-root', '.sov-skill-store'))).includes('lock')).toBe(
    false,
  );
});

for (const boundary of [
  'edit-prepared',
  'edit-published',
  'create-prepared',
  'create-published',
  'delete-prepared',
  'delete-committed',
] as const) {
  test(`a killed ${boundary} worker recovers its accepted tree and restrictive modes`, async () => {
    const root = join(scratch, 'skills');
    const regular = new FilesystemSkillStore({ root });
    const action = boundary.startsWith('edit')
      ? 'edit'
      : boundary.startsWith('delete')
        ? 'delete'
        : 'create';
    const initial =
      action === 'create'
        ? undefined
        : (
            await regular.mutate({
              action: 'create',
              name: 'note',
              content,
              files: new Map([
                ['scripts/checked.txt', { data: Buffer.from('CHECKED'), mode: 0o440 }],
              ]),
              directoryModes: new Map([
                ['', 0o750],
                ['scripts', 0o550],
              ]),
            })
          ).entry;
    const store = await instrumentedStore(
      root,
      `fs.renameSync = (from,to) => {
      original.renameSync(from,to);
      const boundary=${JSON.stringify(boundary)};
      const backup=basename(to).startsWith('.sov-skill-backup-');
      const published=basename(from).startsWith('.sov-skill-stage-') && basename(to)==='note';
      const journal=basename(to)==='journal.json' ? JSON.parse(original.readFileSync(to,'utf8')) : undefined;
      if((boundary==='edit-prepared'||boundary==='delete-prepared') && backup ||
        (boundary==='edit-published'||boundary==='create-published') && published ||
        boundary==='create-prepared' && journal?.phase==='prepared' ||
        boundary==='delete-committed' && journal?.phase==='committed') process.kill(process.pid,'SIGKILL');
    };`,
    );
    await expect(
      store.mutate({
        action,
        name: 'note',
        ...(action !== 'delete'
          ? {
              content: content.replace('checked workflow', 'NEW checked workflow'),
              directoryModes: new Map([['', 0o750]]),
            }
          : {}),
        ...(initial ? { expectedRevision: initial.revision } : {}),
      }),
    ).rejects.toThrow();
    const recovered = await regular.read('note');
    const published = boundary.endsWith('published');
    if (boundary === 'create-prepared' || boundary === 'delete-committed')
      expect(recovered).toBeUndefined();
    else {
      expect(recovered?.content).toBe(
        published ? content.replace('checked workflow', 'NEW checked workflow') : content,
      );
      expect(recovered?.directoryModes?.get('')).toBe(0o750);
      if (initial) {
        expect(recovered?.directoryModes?.get('scripts')).toBe(0o550);
        expect(recovered?.files.get('scripts/checked.txt')?.mode).toBe(0o440);
      }
    }
    expect((await regular.list()).names).toEqual(recovered ? ['note'] : []);
    expect(
      (await readdir(root)).filter(
        (name) => name.startsWith('.sov-skill-stage-') || name.startsWith('.sov-skill-backup-'),
      ),
    ).toEqual([]);
  });
}

test('a failed sync after publication rolls back without emitting a commit', async () => {
  const root = join(scratch, 'skills');
  const regular = new FilesystemSkillStore({ root });
  const first = await regular.mutate({ action: 'create', name: 'note', content });
  if (!first.entry) throw new Error('missing accepted entry');
  const store = await instrumentedStore(
    root,
    `let published=false,failed=false;
    fs.renameSync=(from,to)=>{original.renameSync(from,to);if(basename(from).startsWith('.sov-skill-stage-')&&basename(to)==='note')published=true;};
    fs.fsyncSync=fd=>{if(published&&!failed){failed=true;throw Object.assign(Error('INJECTED_SYNC_FAILURE'),{code:'EIO'});}return original.fsyncSync(fd);};`,
  );
  const events: unknown[] = [];
  store.subscribe((event) => events.push(event));
  await expect(
    store.mutate({
      action: 'edit',
      name: 'note',
      content: content.replace('checked workflow', 'NEW checked workflow'),
      expectedRevision: first.entry.revision,
    }),
  ).rejects.toThrow('INJECTED_SYNC_FAILURE');
  expect((await regular.read('note'))?.revision).toBe(first.entry.revision);
  expect(events).toEqual([]);
});

for (const action of ['create', 'edit', 'delete'] as const) {
  for (const position of ['before-marker', 'after-marker'] as const) {
    test(`${action} contains a failed committed journal flush ${position}`, async () => {
      const root = join(scratch, 'skills');
      const regular = new FilesystemSkillStore({ root });
      const first =
        action === 'create'
          ? undefined
          : (await regular.mutate({ action: 'create', name: 'note', content })).entry;
      const store = await instrumentedStore(
        root,
        `let prepared=false,published=false,failed=false;
      fs.writeFileSync=(fd,data,...args)=>{original.writeFileSync(fd,data,...args);if(typeof data==='string'){try{if(JSON.parse(data).phase==='committed')prepared=true;}catch{}}};
      fs.renameSync=(from,to)=>{original.renameSync(from,to);if(basename(to)==='journal.json'&&JSON.parse(original.readFileSync(to,'utf8')).phase==='committed')published=true;};
      fs.fsyncSync=fd=>{if(!failed && (${JSON.stringify(position)}==='before-marker'?prepared:published)){failed=true;throw Object.assign(Error('COMMITTED_JOURNAL_SYNC_FAILURE'),{code:'EIO'});}return original.fsyncSync(fd);};`,
      );
      const events: unknown[] = [];
      store.subscribe((event) => events.push(event));
      const mutation = store.mutate({
        action,
        name: 'note',
        ...(action !== 'delete'
          ? { content: content.replace('checked workflow', 'NEW checked workflow') }
          : {}),
        ...(first ? { expectedRevision: first.revision } : {}),
      });
      if (action === 'delete') {
        await expect(mutation).rejects.toThrow('COMMITTED_JOURNAL_SYNC_FAILURE');
        expect((await regular.read('note'))?.revision).toBe(first?.revision);
        expect(events).toEqual([]);
      } else {
        const committed = await mutation;
        expect((await regular.read('note'))?.revision).toBe(committed.entry?.revision);
        expect(events).toHaveLength(1);
      }
    });
  }
}

test('malicious legacy journal names cannot redirect recovery or cleanup', async () => {
  const root = join(scratch, 'skills');
  const store = new FilesystemSkillStore({ root });
  await store.mutate({ action: 'create', name: 'note', content });
  const outside = join(scratch, 'outside.txt');
  await writeFile(outside, 'OUTSIDE_SENTINEL');
  const txn = join(root, '.sov-skill-store', 'txn-9999');
  await mkdir(txn);
  await writeFile(
    join(txn, 'journal.json'),
    JSON.stringify({ name: '../../outside.txt', action: 'delete', phase: 'committed' }),
  );
  await expect(store.read('note')).rejects.toThrow('slash-command-safe');
  expect(await readFile(outside, 'utf8')).toBe('OUTSIDE_SENTINEL');
  expect(await readFile(join(root, 'note', 'SKILL.md'), 'utf8')).toBe(content);
});
