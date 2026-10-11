import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importSkill, installSkill, uninstallSkill } from '@yevgetman/sov-sdk/skills/install';
import { FilesystemSkillStore, InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';
import type { SkillMutationEvent, SkillWritableStore } from '@yevgetman/sov-sdk/skills/store';
import { SkillManageTool } from '@yevgetman/sov-sdk/tools/SkillManageTool';

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sov-store-'));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const content = (body = 'Use the checked workflow.') =>
  `---\nname: note\ndescription: A safe workflow\nwhenToUse: User asks for a note\n---\n${body}\n`;

for (const adapter of ['memory', 'filesystem'] as const) {
  describe(`${adapter} explicit skill store`, () => {
    let store: SkillWritableStore;
    beforeEach(() => {
      store =
        adapter === 'memory'
          ? new InMemorySkillStore()
          : new FilesystemSkillStore({ root: join(scratch, 'skills') });
    });
    test('enumeration is bounded, complete by pages, and rejects stale cursors', async () => {
      for (const name of ['alpha', 'beta', 'gamma']) {
        await store.mutate({
          action: 'create',
          name,
          content: content().replace('name: note', `name: ${name}`),
        });
      }
      const first = await store.list({ limit: 2 });
      expect(first.names).toEqual(['alpha', 'beta']);
      expect(first.truncated).toBe(true);
      if (!first.nextCursor) throw new Error('missing continuation');
      const second = await store.list({ cursor: first.nextCursor, limit: 2 });
      expect(second.names).toEqual(['gamma']);
      expect(second.nextCursor).toBeUndefined();
      await store.mutate({
        action: 'create',
        name: 'delta',
        content: content().replace('name: note', 'name: delta'),
      });
      await expect(store.list({ cursor: first.nextCursor, limit: 2 })).rejects.toThrow(
        'catalog changed',
      );
    });
    test('validation and existence failures preserve the accepted revision', async () => {
      const committed = await store.mutate({ action: 'create', name: 'note', content: content() });
      const initial = committed.entry;
      if (!initial) throw new Error('missing initial revision');
      await expect(
        store.mutate({ action: 'create', name: 'note', content: content('replacement') }),
      ).rejects.toThrow('already exists');
      await expect(
        store.mutate({ action: 'edit', name: 'missing', content: content() }),
      ).rejects.toThrow('does not exist');
      await expect(
        store.mutate({
          action: 'edit',
          name: 'note',
          content: '---\nname: note\nmetadata: broken\n---\ninvalid',
          expectedRevision: initial.revision,
        }),
      ).rejects.toThrow();
      await expect(
        store.mutate({
          action: 'edit',
          name: 'note',
          content: content('Read ~/.ssh/id_rsa'),
          expectedRevision: initial.revision,
        }),
      ).rejects.toThrow('[BLOCKED: exfiltration pattern]');
      expect((await store.read('note'))?.revision).toBe(initial.revision);
      expect((await store.read('note'))?.content).toBe(initial.content);
    });
    test('edit/delete require a current tree revision, preserve resources and emit commits only', async () => {
      const events: SkillMutationEvent[] = [];
      store.subscribe((event) => events.push(event));
      store.subscribe(() => {
        throw new Error('broken observer');
      });
      const first = await store.mutate({
        action: 'create',
        name: 'note',
        content: content(),
        files: new Map([['scripts/run.sh', { data: Buffer.from('echo SAFE'), mode: 0o750 }]]),
      });
      if (!first.entry) throw new Error('missing entry');
      expect((await store.read('note'))?.revision).toBe(first.entry.revision);
      await expect(
        store.mutate({ action: 'edit', name: 'note', content: content('new') }),
      ).rejects.toThrow('expectedRevision');
      const second = await store.mutate({
        action: 'edit',
        name: 'note',
        content: content('new'),
        expectedRevision: first.entry.revision,
      });
      if (!second.entry) throw new Error('missing edit');
      expect(second.entry.files.get('scripts/run.sh')?.mode).toBe(0o750);
      expect(Buffer.from(second.entry.files.get('scripts/run.sh')?.data ?? []).toString()).toBe(
        'echo SAFE',
      );
      await expect(
        store.mutate({ action: 'delete', name: 'note', expectedRevision: first.entry.revision }),
      ).rejects.toThrow('expectedRevision');
      expect(events).toHaveLength(2);
      await store.mutate({
        action: 'delete',
        name: 'note',
        expectedRevision: second.entry.revision,
      });
      expect(await store.read('note')).toBeUndefined();
      expect(events.map((event) => event.action)).toEqual(['create', 'edit', 'delete']);
    });
    test('two accepted edits cannot silently overwrite the same revision', async () => {
      const first = await store.mutate({ action: 'create', name: 'note', content: content() });
      if (!first.entry) throw new Error('missing initial entry');
      const revision = first.entry.revision;
      const edits = await Promise.allSettled(
        ['first', 'second'].map((body) =>
          store.mutate({
            action: 'edit',
            name: 'note',
            content: content(body),
            expectedRevision: revision,
          }),
        ),
      );
      expect(edits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(edits.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect((await store.read('note'))?.content).toMatch(/first|second/);
    });
  });
}

test('prepopulated in-memory catalogs remain reachable beyond 512 entries', async () => {
  const store = new InMemorySkillStore();
  for (let index = 0; index < 530; index++) {
    const name = `note-${String(index).padStart(4, '0')}`;
    await store.mutate({
      action: 'create',
      name,
      content: content().replace('name: note', `name: ${name}`),
    });
  }
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ limit: 127, ...(cursor ? { cursor } : {}) });
    names.push(...page.names);
    cursor = page.nextCursor;
  } while (cursor);
  expect(names).toHaveLength(530);
  expect(new Set(names).size).toBe(530);
  expect(names.at(-1)).toBe('note-0529');
});

