// Phase 13.2 — capability profile tests. The lookup table feeds two
// consumers: the router classifier (localContextLength → context-overflow
// heuristic) and the Phase 13 sub-agent scheduler (role → cheapest capable
// model). v0 entries are hand-curated; Phase 13.4 evals will refine them.

import { describe, expect, test } from 'bun:test';
import { contextLengthFor } from '../../src/providers/models.js';
import {
  CAPABILITY_TABLE,
  findCapableModel,
  getCapabilityProfile,
} from '../../src/router/capabilities.js';

describe('getCapabilityProfile', () => {
  test('returns a profile for a well-known anthropic model', () => {
    const p = getCapabilityProfile('anthropic', 'claude-haiku-4-5-20251001');
    expect(p).toBeDefined();
    expect(p?.contextLength).toBe(200_000);
    expect(p?.recommendedRoles).toContain('explore');
    expect(p?.source).toBe('curated');
  });

  test('returns undefined for an unknown provider', () => {
    expect(getCapabilityProfile('unknown', 'unknown')).toBeUndefined();
  });

  test('returns undefined for a known provider but unknown model', () => {
    expect(getCapabilityProfile('anthropic', 'claude-mystery-9000')).toBeUndefined();
  });
});

describe('findCapableModel', () => {
  test('returns the cheapest available model that supports the role', () => {
    const p = findCapableModel('explore', ['anthropic']);
    expect(p).toBeDefined();
    expect(p?.provider).toBe('anthropic');
    expect(p?.recommendedRoles).toContain('explore');
  });

  test('prefers ollama over anthropic when both have an explore-capable model', () => {
    const p = findCapableModel('explore', ['anthropic', 'ollama']);
    expect(p?.provider).toBe('ollama');
  });

  test('returns undefined when no available provider has a model capable of the role', () => {
    expect(findCapableModel('code', ['ollama'])).toBeUndefined();
  });

  test('returns undefined when the providers list is empty', () => {
    expect(findCapableModel('explore', [])).toBeUndefined();
  });

  test('returns undefined for an unknown role', () => {
    expect(findCapableModel('mystery-role-9000', ['anthropic'])).toBeUndefined();
  });
});

describe('CAPABILITY_TABLE invariants', () => {
  test('contextLength values agree with providers/models.ts contextLengthFor', () => {
    for (const profile of CAPABILITY_TABLE) {
      const expected = contextLengthFor(profile.provider, profile.model);
      expect(profile.contextLength).toBe(expected);
    }
  });

  test('all entries have valid reliability values in [0, 1]', () => {
    for (const profile of CAPABILITY_TABLE) {
      expect(profile.toolCallReliability).toBeGreaterThanOrEqual(0);
      expect(profile.toolCallReliability).toBeLessThanOrEqual(1);
      expect(profile.jsonReliability).toBeGreaterThanOrEqual(0);
      expect(profile.jsonReliability).toBeLessThanOrEqual(1);
    }
  });

  test('all entries have at least one recommended role', () => {
    for (const profile of CAPABILITY_TABLE) {
      expect(profile.recommendedRoles.length).toBeGreaterThan(0);
    }
  });

  test('all curated v0 entries declare provenance', () => {
    for (const profile of CAPABILITY_TABLE) {
      expect(['curated', 'eval']).toContain(profile.source);
    }
  });
});
