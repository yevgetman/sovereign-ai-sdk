import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, Message } from '@yevgetman/sov-sdk/core/types';
import { createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { resolveSkillContextBudget } from '@yevgetman/sov-sdk/skills/budget';
import type {
  SkillContinuityDiagnostic,
  SkillContinuityPort,
} from '@yevgetman/sov-sdk/skills/continuity';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { compactSession } from '../../src/compact/compactor.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { buildSessionToolContext } from '../../src/server/sessionToolContext.js';
import {
  SessionSkillContinuityStore,
  buildSovSkillContinuity,
  skillContinuityProfileKey,
} from '../../src/skills/continuity.js';

const homes: string[] = [];
const databases: SessionDb[] = [];
const revision = createHash('sha256').update('first revision').digest('hex');
const workflow = 'CHECK_ARTIFACT\nVERIFY_SIGNATURE\nRECORD_PUBLICATION';
const budget = resolveSkillContextBudget({ contextWindowTokens: 32768 });
const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const memoryDb = (): SessionDb => {
  const db = SessionDb.open({ path: ':memory:' });
  databases.push(db);
  return db;
};
const session = (db: SessionDb, owner?: string, parentSessionId?: string): string =>
  db.createSession({
    provider: 'mock',
    model: 'mock',
    ...(owner !== undefined ? { owner } : {}),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
  });
const activate = (port: SkillContinuityPort, name = 'release', turn = 'turn1'): Promise<void> =>
  port.activated(
    {
      name,
      revision,
      source: 'user',
      args: 'private invocation value',
      allowedTools: ['Bash(echo*)'],
      allowedResourceRoots: ['/private/resource'],
    },
    workflow,
    turn,
  );

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('SOV private skill continuity adapter', () => {
  test('guidance survives a real database reopen without public session metadata or authority', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-skill-continuity-'));
    homes.push(home);
    const path = join(home, 'sessions.db');
    let db = SessionDb.open({ path });
    const id = session(db, 'alice');
    const events: SkillContinuityDiagnostic[] = [];
    let port = buildSovSkillContinuity({
      db,
      harnessHome: home,
      sessionId: id,
      observe: (event) => events.push(event),
    });
    await activate(port);
    await port.resource('release', 'SIGNATURE_RULE', '/private/reference');
    await port.finish('turn1', 'succeeded');
    expect(db.getSession(id)?.metadata).toEqual({});
    expect(JSON.stringify(db.listSessions())).not.toContain(workflow);
    expect(db.search('CHECK_ARTIFACT')).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain('private');
    expect(JSON.stringify(events)).not.toContain(workflow);
    db.close();
    db = SessionDb.open({ path });
    databases.push(db);
    port = buildSovSkillContinuity({ db, harnessHome: home, sessionId: id });
    const guidance = await port.guidance({
      budget,
      turnId: 'new-turn',
      resolveRevision: async () => revision,
    });
    expect(guidance.text).toContain(JSON.stringify(workflow));
    expect(guidance.text).toContain('SIGNATURE_RULE');
    const saved = await port.exportRecords();
    expect(saved[0]?.outcome).toBe('succeeded');
    expect(saved[0]).not.toHaveProperty('allowedTools');
    expect(saved[0]).not.toHaveProperty('allowedResourceRoots');
    expect(saved[0]?.arguments).toEqual({ provided: true, bytes: 24 });
    expect(db.getSession(id)?.schemaVersion).toBe(7);
  });

  test('forced compaction preserves revision and workflow while permission state starts fresh', async () => {
    const db = memoryDb();
    const home = '/private/sov-test-profile';
    const parent = session(db, 'alice');
    const port = buildSovSkillContinuity({ db, harnessHome: home, sessionId: parent });
    await activate(port);
    const before = createSkillActivationState({
      tools: [],
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    before.activations.push({
      name: 'release',
      revision,
      source: 'user',
      args: '',
      allowedTools: ['Bash(echo*)'],
      allowedResourceRoots: [],
    });
    const history: Message[] = [
      { role: 'user', content: [text(workflow)] },
      { role: 'assistant', content: [text('A lengthy unrelated transcript. '.repeat(300))] },
      { role: 'user', content: [text('Proceed.')] },
    ];
    const result = await compactSession({
      db,
      sessionId: parent,
      model: 'mock',
      providerName: 'mock',
      systemPrompt: [],
      history,
      tailTokenBudget: 1,
      minTailMessages: 1,
      summarize: async () => 'Continue the task. Skills omitted.',
    });
    expect(result.newSessionId).not.toBe(parent);
    expect(JSON.stringify(db.loadMessages(result.newSessionId))).not.toContain(workflow);
    // Parent mutation after the child was created cannot replace its snapshot.
    await port.complete('release');
    const child = buildSovSkillContinuity({
      db,
      harnessHome: home,
      sessionId: result.newSessionId,
    });
    const guidance = await child.guidance({
      budget,
      turnId: 'child-turn',
      resolveRevision: async () => 'new revision',
    });
    expect(guidance.text).toContain(JSON.stringify(workflow));
    expect(guidance.text).toContain(revision);
    expect(child.diagnostics().some((event) => event.code === 'revision-changed')).toBe(true);
    const after = createSkillActivationState({
      tools: [],
      canUseTool: async () => ({ behavior: 'deny' }),
    });
    expect(after.activations).toHaveLength(0);
    expect((await child.exportRecords())[0]).not.toHaveProperty('allowedTools');
  });

  test('same-owner delegation copies only non-turn guidance; profiles and owners cannot cross', async () => {
    const db = memoryDb();
    const parent = session(db, 'alice');
    const home = '/private/profile-one';
    const port = buildSovSkillContinuity({ db, harnessHome: home, sessionId: parent });
    await activate(port);
    const records = await port.exportRecords();
    const profile = skillContinuityProfileKey(home);
    const store = new SessionSkillContinuityStore(db, profile);
    const first = records[0];
    if (!first) throw new Error('missing test activation');
    await store.save(port.scope, [
      ...records,
      { ...first, id: 'turn-only', name: 'ephemeral', lifetime: 'turn' },
    ]);
    const child = session(db, 'alice', parent);
    const childPort = buildSovSkillContinuity({ db, harnessHome: home, sessionId: child });
    expect((await childPort.exportRecords()).map((record) => record.name)).toEqual(['release']);
    const foreign = session(db, 'bob', parent);
    expect(
      await buildSovSkillContinuity({ db, harnessHome: home, sessionId: foreign }).exportRecords(),
    ).toEqual([]);
    expect(
      await buildSovSkillContinuity({
        db,
        harnessHome: '/private/profile-two',
        sessionId: child,
      }).exportRecords(),
    ).toEqual([]);
    await expect(store.load({ ...port.scope, owner: 'user:bob' })).rejects.toThrow('unavailable');
    await expect(store.load({ ...port.scope, profile: 'foreign-profile' })).rejects.toThrow(
      'unavailable',
    );
    const local = session(db);
    const userNamedLocal = session(db, 'local');
    expect(buildSovSkillContinuity({ db, harnessHome: home, sessionId: local }).scope.owner).toBe(
      'local',
    );
    expect(
      buildSovSkillContinuity({ db, harnessHome: home, sessionId: userNamedLocal }).scope.owner,
    ).toBe('user:local');
  });

  test('nearest empty snapshot is a completion barrier and bounded cycles fail safely', async () => {
    const db = memoryDb();
    const home = '/private/profile';
    const ancestor = session(db, 'alice');
    const port = buildSovSkillContinuity({ db, harnessHome: home, sessionId: ancestor });
    await activate(port);
    const middle = session(db, 'alice', ancestor);
    const middlePort = buildSovSkillContinuity({ db, harnessHome: home, sessionId: middle });
    await middlePort.complete('release');
    const child = session(db, 'alice', middle);
    expect(
      await buildSovSkillContinuity({ db, harnessHome: home, sessionId: child }).exportRecords(),
    ).toEqual([]);
    const cyclic = session(db, 'alice');
    db.handle.run('UPDATE sessions SET parent_session_id = ? WHERE session_id = ?', [
      cyclic,
      cyclic,
    ]);
    const events: SkillContinuityDiagnostic[] = [];
    const cyclePort = buildSovSkillContinuity({
      db,
      harnessHome: home,
      sessionId: cyclic,
      observe: (event) => events.push(event),
    });
    expect(await cyclePort.exportRecords()).toEqual([]);
    expect(events).toEqual([{ code: 'invalid-record' }]);
    expect(JSON.stringify(events)).not.toContain(cyclic);
  });

  test('missing lineage, cancellation, failure and session deletion have bounded private outcomes', async () => {
    const db = memoryDb();
    const home = '/private/profile';
    const orphan = session(db, 'alice', 'missing-parent');
    const events: SkillContinuityDiagnostic[] = [];
    const port = buildSovSkillContinuity({
      db,
      harnessHome: home,
      sessionId: orphan,
      observe: (event) => events.push(event),
    });
    await activate(port);
    await port.finish('turn1', 'cancelled');
    expect((await port.exportRecords())[0]?.outcome).toBe('cancelled');
    await activate(port, 'release', 'turn2');
    await port.finish('turn2', 'failed');
    expect((await port.exportRecords())[0]?.outcome).toBe('failed');
    const guidance = await port.guidance({
      budget,
      turnId: 'turn3',
      resolveRevision: async () => undefined,
    });
    expect(guidance.text).toContain(JSON.stringify(workflow));
    expect(events.some((event) => event.code === 'revision-missing')).toBe(true);
    const profile = port.scope.profile;
    expect(db.deleteSession(orphan)).toBe(true);
    expect(
      db.handle
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM skill_continuity WHERE profile = ?',
        )
        .get(profile)?.count,
    ).toBe(0);
    const reopened = buildSovSkillContinuity;
    expect(() => reopened({ db, harnessHome: home, sessionId: orphan })).toThrow('unavailable');
  });
  test('session context binds the real tool surface and records only safe lifecycle trace fields', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-continuity-runtime-'));
    homes.push(home);
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      settings: {
        learning: { disabled: true, recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 } },
        review: { disabled: true },
      },
    });
    try {
      const id = session(runtime.sessionDb, 'alice');
      const context = runtime.getSessionContext(id);
      const tools = buildSessionToolContext(runtime, id, async () => ({ behavior: 'deny' }));
      const port = tools.skillContinuity;
      if (!port) throw new Error('missing trusted session continuity');
      if (!context.skillContinuity) throw new Error('missing context continuity');
      expect(port).toBe(context.skillContinuity);
      expect(port.scope.owner).toBe('user:alice');
      expect(port.scope.session).toBe(id);
      await activate(port);
      const fork = tools.forkSkillContinuity;
      if (!fork) throw new Error('missing child continuity factory');
      const childId = session(runtime.sessionDb, 'alice', id);
      const child = await fork(childId);
      if (!child) throw new Error('missing child continuity');
      expect(child.scope.session).toBe(childId);
      expect((await child.exportRecords())[0]?.revision).toBe(revision);
      expect(child.diagnostics().some((event) => event.code === 'delegated')).toBe(true);
      const grandchildId = session(runtime.sessionDb, 'alice', childId);
      const grandchild = await fork(grandchildId, childId);
      if (!grandchild) throw new Error('missing grandchild continuity');
      expect(grandchild.scope.session).toBe(grandchildId);
      expect((await grandchild.exportRecords())[0]?.revision).toBe(revision);
      const foreignParent = session(runtime.sessionDb, 'bob');
      const foreignGrandchild = session(runtime.sessionDb, 'bob', foreignParent);
      await expect(fork(foreignGrandchild, foreignParent)).rejects.toThrow('child unavailable');
      const foreignChild = session(runtime.sessionDb, 'bob', id);
      await expect(fork(foreignChild)).rejects.toThrow('child unavailable');
      const unrelated = session(runtime.sessionDb, 'alice');
      await expect(fork(unrelated)).rejects.toThrow('child unavailable');
      await expect(fork('missing-child')).rejects.toThrow('child unavailable');
      await port.resource('release', 'PRIVATE_REFERENCE_CONTENT', '/private/reference');
      await port.finish('turn1', 'succeeded');
      const path = context.traceWriter.path;
      await runtime.disposeSession(id);
      const events = readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.source === 'skill-continuity');
      expect(events.length).toBeGreaterThan(0);
      const emitted = JSON.stringify(events);
      expect(emitted).toContain('activated');
      expect(emitted).toContain('succeeded');
      expect(emitted).not.toContain(workflow);
      expect(emitted).not.toContain('PRIVATE_REFERENCE_CONTENT');
      expect(emitted).not.toContain('/private/reference');
      expect(emitted).not.toContain('private invocation value');
      expect(emitted).not.toContain('allowedTools');
      const rebuilt = runtime.getSessionContext(id).skillContinuity;
      if (!rebuilt) throw new Error('missing rebuilt session continuity');
      expect((await rebuilt.exportRecords())[0]?.revision).toBe(revision);
    } finally {
      await runtime.dispose();
    }
  });

  test('v6 database migration preserves existing sessions and creates the private table', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-continuity-migrate-'));
    homes.push(home);
    const path = join(home, 'sessions.db');
    let db = SessionDb.open({ path });
    const id = session(db, 'alice');
    db.handle.exec(
      'DROP TABLE skill_continuity; UPDATE state_meta SET schema_version = 6; UPDATE sessions SET schema_version = 6;',
    );
    db.close();
    db = SessionDb.open({ path });
    databases.push(db);
    expect(db.getSession(id)?.ownerId).toBe('alice');
    expect(
      db.handle.query<{ schema_version: number }, []>('SELECT schema_version FROM state_meta').get()
        ?.schema_version,
    ).toBe(7);
    const port = buildSovSkillContinuity({ db, harnessHome: home, sessionId: id });
    await activate(port);
    expect((await port.exportRecords())[0]?.guidance).toBe(workflow);
  });

  test('old lineage fallback stops after eight ancestors and cannot reveal deeper guidance', async () => {
    const db = memoryDb();
    const home = '/private/profile';
    const root = session(db, 'alice');
    await activate(buildSovSkillContinuity({ db, harnessHome: home, sessionId: root }));
    let leaf = root;
    for (let depth = 0; depth < 10; depth++) {
      leaf = session(db, 'alice', leaf);
      // Emulate a session row created before continuity was introduced.
      db.handle.run('DELETE FROM skill_continuity WHERE session_id = ?', [leaf]);
    }
    const events: SkillContinuityDiagnostic[] = [];
    const port = buildSovSkillContinuity({
      db,
      harnessHome: home,
      sessionId: leaf,
      observe: (event) => events.push(event),
    });
    expect(await port.exportRecords()).toEqual([]);
    expect(events).toEqual([{ code: 'invalid-record' }]);
  });
});
