import { describe, expect, test } from 'bun:test';
import {
  type ConsolidationProposal,
  type MemoryProposal,
  type SkillProposalMeta,
  parseConsolidationProposal,
  parseMemoryProposal,
  parseSkillProposalMeta,
  serializeConsolidationProposal,
  serializeMemoryProposal,
  serializeSkillProposalMeta,
} from '../../src/review/proposal.js';

describe('memory proposal round-trip', () => {
  test('serialize → parse preserves all fields', () => {
    const original: MemoryProposal = {
      proposalId: '2026-05-06-abc',
      type: 'memory',
      target: 'MEMORY.md',
      memoryType: 'project',
      sessionId: 'sess-1',
      parentSessionId: null,
      traceId: 'trace-1',
      sourceMessageRange: [12, 18],
      sourceHash: 'sha256:abc',
      sourceExcerpt: 'short excerpt',
      author: 'review-memory',
      createdAt: '2026-05-06T10:30:00Z',
      status: 'pending',
      body: '# Title\n\n**Why:** because\n\n**How to apply:** when X happens',
    };

    const serialized = serializeMemoryProposal(original);
    const parsed = parseMemoryProposal(serialized);
    expect(parsed).toEqual(original);
  });

  test('parse rejects unknown memoryType with clear error', () => {
    const bad =
      '---\nproposalId: x\ntype: memory\ntarget: MEMORY.md\nmemoryType: invalid\nsessionId: s\nparentSessionId: ~\ntraceId: t\nsourceMessageRange: [0,1]\nsourceHash: s\nsourceExcerpt: e\nauthor: a\ncreatedAt: 2026-01-01T00:00:00Z\nstatus: pending\n---\nbody';
    expect(() => parseMemoryProposal(bad)).toThrow(/memoryType/);
  });
});

describe('skill proposal meta round-trip', () => {
  test('serialize → parse preserves all fields', () => {
    const original: SkillProposalMeta = {
      proposalId: '2026-05-06-xyz',
      type: 'skill',
      skillName: 'rename-db-column',
      sessionId: 'sess-1',
      parentSessionId: null,
      traceId: 'trace-1',
      sourceMessageRange: [4, 26],
      sourceHash: 'sha256:def',
      sourceExcerpt: 'short excerpt',
      author: 'review-skill',
      createdAt: '2026-05-06T10:31:00Z',
      status: 'pending',
    };

    const serialized = serializeSkillProposalMeta(original);
    const parsed = parseSkillProposalMeta(serialized);
    expect(parsed).toEqual(original);
  });
});

describe('consolidation proposal round-trip', () => {
  test('serialize → parse preserves all fields including affectedEntries', () => {
    const original: ConsolidationProposal = {
      proposalId: '2026-05-06-c4',
      type: 'consolidation',
      target: 'MEMORY.md',
      affectedEntries: ['user_role.md', 'user_preferences.md'],
      sessionId: 'sess-1',
      parentSessionId: null,
      traceId: 'trace-1',
      author: 'review-consolidate',
      createdAt: '2026-05-06T10:32:00Z',
      status: 'pending',
      body: '# Consolidation rationale\n\nMerged.',
    };

    const serialized = serializeConsolidationProposal(original);
    const parsed = parseConsolidationProposal(serialized);
    expect(parsed).toEqual(original);
  });
});
