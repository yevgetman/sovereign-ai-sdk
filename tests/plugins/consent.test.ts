// Plugin consent-record tests (T2). The consent record is the on-disk artifact
// of the load-time consent gate (S1): the T3 loader contributes NOTHING from a
// plugin unless a valid `.consent.json` exists whose `pluginId` matches AND
// whose recorded `treeHash` still matches the live tree (`verifyConsent`). The
// record-builder is PURE — `consentedAt` is PASSED IN, never generated inside
// (this repo bans non-deterministic calls in pure functions and the builder
// must be unit-testable). These tests pin: pure build from a passed-in
// timestamp, atomic write→read round-trip, null on absent/corrupt files, and
// the tamper case where the tree changed after the hash was recorded.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ConsentRecord,
  buildConsentRecord,
  readConsent,
  verifyConsent,
  writeConsent,
} from '../../src/plugins/consent.js';
import { hashPluginTree } from '../../src/plugins/integrity.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-consent-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FIXED_TS = '2026-06-09T12:00:00.000Z';

function seedTree(root: string): void {
  writeFileSync(join(root, 'plugin.json'), '{"name":"p","version":"1.0.0"}', 'utf8');
  writeFileSync(join(root, 'a.md'), 'content', 'utf8');
}

describe('buildConsentRecord (pure)', () => {
  test('builds a valid record from a passed-in timestamp (no Date.now)', () => {
    const record = buildConsentRecord({
      pluginId: 'my-plugin',
      version: '1.0.0',
      treeHash: 'abc123',
      decisions: { skills: true, commands: true, hooks: false, mcpServers: false },
      consentedAt: FIXED_TS,
    });
    expect(record.pluginId).toBe('my-plugin');
    expect(record.version).toBe('1.0.0');
    expect(record.treeHash).toBe('abc123');
    expect(record.decisions).toEqual({
      skills: true,
      commands: true,
      hooks: false,
      mcpServers: false,
    });
    expect(record.consentedAt).toBe(FIXED_TS);
  });

  test('records an empty decisions map', () => {
    const record = buildConsentRecord({
      pluginId: 'p',
      version: '0.1.0',
      treeHash: 'h',
      decisions: {},
      consentedAt: FIXED_TS,
    });
    expect(record.decisions).toEqual({});
  });

  test('does not mutate the passed-in decisions object', () => {
    const decisions = { skills: true };
    const snapshot = { ...decisions };
    buildConsentRecord({
      pluginId: 'p',
      version: '0.1.0',
      treeHash: 'h',
      decisions,
      consentedAt: FIXED_TS,
    });
    expect(decisions).toEqual(snapshot);
  });

  test('throws on an invalid record (missing pluginId)', () => {
    expect(() =>
      buildConsentRecord({
        // @ts-expect-error — intentionally omitting pluginId to assert validation
        pluginId: undefined,
        version: '1.0.0',
        treeHash: 'h',
        decisions: {},
        consentedAt: FIXED_TS,
      }),
    ).toThrow();
  });
});

describe('writeConsent / readConsent round-trip', () => {
  test('write then read returns an equal record', () => {
    const record = buildConsentRecord({
      pluginId: 'my-plugin',
      version: '2.0.0',
      treeHash: 'deadbeef',
      decisions: { skills: true, commands: false },
      consentedAt: FIXED_TS,
    });
    writeConsent(dir, record);
    expect(readConsent(dir)).toEqual(record);
  });

  test('writeConsent leaves a parseable .consent.json on the happy path (atomic, no partial file)', () => {
    const record = buildConsentRecord({
      pluginId: 'p',
      version: '1.0.0',
      treeHash: 'h',
      decisions: {},
      consentedAt: FIXED_TS,
    });
    writeConsent(dir, record);
    const path = join(dir, '.consent.json');
    expect(existsSync(path)).toBe(true);
    // Reading it back must succeed (no temp file, no half-written content).
    expect(readConsent(dir)).not.toBeNull();
  });

  test('writeConsent leaves no leftover temp file', () => {
    const record = buildConsentRecord({
      pluginId: 'p',
      version: '1.0.0',
      treeHash: 'h',
      decisions: {},
      consentedAt: FIXED_TS,
    });
    writeConsent(dir, record);
    const stray = readdirSync(dir).filter((n) => n.includes('.tmp'));
    expect(stray).toEqual([]);
  });
});

describe('readConsent — absent / corrupt', () => {
  test('returns null when .consent.json is absent', () => {
    expect(readConsent(dir)).toBeNull();
  });

  test('returns null on invalid JSON (does not throw)', () => {
    writeFileSync(join(dir, '.consent.json'), 'not json at all {{{', 'utf8');
    expect(readConsent(dir)).toBeNull();
  });

  test('returns null on JSON that fails the schema (does not throw)', () => {
    writeFileSync(join(dir, '.consent.json'), '{"pluginId":123}', 'utf8');
    expect(readConsent(dir)).toBeNull();
  });
});

describe('verifyConsent', () => {
  test('returns true when the recorded treeHash matches the live tree', () => {
    seedTree(dir);
    const record = buildConsentRecord({
      pluginId: 'p',
      version: '1.0.0',
      treeHash: hashPluginTree(dir),
      decisions: { skills: true },
      consentedAt: FIXED_TS,
    });
    expect(verifyConsent(dir, record)).toBe(true);
  });

  test('returns true after writing the consent record (write does not invalidate its own hash)', () => {
    seedTree(dir);
    const record = buildConsentRecord({
      pluginId: 'p',
      version: '1.0.0',
      treeHash: hashPluginTree(dir),
      decisions: { skills: true },
      consentedAt: FIXED_TS,
    });
    writeConsent(dir, record);
    // The .consent.json now exists on disk; verify must still pass because the
    // hash excludes it.
    const readBack = readConsent(dir);
    expect(readBack).not.toBeNull();
    expect(verifyConsent(dir, readBack as ConsentRecord)).toBe(true);
  });

  test('returns false when the tree was edited after the hash was recorded (tamper)', () => {
    seedTree(dir);
    const record = buildConsentRecord({
      pluginId: 'p',
      version: '1.0.0',
      treeHash: hashPluginTree(dir),
      decisions: { skills: true },
      consentedAt: FIXED_TS,
    });
    // Tamper: edit a file after consent.
    writeFileSync(join(dir, 'a.md'), 'tampered content', 'utf8');
    expect(verifyConsent(dir, record)).toBe(false);
  });

  test('returns false when a new file is added after consent (tamper)', () => {
    seedTree(dir);
    const record = buildConsentRecord({
      pluginId: 'p',
      version: '1.0.0',
      treeHash: hashPluginTree(dir),
      decisions: {},
      consentedAt: FIXED_TS,
    });
    writeFileSync(join(dir, 'evil.md'), 'injected', 'utf8');
    expect(verifyConsent(dir, record)).toBe(false);
  });
});
