// Phase 13.1 — verify the three reference agents shipped in bundle-default/
// load cleanly with the live loader. Guards against regressions if a future
// change to the loader's frontmatter schema invalidates the shipped files.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents } from '@yevgetman/sov-sdk/agents/loader';

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
        'cheap-task',
        'delegator',
        'explore',
        'frontier-task',
        'instinct-synthesizer',
        'moderate-task',
        'plan',
        'review-consolidate',
        'review-memory',
        'review-skill',
        'scheduled-mission',
        'subscription-executor',
        'verify',
      ]);
      // Cost-lane agents inherit the parent's tools via inheritParentTools=true,
      // so they intentionally declare no explicit allowedTools.
      const costLaneAgents = new Set(['cheap-task', 'moderate-task', 'frontier-task']);
      // SPIKE — the subscription-executor delegates to a headless `claude -p`
      // subprocess that runs its OWN tools, so the harness-side allowedTools is
      // intentionally empty (no harness tool pool is handed to the subprocess).
      const noHarnessToolsAgents = new Set(['subscription-executor']);
      for (const a of registry.agents) {
        expect(a.source).toBe('bundle');
        expect(a.trustTier).toBe('builtin');
        expect(a.systemPrompt.length).toBeGreaterThan(100);
        if (costLaneAgents.has(a.name)) {
          expect(a.inheritParentTools).toBe(true);
        } else if (!noHarnessToolsAgents.has(a.name)) {
          expect(a.allowedTools.length).toBeGreaterThan(0);
        }
        // scheduled-mission is name-invoked (--agent scheduled-mission), not
        // capability-routed via a role, so role is intentionally absent.
        if (a.name !== 'scheduled-mission') {
          expect(a.role).toBeDefined();
        }
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

  test('review-memory + review-skill allowedTools include the read-only instinct tools (Phase 13.4 T8)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'sovereign-review-instinct-'));
    try {
      const registry = await loadAgents({
        cwd: tmpHome,
        harnessHome: tmpHome,
        bundleRoot: BUNDLE_DEFAULT_ROOT,
      });

      const mem = registry.byName.get('review-memory');
      const skill = registry.byName.get('review-skill');
      const cons = registry.byName.get('review-consolidate');

      expect(mem?.allowedTools).toContain('instinct_list');
      expect(mem?.allowedTools).toContain('instinct_view');
      expect(mem?.allowedTools).not.toContain('instinct_propose');
      expect(mem?.allowedTools).not.toContain('instinct_update_confidence');

      expect(skill?.allowedTools).toContain('instinct_list');
      expect(skill?.allowedTools).toContain('instinct_view');
      expect(skill?.allowedTools).not.toContain('instinct_propose');
      expect(skill?.allowedTools).not.toContain('instinct_update_confidence');

      // review-consolidate doesn't read instincts — it operates on MEMORY.md
      expect(cons?.allowedTools).not.toContain('instinct_list');
      expect(cons?.allowedTools).not.toContain('instinct_view');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('instinct-synthesizer loads with restricted toolset', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'sovereign-synthesizer-'));
    try {
      const registry = await loadAgents({
        cwd: tmpHome,
        harnessHome: tmpHome,
        bundleRoot: BUNDLE_DEFAULT_ROOT,
      });

      const synth = registry.byName.get('instinct-synthesizer');
      expect(synth).toBeDefined();
      // Task 14 — raised 8 → 16 so a real synthesis pass isn't truncated.
      expect(synth?.maxTurns).toBe(16);
      expect(synth?.role).toBe('synthesizer');

      // Required: read-only inspection + the four instinct tools
      expect(synth?.allowedTools).toContain('Read');
      expect(synth?.allowedTools).toContain('Grep');
      expect(synth?.allowedTools).toContain('instinct_list');
      expect(synth?.allowedTools).toContain('instinct_view');
      expect(synth?.allowedTools).toContain('instinct_propose');
      expect(synth?.allowedTools).toContain('instinct_update_confidence');

      // Excluded: dangerous / write-path tools — synthesizer only mutates via instinct tools
      expect(synth?.allowedTools).not.toContain('FileWrite');
      expect(synth?.allowedTools).not.toContain('FileEdit');
      expect(synth?.allowedTools).not.toContain('Bash');
      expect(synth?.allowedTools).not.toContain('memory');
      expect(synth?.allowedTools).not.toContain('memory_propose');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