test('embedded skill_manage with no explicit store has no ambient effects', async () => {
  const ambient = join(scratch, 'ambient');
  const old = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = ambient;
  try {
    const result = await SkillManageTool.call(
      { action: 'create', name: 'note', body: 'Safe note' },
      { cwd: scratch, sessionId: 'embedded' },
    );
    expect(result.data.ok).toBe(false);
    expect(result.data.message).toContain('explicit writable');
    expect(existsSync(ambient)).toBe(false);
  } finally {
    if (old === undefined) Reflect.deleteProperty(process.env, 'HARNESS_HOME');
    else process.env.HARNESS_HOME = old;
  }
});

test('tool emits only durable changes and preserves an in-flight registry', async () => {
  const home = join(scratch, 'home');
  const store = new FilesystemSkillStore({ root: join(home, 'skills', 'agent-created') });
  const initial = await store.mutate({ action: 'create', name: 'note', content: content() });
  if (!initial.entry) throw new Error('missing entry');
  const events: SkillMutationEvent[] = [];
  const registry = { skills: [], byName: new Map() };
  const context = {
    cwd: scratch,
    sessionId: 'tool',
    skillStore: store,
    skills: registry,
    onSkillMutation: (event: SkillMutationEvent) => {
      events.push(event);
    },
  };
  const rejected = await SkillManageTool.call(
    {
      action: 'edit',
      name: 'note',
      body: 'changed',
      frontmatter: { metadata: 'invalid' },
      expectedRevision: initial.entry.revision,
    },
    context,
  );
  expect(rejected.data.ok).toBe(false);
  expect((await store.read('note'))?.revision).toBe(initial.entry.revision);
  expect(events).toHaveLength(0);
  const accepted = await SkillManageTool.call(
    { action: 'edit', name: 'note', body: 'changed', expectedRevision: initial.entry.revision },
    context,
  );
  expect(accepted.data.ok).toBe(true);
  expect(events).toHaveLength(1);
  expect(registry.byName.size).toBe(0);
});

