// Phase 13.1 — verify the three reference agents shipped in bundle-default/
// load cleanly with the live loader. Guards against regressions if a future
// change to the loader's frontmatter schema invalidates the shipped files.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents } from '../../src/agents/loader.js';

const BUNDLE_DEFAULT_ROOT = join(import.meta.dir, '..', '..', 'bundle-default');

describe('bundle-default reference agents', () => {
  test('explore, verify, plan all load with builtin trust tier', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'sovereign-bundle-default-'));
    try {
      const warnings: string[] = [];
      const registry = await loadAgents({
        cwd: tmpHome,
        harnessHome: tmpHome,
        bundleRoot: BUNDLE_DEFAULT_ROOT,
        warn: (m) => warnings.push(m),
      });
      expect(warnings).toEqual([]);
      const names = registry.agents.map((a) => a.name).sort();
      expect(names).toEqual(['explore', 'plan', 'verify']);
      for (const a of registry.agents) {
        expect(a.source).toBe('bundle');
        expect(a.trustTier).toBe('builtin');
        expect(a.readOnly).toBe(true);
        expect(a.systemPrompt.length).toBeGreaterThan(100);
        expect(a.allowedTools.length).toBeGreaterThan(0);
        expect(a.role).toBeDefined();
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
