// Phase 16.1 M8 T4 — GET /sessions/:id/skills route.
//
// Returns a JSON view of the per-call filtered skill registry so the Go
// TUI can render `/skills` discovery without re-walking the bundle.
// Filter inputs (active toolset + active tool list) are derived from the
// runtime's toolPool — the registry stored on Runtime is unfiltered; the
// route filters per request so a future per-session filter narrowing
// (e.g. project-mode disabling Bash) drops into the same code path
// without touching buildRuntime. Validation matches the sibling routes:
//   200 — registry projected to { name, whenToUse, description } entries
//   400 — id fails isValidSessionId
//   404 — id is shape-valid but not in sessionDb

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../../src/server/app.js';
import { buildRuntime } from '../../../src/server/runtime.js';

describe('GET /sessions/:id/skills (M8 T4)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t4-route-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('returns filtered skill registry', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const skillsRes = await app.request(`/sessions/${sessionId}/skills`);
      expect(skillsRes.status).toBe(200);
      const body = (await skillsRes.json()) as {
        skills: Array<{ name: string; whenToUse: string; description: string }>;
      };
      expect(Array.isArray(body.skills)).toBe(true);
      expect(body.skills.length).toBeGreaterThan(0);
      expect(body.skills[0]?.name).toBeDefined();
      // whenToUse + description are the two TUI-rendering fields per the
      // plan's wire-shape contract; verify both are present on every row.
      for (const skill of body.skills) {
        expect(typeof skill.name).toBe('string');
        expect(typeof skill.whenToUse).toBe('string');
        expect(typeof skill.description).toBe('string');
      }
    } finally {
      await runtime.dispose();
    }
  });

  test('404 on unknown session id', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      // A shape-valid id (matches isValidSessionId's character class) that
      // doesn't exist in sessionDb. Mirrors the sessions.ts 404 envelope.
      const res = await app.request('/sessions/00000000-0000-0000-0000-000000000000/skills');
      expect(res.status).toBe(404);
    } finally {
      await runtime.dispose();
    }
  });

  test('400 on malformed session id', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      // `not.a.uuid` contains periods — outside isValidSessionId's
      // `[A-Za-z0-9_-]+` character class, so the validator rejects it.
      const res = await app.request('/sessions/not.a.uuid/skills');
      expect(res.status).toBe(400);
    } finally {
      await runtime.dispose();
    }
  });
});

describe('POST /sessions/:id/skills/import (Feature A2)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-a2-import-route-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('imports a CC skill, normalizes frontmatter, returns converted/warnings', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed a Claude Code SKILL.md on disk visible to the server process.
      const srcDir = join(tmpHome, 'cc-src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(
        join(srcDir, 'SKILL.md'),
        `---
name: ported
description: A ported Claude Code skill
allowed-tools: Read, Grep
model: claude-opus-4
---

Body.
`,
      );

      const res = await app.request(`/sessions/${sessionId}/skills/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: srcDir }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        name: string;
        installedAt: string;
        converted: string[];
        warnings: string[];
      };
      expect(body.ok).toBe(true);
      expect(body.name).toBe('ported');
      expect(body.converted.some((c) => c.includes('allowed-tools'))).toBe(true);
      expect(body.warnings.some((w) => w.includes('model'))).toBe(true);

      // The landed SKILL.md carries canonical `allowedTools:` and no
      // hyphenated CC key.
      const written = readFileSync(join(tmpHome, 'skills', 'ported', 'SKILL.md'), 'utf8');
      expect(written).toContain('allowedTools:');
      expect(written).not.toContain('allowed-tools:');
    } finally {
      await runtime.dispose();
    }
  });

  test('400 with the importer reason when the skill fails schema validation', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const srcDir = join(tmpHome, 'broken-src');
      mkdirSync(srcDir, { recursive: true });
      // No description — the loader schema rejects it.
      writeFileSync(
        join(srcDir, 'SKILL.md'),
        '---\nname: broken\nallowed-tools: Read\n---\nBody.\n',
      );

      const res = await app.request(`/sessions/${sessionId}/skills/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: srcDir }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('description');
      expect(existsSync(join(tmpHome, 'skills', 'broken'))).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
