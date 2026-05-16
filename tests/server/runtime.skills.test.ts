// Phase 16.1 M8 T4 — buildRuntime loads the skill registry once and exposes
// it on Runtime. Per-call filtering (inferActiveToolsets +
// filterSkillRegistry) happens inside buildSessionToolContext so the
// registry stored on Runtime is the unfiltered superset. Closes phase-16
// prereq row 20.
//
// The runtime mounts the shipped bundle-default by default when no
// bundleRoot is supplied, so `loadSkills` walks bundle-default/skills/
// (review.md, security-audit.md, summarize.md). This test pins:
//   1. runtime.skills is defined
//   2. The registry has at least one skill
//   3. The well-known bundle-default 'review' skill is present
//   4. byName is a Map (lookup contract used by T5's /skillname dispatch)
// Without this wiring, the server-mode TUI's /skills surface (the T4 GET
// route below) and the T5 skill-as-slash expansion both have nowhere to
// read the registry from.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — skills loaded (M8 T4)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t4-skills-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('runtime.skills populated from bundle-default skills', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      expect(runtime.skills).toBeDefined();
      expect(runtime.skills.skills.length).toBeGreaterThan(0);
      // At least one well-known bundle-default skill is present.
      const skillNames = runtime.skills.skills.map((s) => s.name);
      expect(skillNames).toContain('review');
      // byName is the Map used by T5 for /skillname dispatch — pin the
      // shape so a future refactor to a plain record breaks the test
      // rather than silently breaking the lookup.
      expect(runtime.skills.byName).toBeInstanceOf(Map);
      expect(runtime.skills.byName.get('review')).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  });
});
