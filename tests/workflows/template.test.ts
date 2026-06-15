// Tests for the safe workflow prompt interpolator (src/workflows/template.ts).
// Asserts: dotpath substitution only (no eval / no expressions), every
// reference form (args / loopVar / phase.text / phase.json[.field] /
// phase.results / phase.<field> flatten), and a clear error on an unresolved
// reference.

import { describe, expect, test } from 'bun:test';
import {
  type PhaseOutput,
  type TemplateContext,
  interpolate,
  resolveOverArray,
} from '../../src/workflows/template.js';

function ctx(over: Partial<TemplateContext> = {}): TemplateContext {
  return { args: {}, phases: {}, ...over };
}

describe('interpolate — args', () => {
  test('substitutes a string arg', () => {
    const out = interpolate('Review {{args.diff}} now', ctx({ args: { diff: 'a-diff' } }));
    expect(out).toBe('Review a-diff now');
  });

  test('serializes a non-string arg (list) as JSON', () => {
    const out = interpolate('dims={{args.dimensions}}', ctx({ args: { dimensions: ['a', 'b'] } }));
    expect(out).toBe('dims=["a","b"]');
  });

  test('throws on a missing arg', () => {
    expect(() => interpolate('{{args.missing}}', ctx())).toThrow(/unresolved reference/);
  });
});

describe('interpolate — loop variable', () => {
  test('substitutes a bare loop var (text item)', () => {
    const out = interpolate('dim: {{dimension}}', ctx({ item: { dimension: 'security' } }));
    expect(out).toBe('dim: security');
  });

  test('substitutes a field of a JSON loop item', () => {
    const out = interpolate('claim: {{finding.claim}}', ctx({ item: { finding: { claim: 'x' } } }));
    expect(out).toBe('claim: x');
  });
});

describe('interpolate — phase outputs', () => {
  const single: PhaseOutput = {
    kind: 'single',
    task: { text: 'final answer', json: { ok: true, n: 3 } },
  };
  const mapPhase: PhaseOutput = {
    kind: 'multi',
    results: [
      { text: '1', json: { findings: [{ claim: 'a' }, { claim: 'b' }] } },
      { text: '2', json: { findings: [{ claim: 'c' }] } },
      { text: '3', error: 'parse failed' }, // contributes nothing to flatten
    ],
  };

  test('{{phase.text}} resolves a single-task phase final text', () => {
    const out = interpolate('{{syn.text}}', ctx({ phases: { syn: single } }));
    expect(out).toBe('final answer');
  });

  test('{{phase.json}} serializes the parsed JSON value', () => {
    const out = interpolate('{{syn.json}}', ctx({ phases: { syn: single } }));
    expect(out).toBe('{"ok":true,"n":3}');
  });

  test('{{phase.json.field}} walks into the parsed JSON', () => {
    const out = interpolate('n={{syn.json.n}}', ctx({ phases: { syn: single } }));
    expect(out).toBe('n=3');
  });

  test('{{phase.results}} serializes a map phase output array', () => {
    const out = interpolate('{{find.results}}', ctx({ phases: { find: mapPhase } }));
    expect(out).toContain('parse failed');
    expect(JSON.parse(out)).toHaveLength(3);
  });

  test('{{phase.<field>}} flattens item.field across the map JSON outputs', () => {
    const out = interpolate('{{find.findings}}', ctx({ phases: { find: mapPhase } }));
    expect(JSON.parse(out)).toEqual([{ claim: 'a' }, { claim: 'b' }, { claim: 'c' }]);
  });

  test('single-task phase sugar walks an unknown field into the parsed JSON', () => {
    // `{{syn.n}}` ≡ `{{syn.json.n}}` — the convenience flatten for single phases.
    expect(interpolate('{{syn.n}}', ctx({ phases: { syn: single } }))).toBe('3');
  });

  test('throws when a single-task phase field is missing from the parsed JSON', () => {
    expect(() => interpolate('{{syn.missing}}', ctx({ phases: { syn: single } }))).toThrow(
      /unresolved reference/,
    );
  });

  test('throws on an unknown root', () => {
    expect(() => interpolate('{{nope.text}}', ctx())).toThrow(/unknown root/);
  });
});

describe('interpolate — no eval / dotpath only', () => {
  test('does not evaluate an expression-looking reference', () => {
    // `1 + 1` is treated as a single dotpath root '1 + 1', which is unknown.
    expect(() => interpolate('{{1 + 1}}', ctx())).toThrow(/unresolved reference/);
  });

  test('leaves non-reference braces and text untouched', () => {
    const out = interpolate('keep { this } literal {{args.x}}', ctx({ args: { x: 'v' } }));
    expect(out).toBe('keep { this } literal v');
  });
});

describe('resolveOverArray', () => {
  test('resolves args.<field> to an array', () => {
    expect(resolveOverArray('args.dims', ctx({ args: { dims: ['x', 'y'] } }))).toEqual(['x', 'y']);
  });

  test('resolves the phase.<field> flatten to an array', () => {
    const find: PhaseOutput = {
      kind: 'multi',
      results: [{ text: '1', json: { findings: [1, 2] } }],
    };
    expect(resolveOverArray('find.findings', ctx({ phases: { find } }))).toEqual([1, 2]);
  });

  test('throws when the reference is not an array', () => {
    expect(() => resolveOverArray('args.scalar', ctx({ args: { scalar: 7 } }))).toThrow(
      /did not resolve to an array/,
    );
  });
});
