// 2026-05-24 patch — draft manager unit tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetAllDrafts,
  commitDraft,
  ensureDraft,
  getDraft,
  recordModification,
  takeBaselineForDiscard,
} from '../../src/config/draftManager.js';
import type { Settings } from '../../src/config/schema.js';

describe('ConfigDraftManager', () => {
  const SESSION = 'session-test';
  const SETTINGS_A = { defaultProvider: 'anthropic' } as Settings;
  const SETTINGS_B = { defaultProvider: 'ollama' } as Settings;

  beforeEach(() => __resetAllDrafts());
  afterEach(() => __resetAllDrafts());

  test('ensureDraft creates a draft when none exists', () => {
    expect(getDraft(SESSION)).toBeUndefined();
    const draft = ensureDraft(SESSION, SETTINGS_A);
    expect(draft).toBeDefined();
    expect(draft.baseline).toEqual(SETTINGS_A);
    expect(draft.modifiedPaths.size).toBe(0);
  });

  test('ensureDraft is idempotent — second call returns the existing draft', () => {
    const first = ensureDraft(SESSION, SETTINGS_A);
    const second = ensureDraft(SESSION, SETTINGS_B);
    // baseline must NOT change on the second ensureDraft.
    expect(first).toBe(second);
    expect(second.baseline).toEqual(SETTINGS_A);
  });

  test('ensureDraft snapshots structurally — later mutation of input does not affect baseline', () => {
    const mutable: Settings = { defaultProvider: 'anthropic' } as Settings;
    ensureDraft(SESSION, mutable);
    // Mutate the caller's object.
    (mutable as { defaultProvider: string }).defaultProvider = 'changed';
    const draft = getDraft(SESSION);
    expect(draft?.baseline).toEqual({ defaultProvider: 'anthropic' });
  });

  test('recordModification adds the path to the active draft', () => {
    ensureDraft(SESSION, SETTINGS_A);
    recordModification(SESSION, 'defaultProvider');
    recordModification(SESSION, 'theme');
    const draft = getDraft(SESSION);
    expect(draft?.modifiedPaths.size).toBe(2);
    expect(draft?.modifiedPaths.has('defaultProvider')).toBe(true);
    expect(draft?.modifiedPaths.has('theme')).toBe(true);
  });

  test('recordModification deduplicates — re-adding the same path is idempotent', () => {
    ensureDraft(SESSION, SETTINGS_A);
    recordModification(SESSION, 'theme');
    recordModification(SESSION, 'theme');
    recordModification(SESSION, 'theme');
    expect(getDraft(SESSION)?.modifiedPaths.size).toBe(1);
  });

  test('recordModification is a no-op when no draft is open', () => {
    recordModification(SESSION, 'theme');
    expect(getDraft(SESSION)).toBeUndefined();
  });

  test('commitDraft drops the draft and returns the modified-path count', () => {
    ensureDraft(SESSION, SETTINGS_A);
    recordModification(SESSION, 'defaultProvider');
    recordModification(SESSION, 'theme');
    expect(commitDraft(SESSION)).toBe(2);
    expect(getDraft(SESSION)).toBeUndefined();
  });

  test('commitDraft returns 0 when no draft is open', () => {
    expect(commitDraft(SESSION)).toBe(0);
  });

  test('takeBaselineForDiscard returns the baseline + paths, drops the draft', () => {
    ensureDraft(SESSION, SETTINGS_A);
    recordModification(SESSION, 'defaultProvider');
    recordModification(SESSION, 'theme');
    const result = takeBaselineForDiscard(SESSION);
    expect(result?.baseline).toEqual(SETTINGS_A);
    expect(result?.modifiedPaths).toHaveLength(2);
    expect(result?.modifiedPaths).toContain('defaultProvider');
    expect(result?.modifiedPaths).toContain('theme');
    expect(getDraft(SESSION)).toBeUndefined();
  });

  test('takeBaselineForDiscard returns undefined when no draft', () => {
    expect(takeBaselineForDiscard(SESSION)).toBeUndefined();
  });

  test('drafts are isolated per sessionId', () => {
    ensureDraft('session-A', SETTINGS_A);
    ensureDraft('session-B', SETTINGS_B);
    recordModification('session-A', 'pathA');
    recordModification('session-B', 'pathB');
    const draftA = getDraft('session-A');
    const draftB = getDraft('session-B');
    expect(draftA?.modifiedPaths.has('pathA')).toBe(true);
    expect(draftA?.modifiedPaths.has('pathB')).toBe(false);
    expect(draftB?.modifiedPaths.has('pathB')).toBe(true);
    expect(draftB?.modifiedPaths.has('pathA')).toBe(false);
  });
});
