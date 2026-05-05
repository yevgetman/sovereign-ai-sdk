// Phase 10.5 part 2b — loader / validator / writer tests for fixtures.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadReplayFixture,
  validateFixture,
  writeReplayFixture,
} from '../../../src/eval/replay/loader.js';
import type { ReplayFixture } from '../../../src/eval/replay/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sov-replay-loader-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID: ReplayFixture = {
  meta: {
    sessionId: 's',
    provider: 'p',
    model: 'm',
    capturedAt: '2026-05-05T00:00:00.000Z',
  },
  turns: [
    {
      turn: 0,
      providerEvents: [],
      toolResults: [],
    },
  ],
};

describe('validateFixture', () => {
  test('accepts a well-formed fixture', () => {
    expect(() => validateFixture(VALID)).not.toThrow();
  });

  test('rejects null and non-objects', () => {
    expect(() => validateFixture(null)).toThrow(/expected an object/);
    expect(() => validateFixture(42)).toThrow(/expected an object/);
    expect(() => validateFixture('hello')).toThrow(/expected an object/);
  });

  test('rejects missing meta', () => {
    expect(() => validateFixture({ turns: [] })).toThrow(/missing or non-object 'meta'/);
  });

  test('rejects non-string meta fields', () => {
    expect(() =>
      validateFixture({
        meta: { sessionId: 1, provider: 'p', model: 'm', capturedAt: 'x' },
        turns: [],
      }),
    ).toThrow(/meta.sessionId must be a string/);
  });

  test('rejects non-array turns', () => {
    expect(() => validateFixture({ ...VALID, turns: 'not-an-array' })).toThrow(
      /'turns' must be an array/,
    );
  });

  test('rejects malformed turn entries', () => {
    expect(() =>
      validateFixture({
        ...VALID,
        turns: [{ turn: 'zero', providerEvents: [], toolResults: [] }],
      }),
    ).toThrow(/turns\[0\].turn must be a number/);
    expect(() =>
      validateFixture({
        ...VALID,
        turns: [{ turn: 0, providerEvents: 'no', toolResults: [] }],
      }),
    ).toThrow(/turns\[0\].providerEvents must be an array/);
    expect(() =>
      validateFixture({
        ...VALID,
        turns: [{ turn: 0, providerEvents: [], toolResults: 'no' }],
      }),
    ).toThrow(/turns\[0\].toolResults must be an array/);
  });
});

describe('loadReplayFixture', () => {
  test('reads + parses + validates a JSON file', () => {
    const path = join(dir, 'fx.json');
    writeFileSync(path, JSON.stringify(VALID), 'utf8');
    const loaded = loadReplayFixture(path);
    expect(loaded.meta.sessionId).toBe('s');
    expect(loaded.turns).toHaveLength(1);
  });

  test('throws cleanly when the file is missing', () => {
    expect(() => loadReplayFixture(join(dir, 'gone.json'))).toThrow(/replay fixture not found/);
  });

  test('throws cleanly on malformed JSON', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json', 'utf8');
    expect(() => loadReplayFixture(path)).toThrow(/failed to parse fixture/);
  });
});

describe('writeReplayFixture', () => {
  test('writes a fixture as pretty JSON and round-trips through loadReplayFixture', () => {
    const path = join(dir, 'roundtrip.json');
    writeReplayFixture(path, VALID);
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).toContain('"sessionId": "s"');
    const loaded = loadReplayFixture(path);
    expect(loaded).toEqual(VALID);
  });
});
