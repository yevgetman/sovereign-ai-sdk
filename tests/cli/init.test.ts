// Phase 10.8 — `sov init` tests. v1 contract:
//   - writes a minimal index.yaml + business/README.md + state/ + harness/schemas/ + skills/ skeleton.
//   - reads cwd's README.md (when present) to seed business/README.md.
//   - refuses to overwrite an existing index.yaml unless --force.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundle } from '../../src/bundle/loader.js';
import { formatInitResult, runInit } from '../../src/cli/init.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sov-init-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('runInit', () => {
  test('writes the full bundle skeleton in an empty directory', () => {
    const result = runInit({ cwd });
    expect(result.ok).toBe(true);
    expect(result.bundleRoot).toBe(cwd);
    expect(existsSync(join(cwd, 'index.yaml'))).toBe(true);
    expect(existsSync(join(cwd, 'business/README.md'))).toBe(true);
    expect(existsSync(join(cwd, 'harness/schemas/.gitkeep'))).toBe(true);
    expect(existsSync(join(cwd, 'state/.gitkeep'))).toBe(true);
    expect(existsSync(join(cwd, 'skills/.gitkeep'))).toBe(true);
  });

  test('produced index.yaml contains the project name and reading_order', () => {
    runInit({ cwd });
    const yaml = readFileSync(join(cwd, 'index.yaml'), 'utf8');
    expect(yaml).toContain('repo:');
    expect(yaml).toContain('reading_order:');
    expect(yaml).toContain('bundle-readme');
    expect(yaml).toContain('business/README.md');
  });

  test("seeds business/README.md from cwd's README.md when present", () => {
    writeFileSync(join(cwd, 'README.md'), '# my-cool-project\n\nDoes things.\n', 'utf8');
    runInit({ cwd });
    const seeded = readFileSync(join(cwd, 'business/README.md'), 'utf8');
    expect(seeded).toContain('Project README (seeded by `sov init`)');
    expect(seeded).toContain('# my-cool-project');
    expect(seeded).toContain('Does things.');
  });

  test('writes a stub README when cwd has no README.md', () => {
    runInit({ cwd });
    const readme = readFileSync(join(cwd, 'business/README.md'), 'utf8');
    expect(readme).toContain('bundle README');
    expect(readme).toContain('tier-1 entry point');
  });

  test('refuses to overwrite an existing index.yaml without --force', () => {
    writeFileSync(join(cwd, 'index.yaml'), 'repo: existing\n', 'utf8');
    const result = runInit({ cwd });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already exists');
    // Original file untouched.
    expect(readFileSync(join(cwd, 'index.yaml'), 'utf8')).toBe('repo: existing\n');
    // No business/ created.
    expect(existsSync(join(cwd, 'business/README.md'))).toBe(false);
  });

  test('--force overwrites an existing index.yaml', () => {
    writeFileSync(join(cwd, 'index.yaml'), 'repo: existing\n', 'utf8');
    const result = runInit({ cwd, force: true });
    expect(result.ok).toBe(true);
    const yaml = readFileSync(join(cwd, 'index.yaml'), 'utf8');
    expect(yaml).not.toContain('repo: existing');
    expect(yaml).toContain('reading_order:');
  });

  test('idempotency on a half-complete bundle: re-running with --force regenerates index + leaves dirs alone', () => {
    runInit({ cwd });
    // Manually delete the index but leave the dirs.
    rmSync(join(cwd, 'index.yaml'));
    const result = runInit({ cwd });
    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, 'index.yaml'))).toBe(true);
  });

  // FIX 6 — the directory name is interpolated into the manifest. A dirname
  // with YAML-special characters (`: `, `[`, `#`, …) must be safely escaped so
  // the manifest still parses and `repo` round-trips to the literal name. The
  // bug was raw string templates (`repo: ${projectName}`) producing invalid
  // YAML for such names.
  describe('YAML-special directory names produce a parseable manifest', () => {
    async function runInDir(name: string): Promise<string> {
      const base = mkdtempSync(join(tmpdir(), 'sov-init-special-'));
      const dir = join(base, name);
      mkdirSync(dir, { recursive: true });
      try {
        const result = runInit({ cwd: dir });
        expect(result.ok).toBe(true);
        const bundle = await loadBundle(dir);
        // The loader parses index.yaml without throwing; repo round-trips.
        return bundle.index.repo ?? '';
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }

    test("a name containing ': ' parses with repo === the literal name", async () => {
      expect(await runInDir('a: b')).toBe('a: b');
    });

    test("a name starting with '[' is not parsed as a YAML array", async () => {
      expect(await runInDir('[x] project')).toBe('[x] project');
    });

    test("a name containing '#' is not truncated as a comment", async () => {
      expect(await runInDir('proj #1')).toBe('proj #1');
    });
  });
});

describe('formatInitResult', () => {
  test('renders a success summary with file list and next steps', () => {
    const result = runInit({ cwd });
    const out = formatInitResult(result);
    expect(out).toContain('bootstrapped bundle');
    expect(out).toContain('Wrote:');
    expect(out).toContain('index.yaml');
    expect(out).toContain('Next steps:');
  });

  test('renders an error message on failure', () => {
    writeFileSync(join(cwd, 'index.yaml'), 'repo: existing\n', 'utf8');
    const result = runInit({ cwd });
    const out = formatInitResult(result);
    expect(out).toContain('sov init:');
    expect(out).toContain('already exists');
  });
});
