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
      expect(names).toEqual([
        'explore',
        'plan',
        'review-consolidate',
        'review-memory',
        'review-skill',
        'verify',
      ]);
      for (const a of registry.agents) {
        expect(a.source).toBe('bundle');
        expect(a.trustTier).toBe('builtin');
        expect(a.systemPrompt.length).toBeGreaterThan(100);
        expect(a.allowedTools.length).toBeGreaterThan(0);
        expect(a.role).toBeDefined();
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('review-memory, review-skill, review-consolidate load with restricted toolsets', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'sovereign-review-agents-'));
    try {
      const registry = await loadAgents({
        cwd: tmpHome,
        harnessHome: tmpHome,
        bundleRoot: BUNDLE_DEFAULT_ROOT,
      });

      const mem = registry.byName.get('review-memory');
      expect(mem).toBeDefined();
      expect(mem?.allowedTools).toContain('memory_propose');
      expect(mem?.allowedTools).toContain('Read');
      expect(mem?.allowedTools).toContain('Grep');
      expect(mem?.allowedTools).toContain('Glob');
      expect(mem?.maxTurns).toBe(6);
      expect(mem?.role).toBe('review');

      const skill = registry.byName.get('review-skill');
      expect(skill).toBeDefined();
      expect(skill?.allowedTools).toContain('skill_propose');
      expect(skill?.allowedTools).toContain('Read');
      expect(skill?.allowedTools).toContain('Grep');
      expect(skill?.allowedTools).toContain('Glob');
      expect(skill?.maxTurns).toBe(6);
      expect(skill?.role).toBe('review');

      const cons = registry.byName.get('review-consolidate');
      expect(cons).toBeDefined();
      expect(cons?.allowedTools).toContain('memory_propose');
      expect(cons?.allowedTools).toContain('Read');
      expect(cons?.allowedTools).toContain('Grep');
      expect(cons?.allowedTools).toContain('Glob');
      expect(cons?.maxTurns).toBe(8);
      expect(cons?.role).toBe('review');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
