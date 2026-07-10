// steerFile — consume discipline: stale-swap recovery, read-failure restore,
// parse robustness. (The rename-race with the appender is closed on the
// adapter side; these tests cover this process's obligations.)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeSteerFile, frameSteers, parseSteerLines } from '../../src/server/steerFile.js';

let dir: string;
let queue: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steerfile-'));
  queue = join(dir, 'steer.queue');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('consumeSteerFile', () => {
  test('consumes pending steers oldest-first and removes the file', async () => {
    writeFileSync(
      queue,
      `${JSON.stringify({ text: 'one' })}\n${JSON.stringify({ text: 'two' })}\n`,
    );
    expect(await consumeSteerFile(queue)).toEqual(['one', 'two']);
    expect(existsSync(queue)).toBe(false);
    expect(await consumeSteerFile(queue)).toEqual([]);
  });

  test('recovers a stale swap stranded by a dead consumer', async () => {
    const stale = `${queue}.consuming-99999-old-0`;
    writeFileSync(stale, `${JSON.stringify({ text: 'stranded steer' })}\n`);
    const past = new Date(Date.now() - 120_000);
    utimesSync(stale, past, past);
    expect(await consumeSteerFile(queue)).toEqual(['stranded steer']);
    expect(existsSync(stale)).toBe(false);
  });

  test('leaves a FRESH sibling swap alone (may belong to a live consumer)', async () => {
    const fresh = `${queue}.consuming-88888-new-0`;
    writeFileSync(fresh, `${JSON.stringify({ text: 'in flight elsewhere' })}\n`);
    expect(await consumeSteerFile(queue)).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  test('corrupt lines are skipped, valid ones kept', () => {
    expect(parseSteerLines(`garbage\n${JSON.stringify({ text: 'good' })}\n{"nope":1}\n`)).toEqual([
      'good',
    ]);
  });
});

describe('frameSteers', () => {
  test('marks every message and carries the untrusted-content preamble', () => {
    const framed = frameSteers(['a', 'b']);
    expect(framed.match(/BEGIN OPERATOR STEERING MESSAGE/g)?.length).toBe(2);
    expect(framed).toContain('untrusted');
  });
});
