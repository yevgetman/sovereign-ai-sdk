// Phase 10.5 part 2 — assertion-primitive tests. Each assertion kind
// gets at least a pass case + a fail case. Pure: a temp sandbox + a
// canned transcript drive every check.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAll, evaluateAssertion } from '../../src/eval/assertions.js';
import type { EvaluateOpts } from '../../src/eval/assertions.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sov-eval-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function ctx(over: Partial<EvaluateOpts> = {}): EvaluateOpts {
  return {
    sandboxCwd: cwd,
    transcript: '',
    exitCode: 0,
    ...over,
  };
}

describe('fileExists / fileNotExists', () => {
  test('fileExists passes when the file is present', () => {
    writeFileSync(join(cwd, 'note.txt'), 'hello', 'utf8');
    const result = evaluateAssertion({ type: 'fileExists', path: 'note.txt' }, ctx());
    expect(result.pass).toBe(true);
  });

  test('fileExists fails when the file is missing', () => {
    const result = evaluateAssertion({ type: 'fileExists', path: 'missing.txt' }, ctx());
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('expected missing.txt to exist');
  });

  test('fileNotExists passes when the file is missing', () => {
    const result = evaluateAssertion({ type: 'fileNotExists', path: 'gone.txt' }, ctx());
    expect(result.pass).toBe(true);
  });

  test('fileNotExists fails when the file is present', () => {
    writeFileSync(join(cwd, 'gone.txt'), '', 'utf8');
    const result = evaluateAssertion({ type: 'fileNotExists', path: 'gone.txt' }, ctx());
    expect(result.pass).toBe(false);
  });
});

