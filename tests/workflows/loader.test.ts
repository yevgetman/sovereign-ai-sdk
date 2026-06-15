// Workflow loader tests (2026-06-15 — multi-agent workflows). Mirrors the
// agent loader test shape: three search roots (project, user, bundle),
// YAML parsing, project precedence on duplicate names, per-file tolerance of
// malformed / schema-invalid files. Also covers `validateWorkflow`'s semantic
// gate: unknown agents + unresolved template refs.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadWorkflows, validateWorkflow } from '../../src/workflows/loader.js';
import { WorkflowDefSchema } from '../../src/workflows/types.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-workflows-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeWorkflow(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

const MINIMAL_BODY = (name: string, agent = 'code-reviewer'): string => `
name: ${name}
description: A ${name} workflow.
phases:
  - id: only
    tasks:
      - agent: ${agent}
        prompt: Do the thing.
`;

describe('loadWorkflows', () => {
  test('returns empty registry when no roots exist', async () => {
    await withTmp(async (dir) => {
      const { byName } = await loadWorkflows({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
      });
      expect(byName.size).toBe(0);
    });
  });

  test('loads bundle workflows tagged with bundle source', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeWorkflow(join(bundleRoot, 'workflows/review.yaml'), MINIMAL_BODY('review'));
      const { byName } = await loadWorkflows({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      const loaded = byName.get('review');
      expect(loaded).toBeDefined();
      expect(loaded?.source).toBe('bundle');
      expect(loaded?.def.description).toContain('review');
    });
  });

  test('project workflows override user and bundle on name collision', async () => {
    await withTmp(async (dir) => {
      const cwd = join(dir, 'project');
      const harnessHome = join(dir, 'home');
      const bundleRoot = join(dir, 'bundle');
      writeWorkflow(
        join(cwd, '.harness/workflows/review.yaml'),
        MINIMAL_BODY('review', 'proj-agent'),
      );
      writeWorkflow(
        join(harnessHome, 'workflows/review.yaml'),
        MINIMAL_BODY('review', 'user-agent'),
      );
      writeWorkflow(
        join(bundleRoot, 'workflows/review.yaml'),
        MINIMAL_BODY('review', 'bundle-agent'),
      );
      const warnings: string[] = [];
      const { byName } = await loadWorkflows({
        cwd,
        harnessHome,
        bundleRoot,
        warn: (m) => warnings.push(m),
      });
      const loaded = byName.get('review');
      expect(loaded?.source).toBe('project');
      // The project task's agent should win.
      expect(loaded?.def.phases[0]?.tasks?.[0]?.agent).toBe('proj-agent');
      expect(warnings.some((m) => m.includes('duplicate workflow name'))).toBe(true);
    });
  });

  test('user beats bundle when no project copy exists', async () => {
    await withTmp(async (dir) => {
      const harnessHome = join(dir, 'home');
      const bundleRoot = join(dir, 'bundle');
      writeWorkflow(
        join(harnessHome, 'workflows/review.yaml'),
        MINIMAL_BODY('review', 'user-agent'),
      );
      writeWorkflow(
        join(bundleRoot, 'workflows/review.yaml'),
        MINIMAL_BODY('review', 'bundle-agent'),
      );
      const { byName } = await loadWorkflows({
        cwd: join(dir, 'project'),
        harnessHome,
        bundleRoot,
      });
      expect(byName.get('review')?.source).toBe('user');
    });
  });

  test('scans both .yaml and .yml extensions', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeWorkflow(join(bundleRoot, 'workflows/alpha.yaml'), MINIMAL_BODY('alpha'));
      writeWorkflow(join(bundleRoot, 'workflows/beta.yml'), MINIMAL_BODY('beta'));
      writeWorkflow(join(bundleRoot, 'workflows/ignore.txt'), MINIMAL_BODY('gamma'));
      const { byName } = await loadWorkflows({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
      });
      expect(byName.has('alpha')).toBe(true);
      expect(byName.has('beta')).toBe(true);
      expect(byName.has('gamma')).toBe(false);
    });
  });

  test('skips malformed YAML and keeps scanning (loud, not fatal)', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      writeWorkflow(join(bundleRoot, 'workflows/broken.yaml'), 'name: : : not: valid: yaml: [');
      writeWorkflow(join(bundleRoot, 'workflows/good.yaml'), MINIMAL_BODY('good'));
      const warnings: string[] = [];
      const { byName } = await loadWorkflows({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
        warn: (m) => warnings.push(m),
      });
      expect(byName.has('good')).toBe(true);
      expect(byName.has('broken')).toBe(false);
      expect(warnings.some((m) => m.includes('broken.yaml'))).toBe(true);
    });
  });

  test('rejects schema-invalid workflows with a per-file warning', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      // Missing `phases` entirely → schema-invalid.
      writeWorkflow(
        join(bundleRoot, 'workflows/no-phases.yaml'),
        'name: no-phases\ndescription: missing phases\n',
      );
      // Phase with BOTH tasks and map → superRefine error.
      writeWorkflow(
        join(bundleRoot, 'workflows/both.yaml'),
        `
name: both
description: phase has both forms
phases:
  - id: bad
    tasks:
      - agent: a
        prompt: x
    map:
      over: args.items
    task:
      agent: b
      prompt: y
`,
      );
      const warnings: string[] = [];
      const { byName } = await loadWorkflows({
        cwd: join(dir, 'project'),
        harnessHome: join(dir, 'home'),
        bundleRoot,
        warn: (m) => warnings.push(m),
      });
      expect(byName.size).toBe(0);
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('dedupes via realpath when symlinks alias the same file', async () => {
    await withTmp(async (dir) => {
      const bundleRoot = join(dir, 'bundle');
      const harnessHome = join(dir, 'home');
      writeWorkflow(join(bundleRoot, 'workflows/source.yaml'), MINIMAL_BODY('aliased'));
      mkdirSync(join(harnessHome, 'workflows'), { recursive: true });
      symlinkSync(
        join(bundleRoot, 'workflows/source.yaml'),
        join(harnessHome, 'workflows/alias.yaml'),
      );
      const { byName } = await loadWorkflows({
        cwd: join(dir, 'project'),
        harnessHome,
        bundleRoot,
      });
      expect(byName.size).toBe(1);
      expect(byName.get('aliased')).toBeDefined();
    });
  });

  test('omits bundle root entirely when bundleRoot is absent', async () => {
    await withTmp(async (dir) => {
      const harnessHome = join(dir, 'home');
      writeWorkflow(join(harnessHome, 'workflows/userflow.yaml'), MINIMAL_BODY('userflow'));
      const { byName } = await loadWorkflows({
        cwd: join(dir, 'project'),
        harnessHome,
      });
      expect(byName.get('userflow')?.source).toBe('user');
    });
  });
});