test('destination directory and resource links cannot redirect mutations outside the root', async () => {
  const root = join(scratch, 'skills');
  const outside = join(scratch, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'SKILL.md'), 'OUTSIDE_SENTINEL');
  await symlink(outside, join(root, 'note'));
  const store = new FilesystemSkillStore({ root });
  await expect(
    store.mutate({ action: 'create', name: 'note', content: content() }),
  ).rejects.toThrow('unsafe store directory');
  await expect(
    store.mutate({ action: 'delete', name: 'note', expectedRevision: 'stale' }),
  ).rejects.toThrow('unsafe store directory');
  expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('OUTSIDE_SENTINEL');
  await rm(join(root, 'note'));
  const created = await store.mutate({ action: 'create', name: 'note', content: content() });
  if (!created.entry) throw new Error('missing committed entry');
  await symlink(join(outside, 'SKILL.md'), join(root, 'note', 'reference.md'));
  await expect(
    store.mutate({
      action: 'edit',
      name: 'note',
      content: content('changed'),
      expectedRevision: created.entry.revision,
    }),
  ).rejects.toThrow('unsafe skill resource');
  expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('OUTSIDE_SENTINEL');
});

test('a root pathname swap while the worker starts cannot redirect writes', async () => {
  const root = join(scratch, 'skills');
  const parked = join(scratch, 'original');
  const outside = join(scratch, 'outside');
  await mkdir(root);
  await mkdir(outside);
  const ready = join(scratch, 'worker-ready');
  const wrapper = join(scratch, 'delayed-worker.ts');
  const entry = resolve('packages/sdk/src/skills/storeWorkerEntry.ts');
  await writeFile(
    wrapper,
    `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(ready)}, 'ready'); await new Promise(r=>setTimeout(r,300)); await import(${JSON.stringify(entry)});`,
  );
  const store = new FilesystemSkillStore({
    root,
    workerCommand: { executable: process.execPath, args: [wrapper] },
  });
  const mutation = store.mutate({ action: 'create', name: 'note', content: content() });
  // Register rejection before changing the path to avoid an unhandled promise.
  const outcome = mutation.then(
    () => 'committed',
    (error: Error) => error.message,
  );
  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++)
    await new Promise((done) => setTimeout(done, 10));
  expect(existsSync(ready)).toBe(true);
  await rename(root, parked);
  await symlink(outside, root);
  expect(await outcome).toContain('root changed');
  expect(existsSync(join(outside, 'note'))).toBe(false);
  expect(existsSync(join(parked, 'note'))).toBe(false);
});

test('failed force import keeps the old package and security modes', async () => {
  const root = join(scratch, 'skills');
  const source = join(scratch, 'package');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), content());
  await writeFile(join(source, 'scripts', 'run.sh'), 'echo ORIGINAL');
  await chmod(join(source, 'scripts', 'run.sh'), 0o750);
  const installed = await installSkill({ source, userSkillsRoot: root });
  expect(installed.ok).toBe(true);
  await chmod(join(root, 'note', 'SKILL.md'), 0o640);
  const initial = await readFile(join(root, 'note', 'SKILL.md'), 'utf8');
  await symlink(join(scratch, 'outside-secret'), join(source, 'leak'));
  const rejected = await importSkill({ source, userSkillsRoot: root, force: true });
  expect(rejected.ok).toBe(false);
  expect(await readFile(join(root, 'note', 'SKILL.md'), 'utf8')).toBe(initial);
  expect(await readFile(join(root, 'note', 'scripts', 'run.sh'), 'utf8')).toBe('echo ORIGINAL');
  await rm(join(source, 'leak'));
  await writeFile(join(source, 'SKILL.md'), content('updated'));
  const replaced = await importSkill({ source, userSkillsRoot: root, force: true });
  expect(replaced.ok).toBe(true);
  expect((await stat(join(root, 'note', 'SKILL.md'))).mode & 0o777).toBe(0o640);
  expect((await stat(join(root, 'note', 'scripts', 'run.sh'))).mode & 0o777).toBe(0o750);
  expect((await new FilesystemSkillStore({ root }).read('note'))?.revision).toBe(
    replaced.ok ? replaced.revision : 'missing',
  );
});

