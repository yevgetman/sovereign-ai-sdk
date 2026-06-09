// T8 — the `sov dispatch` TTY-consent helper. `/plugins install` needs a real
// yes/no prompt that reads the answer from the dispatch loop's SINGLE stdin
// consumer (the shared async-iterator's readLine) — reading through one
// consumer avoids stdin contention. On a non-TTY stdin there is no interactive
// surface, so `confirm` is undefined and `/plugins install` refuses.
//
// These pin the helper in isolation (driving `runDispatch`'s full stdin loop in
// a unit test is impractical): a TTY yields a function that resolves true only
// for y/yes (case-insensitive), false otherwise (incl. EOF); a non-TTY yields
// undefined.

import { describe, expect, test } from 'bun:test';
import { buildDispatchConfirm } from '../../src/cli/dispatchConfirm.js';

/** A readLine that returns each queued answer in turn, then null (EOF). */
function queuedReadLine(answers: (string | null)[]): () => Promise<string | null> {
  let i = 0;
  return async () => (i < answers.length ? (answers[i++] ?? null) : null);
}

/** Capture what the confirm writes to its output sink. */
function capture(): { write: (t: string) => void; out: string[] } {
  const out: string[] = [];
  return { write: (t: string) => out.push(t), out };
}

describe('buildDispatchConfirm', () => {
  test('returns undefined when stdin is NOT a TTY (install must refuse)', () => {
    expect(buildDispatchConfirm(queuedReadLine(['y']), false)).toBeUndefined();
  });

  test('returns a confirm fn when stdin IS a TTY', () => {
    expect(typeof buildDispatchConfirm(queuedReadLine(['y']), true)).toBe('function');
  });

  test('confirm resolves true for "y" and "yes" (case-insensitive)', async () => {
    for (const answer of ['y', 'Y', 'yes', 'YES', 'Yes', '  yes  ']) {
      const confirm = buildDispatchConfirm(queuedReadLine([answer]), true, () => {});
      expect(await confirm?.('proceed?')).toBe(true);
    }
  });

  test('confirm resolves false for anything else (incl. EOF)', async () => {
    for (const answer of ['n', 'no', '', 'nope', 'yeah', 'true', null]) {
      const confirm = buildDispatchConfirm(queuedReadLine([answer]), true, () => {});
      expect(await confirm?.('proceed?')).toBe(false);
    }
  });

  test('confirm writes the disclosure + a [yN] prompt before reading', async () => {
    const cap = capture();
    const confirm = buildDispatchConfirm(queuedReadLine(['n']), true, cap.write);
    await confirm?.('DISCLOSURE TEXT');
    const written = cap.out.join('');
    expect(written).toContain('DISCLOSURE TEXT');
    expect(written.toLowerCase()).toContain('[yn]');
  });
});