describe('validateWorkflow', () => {
  function parse(body: string) {
    return WorkflowDefSchema.parse(parseYaml(body));
  }

  test('passes a well-formed multi-phase workflow', () => {
    const def = parse(`
name: review-changes
description: review then verify then synthesize
args:
  diff: { type: string, required: true }
  dimensions: { type: list, required: true }
phases:
  - id: find
    map:
      over: args.dimensions
      as: dimension
    task:
      agent: code-reviewer
      output: json
      prompt: 'Review {{dimension}} of {{args.diff}}'
  - id: verify
    map:
      over: find.findings
      as: finding
    task:
      agent: verify
      output: json
      prompt: 'Refute {{finding.claim}}'
  - id: synthesize
    tasks:
      - agent: synthesizer
        prompt: 'Merge {{verify.results}} and {{find.text}}'
`);
    const errors = validateWorkflow(def, ['code-reviewer', 'verify', 'synthesizer']);
    expect(errors).toEqual([]);
  });

  test('detects an unknown agent', () => {
    const def = parse(MINIMAL_BODY('w', 'ghost-agent'));
    const errors = validateWorkflow(def, ['code-reviewer']);
    expect(errors.some((e) => e.includes("unknown agent 'ghost-agent'"))).toBe(true);
  });

  test('detects a prompt ref to an undeclared arg', () => {
    const def = parse(`
name: w
description: bad arg ref
args:
  diff: { type: string }
phases:
  - id: only
    tasks:
      - agent: a
        prompt: 'Use {{args.missing}}'
`);
    const errors = validateWorkflow(def, ['a']);
    expect(errors.some((e) => e.includes('args.missing'))).toBe(true);
  });

  test('detects a prompt ref to a non-earlier phase', () => {
    const def = parse(`
name: w
description: forward ref
phases:
  - id: first
    tasks:
      - agent: a
        prompt: 'Needs {{later.text}}'
  - id: later
    tasks:
      - agent: a
        prompt: ok
`);
    const errors = validateWorkflow(def, ['a']);
    expect(errors.some((e) => e.includes('{{later.text}}'))).toBe(true);
  });

  test('detects a map.over referencing an unknown source', () => {
    const def = parse(`
name: w
description: bad over ref
phases:
  - id: only
    map:
      over: nope.list
    task:
      agent: a
      prompt: '{{item}}'
`);
    const errors = validateWorkflow(def, ['a']);
    expect(errors.some((e) => e.includes('map.over'))).toBe(true);
  });

  test('allows the default loop variable `item` in a map task', () => {
    const def = parse(`
name: w
description: default loopvar
args:
  things: { type: list }
phases:
  - id: only
    map:
      over: args.things
    task:
      agent: a
      prompt: 'Handle {{item}} and {{item.field}}'
`);
    const errors = validateWorkflow(def, ['a']);
    expect(errors).toEqual([]);
  });

  test('rejects an earlier-phase id used as a loop variable outside its phase', () => {
    const def = parse(`
name: w
description: loopvar does not leak
args:
  things: { type: list }
phases:
  - id: first
    map:
      over: args.things
      as: row
    task:
      agent: a
      prompt: '{{row}}'
  - id: second
    tasks:
      - agent: a
        prompt: 'leaked {{row}}'
`);
    const errors = validateWorkflow(def, ['a']);
    expect(errors.some((e) => e.includes('{{row}}'))).toBe(true);
  });

  test('accumulates multiple errors across phases', () => {
    const def = parse(`
name: w
description: many problems
phases:
  - id: a
    tasks:
      - agent: ghost
        prompt: '{{args.x}}'
`);
    const errors = validateWorkflow(def, []);
    // unknown agent + unknown arg
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