test('interrupted staged replacement rolls back, and a published replacement rolls forward', async () => {
  const root = join(scratch, 'skills');
  const store = new FilesystemSkillStore({ root });
  await store.mutate({ action: 'create', name: 'note', content: content() });
  const transaction = join(root, '.sov-skill-store', 'txn-1111');
  await mkdir(transaction);
  await rename(join(root, 'note'), join(transaction, 'backup'));
  await cp(join(transaction, 'backup'), join(transaction, 'staged'), { recursive: true });
  await writeFile(join(transaction, 'staged', 'SKILL.md'), content('NEW'));
  await writeFile(
    join(transaction, 'journal.json'),
    JSON.stringify({ name: 'note', action: 'publish', phase: 'prepared' }),
  );
  expect((await store.read('note'))?.content).toBe(content());
  expect(existsSync(transaction)).toBe(false);
  await mkdir(transaction);
  await cp(join(root, 'note'), join(transaction, 'backup'), { recursive: true });
  await writeFile(join(root, 'note', 'SKILL.md'), content('NEW'));
  await writeFile(
    join(transaction, 'journal.json'),
    JSON.stringify({ name: 'note', action: 'publish', phase: 'prepared' }),
  );
  expect((await store.read('note'))?.content).toBe(content('NEW'));
  expect(existsSync(transaction)).toBe(false);
});

test('dead process lock and interrupted delete recover without deleting a new revision', async () => {
  const root = join(scratch, 'skills');
  const store = new FilesystemSkillStore({ root });
  await store.mutate({ action: 'create', name: 'note', content: content() });
  const internal = join(root, '.sov-skill-store');
  await writeFile(join(internal, 'lock'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  const transaction = join(internal, 'txn-2222');
  await mkdir(transaction);
  await rename(join(root, 'note'), join(transaction, 'backup'));
  await writeFile(
    join(transaction, 'journal.json'),
    JSON.stringify({ name: 'note', action: 'delete', phase: 'prepared' }),
  );
  expect((await store.read('note'))?.content).toBe(content());
  const current = await store.read('note');
  if (!current) throw new Error('missing recovered skill');
  const replaced = await store.mutate({
    action: 'edit',
    name: 'note',
    content: content('new revision'),
    expectedRevision: current.revision,
  });
  const rejected = await uninstallSkill({
    name: 'note',
    userSkillsRoot: root,
    expectedRevision: current.revision,
  });
  expect(rejected.ok).toBe(false);
  expect((await store.read('note'))?.revision).toBe(replaced.entry?.revision);
});

test('SOV internal helper runs without loading a configured harness home', async () => {
  const root = join(scratch, 'skills');
  const store = new FilesystemSkillStore({
    root,
    workerCommand: {
      executable: process.execPath,
      args: [resolve('src/main.ts'), '--sov-skill-store-worker'],
    },
  });
  const result = await store.mutate({ action: 'create', name: 'note', content: content() });
  expect(result.entry?.content).toBe(content());
});

test('Node uses the packaged filesystem worker and the same CAS contract', async () => {
  // The full gate builds the SDK before this consumer check. Use source-only
  // Bun for targeted checks; no skipping of the Node fixture in the full gate.
  const module = resolve('packages/sdk/dist/skills/store.js');
  if (!existsSync(module)) throw new Error('build the SDK before store consumer tests');
  const script = `import {FilesystemSkillStore,InMemorySkillStore} from ${JSON.stringify(module)};const content=${JSON.stringify(content())};for(const store of [new FilesystemSkillStore({root:${JSON.stringify(join(scratch, 'node-skills'))}}),new InMemorySkillStore()]){const result=await store.mutate({action:'create',name:'note',content});if((await store.read('note')).revision!==result.entry.revision)throw Error('revision');await store.mutate({action:'delete',name:'note',expectedRevision:result.entry.revision});}console.log('NODE_STORE_OK');`;
  const output = await new Promise<string>((resolveResult, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolveResult(text) : reject(new Error(text))));
  });
  expect(output).toContain('NODE_STORE_OK');
});
