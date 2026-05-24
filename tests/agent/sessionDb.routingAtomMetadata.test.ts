import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';

describe('SessionDb routing-atom queries', () => {
  let db: SessionDb;

  beforeEach(() => {
    db = SessionDb.open({ path: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  test('listRoutingAtomsByParent returns atoms grouped under the delegator child of the given parent', () => {
    const rootId = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'root',
      metadata: {},
    });
    const delegatorId = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'delegator',
      parentSessionId: rootId,
      metadata: { kind: 'routing-delegator', parentSessionId: rootId },
    });
    const atom1Id = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'cheap-task',
      parentSessionId: delegatorId,
      metadata: {
        kind: 'routing-atom',
        laneName: 'cheap-task',
        laneProvider: 'mock',
        laneModel: 'mock-h',
        parentDelegatorSessionId: delegatorId,
      },
    });
    const atom2Id = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'moderate-task',
      parentSessionId: delegatorId,
      metadata: {
        kind: 'routing-atom',
        laneName: 'moderate-task',
        laneProvider: 'mock',
        laneModel: 'mock-s',
        parentDelegatorSessionId: delegatorId,
      },
    });
    // Noise: a regular subagent row
    db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'explore',
      parentSessionId: rootId,
      metadata: { kind: 'subagent', agentName: 'explore' },
    });

    const atoms = db.listRoutingAtomsByParent(rootId);
    expect(atoms).toHaveLength(2);
    const ids = atoms.map((r) => r.sessionId).sort();
    expect(ids).toEqual([atom1Id, atom2Id].sort());
  });

  test('listRoutingAtomsByParent returns empty when no delegator child exists', () => {
    const rootId = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'root',
      metadata: {},
    });
    expect(db.listRoutingAtomsByParent(rootId)).toEqual([]);
  });

  test('listRoutingAtomsAll returns all routing-atom rows across the DB', () => {
    const r1 = db.createSession({ model: 'mock', provider: 'mock', title: 'r1', metadata: {} });
    const d1 = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'd1',
      parentSessionId: r1,
      metadata: { kind: 'routing-delegator', parentSessionId: r1 },
    });
    const a1 = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'a1',
      parentSessionId: d1,
      metadata: {
        kind: 'routing-atom',
        laneName: 'cheap-task',
        laneProvider: 'mock',
        laneModel: 'm',
        parentDelegatorSessionId: d1,
      },
    });
    const r2 = db.createSession({ model: 'mock', provider: 'mock', title: 'r2', metadata: {} });
    const d2 = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'd2',
      parentSessionId: r2,
      metadata: { kind: 'routing-delegator', parentSessionId: r2 },
    });
    const a2 = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'a2',
      parentSessionId: d2,
      metadata: {
        kind: 'routing-atom',
        laneName: 'frontier-task',
        laneProvider: 'mock',
        laneModel: 'm',
        parentDelegatorSessionId: d2,
      },
    });

    const all = db.listRoutingAtomsAll();
    expect(all).toHaveLength(2);
    const ids = all.map((r) => r.sessionId).sort();
    expect(ids).toEqual([a1, a2].sort());
  });

  test('atoms returned in created_at ascending order', () => {
    const rootId = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'root',
      metadata: {},
    });
    const delegatorId = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'delegator',
      parentSessionId: rootId,
      metadata: { kind: 'routing-delegator', parentSessionId: rootId },
    });
    const atomA = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'a',
      parentSessionId: delegatorId,
      metadata: {
        kind: 'routing-atom',
        laneName: 'cheap-task',
        laneProvider: 'mock',
        laneModel: 'm',
        parentDelegatorSessionId: delegatorId,
      },
    });
    // Small delay so created_at differs
    Bun.sleepSync(10);
    const atomB = db.createSession({
      model: 'mock',
      provider: 'mock',
      title: 'b',
      parentSessionId: delegatorId,
      metadata: {
        kind: 'routing-atom',
        laneName: 'moderate-task',
        laneProvider: 'mock',
        laneModel: 'm',
        parentDelegatorSessionId: delegatorId,
      },
    });

    const atoms = db.listRoutingAtomsByParent(rootId);
    expect(atoms.map((r) => r.sessionId)).toEqual([atomA, atomB]);
  });
});