describe('fileContains / fileMatches / fileEquals', () => {
  test('fileContains passes when the substring appears', () => {
    writeFileSync(join(cwd, 'a.txt'), 'foo bar baz', 'utf8');
    const result = evaluateAssertion({ type: 'fileContains', path: 'a.txt', text: 'bar' }, ctx());
    expect(result.pass).toBe(true);
  });

  test('fileContains fails when the substring is absent', () => {
    writeFileSync(join(cwd, 'a.txt'), 'foo bar baz', 'utf8');
    const result = evaluateAssertion({ type: 'fileContains', path: 'a.txt', text: 'qux' }, ctx());
    expect(result.pass).toBe(false);
  });

  test('fileContains fails cleanly when the file is missing', () => {
    const result = evaluateAssertion({ type: 'fileContains', path: 'gone.txt', text: 'x' }, ctx());
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('does not exist');
  });

  test('fileMatches accepts a regex pattern + flags', () => {
    writeFileSync(join(cwd, 'a.txt'), 'Hello\nWorld', 'utf8');
    const result = evaluateAssertion(
      { type: 'fileMatches', path: 'a.txt', pattern: '^world$', flags: 'mi' },
      ctx(),
    );
    expect(result.pass).toBe(true);
  });

  test('fileMatches reports a clean error on invalid regex', () => {
    writeFileSync(join(cwd, 'a.txt'), 'x', 'utf8');
    const result = evaluateAssertion({ type: 'fileMatches', path: 'a.txt', pattern: '[' }, ctx());
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('invalid regex');
  });

  test('fileEquals passes on exact match', () => {
    writeFileSync(join(cwd, 'a.txt'), 'exact', 'utf8');
    const result = evaluateAssertion(
      { type: 'fileEquals', path: 'a.txt', content: 'exact' },
      ctx(),
    );
    expect(result.pass).toBe(true);
  });

  test('fileEquals fails on mismatch with a useful detail', () => {
    writeFileSync(join(cwd, 'a.txt'), 'actual', 'utf8');
    const result = evaluateAssertion(
      { type: 'fileEquals', path: 'a.txt', content: 'expected' },
      ctx(),
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('content mismatch');
  });
});

describe('agentResponseContains / Matches / Lacks', () => {
  test('agentResponseContains passes when the substring is in the transcript', () => {
    const result = evaluateAssertion(
      { type: 'agentResponseContains', text: 'mars' },
      ctx({ transcript: 'the capital of mars is olympus mons' }),
    );
    expect(result.pass).toBe(true);
  });

  test('agentResponseContains fails when missing', () => {
    const result = evaluateAssertion(
      { type: 'agentResponseContains', text: 'venus' },
      ctx({ transcript: 'mars only' }),
    );
    expect(result.pass).toBe(false);
  });

  test('agentResponseMatches accepts regex + flags', () => {
    const result = evaluateAssertion(
      { type: 'agentResponseMatches', pattern: '^summary:', flags: 'mi' },
      ctx({ transcript: 'preamble\nSummary: ok' }),
    );
    expect(result.pass).toBe(true);
  });

  test('agentResponseLacks passes when text is absent', () => {
    const result = evaluateAssertion(
      { type: 'agentResponseLacks', text: 'pwned' },
      ctx({ transcript: 'safe content' }),
    );
    expect(result.pass).toBe(true);
  });

  test('agentResponseLacks fails when text is present', () => {
    const result = evaluateAssertion(
      { type: 'agentResponseLacks', text: 'pwned' },
      ctx({ transcript: 'pwned by the prompt' }),
    );
    expect(result.pass).toBe(false);
  });
});

describe('noToolErrors / minToolCalls / maxToolCalls', () => {
  test('noToolErrors passes when err count is 0', () => {
    const result = evaluateAssertion(
      { type: 'noToolErrors' },
      ctx({ toolCalls: { ok: 3, err: 0 } }),
    );
    expect(result.pass).toBe(true);
  });

  test('noToolErrors fails when err > 0', () => {
    const result = evaluateAssertion(
      { type: 'noToolErrors' },
      ctx({ toolCalls: { ok: 3, err: 2 } }),
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('2 tool error');
  });

  test("noToolErrors fails when toolCalls couldn't be parsed", () => {
    const result = evaluateAssertion({ type: 'noToolErrors' }, ctx());
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('not parsed');
  });

  test('minToolCalls passes at threshold', () => {
    const result = evaluateAssertion(
      { type: 'minToolCalls', count: 3 },
      ctx({ toolCalls: { ok: 2, err: 1 } }),
    );
    expect(result.pass).toBe(true);
  });

  test('minToolCalls fails below threshold', () => {
    const result = evaluateAssertion(
      { type: 'minToolCalls', count: 5 },
      ctx({ toolCalls: { ok: 2, err: 1 } }),
    );
    expect(result.pass).toBe(false);
  });

  test('maxToolCalls passes at threshold', () => {
    const result = evaluateAssertion(
      { type: 'maxToolCalls', count: 3 },
      ctx({ toolCalls: { ok: 2, err: 1 } }),
    );
    expect(result.pass).toBe(true);
  });

  test('maxToolCalls fails over threshold', () => {
    const result = evaluateAssertion(
      { type: 'maxToolCalls', count: 1 },
      ctx({ toolCalls: { ok: 2, err: 1 } }),
    );
    expect(result.pass).toBe(false);
  });
});

describe('exitCode', () => {
  test('passes on match', () => {
    const result = evaluateAssertion({ type: 'exitCode', code: 0 }, ctx({ exitCode: 0 }));
    expect(result.pass).toBe(true);
  });

  test('fails on mismatch', () => {
    const result = evaluateAssertion({ type: 'exitCode', code: 0 }, ctx({ exitCode: 1 }));
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('expected exit code 0, got 1');
  });
});

describe('evaluateAll', () => {
  test('returns one result per assertion in declaration order', () => {
    writeFileSync(join(cwd, 'a.txt'), 'hello', 'utf8');
    const results = evaluateAll(
      [
        { type: 'fileExists', path: 'a.txt' },
        { type: 'fileContains', path: 'a.txt', text: 'hello' },
        { type: 'fileContains', path: 'a.txt', text: 'goodbye' },
      ],
      ctx(),
    );
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.pass)).toEqual([true, true, false]);
  });
});
