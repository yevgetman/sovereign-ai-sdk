// System-prompt assembly tests for Phase 6 segmentation and cache controls.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Bundle } from '@yevgetman/sov-sdk/bundle/types';
import {
  buildSystemSegments,
  formatSkillsIndex,
  formatTools,
} from '@yevgetman/sov-sdk/context/systemPrompt';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

function makeBundle(root: string): Bundle {
  return {
    root,
    index: {},
    business: new Map(),
    state: {
      context: 'bundle briefing',
      preferences: 'prefer concise answers',
      decisionsMade: 'decision digest',
      sessionLog: null,
    },
    schemaPaths: {
      entity: join(root, 'entity.json'),
      decision: join(root, 'decision.json'),
      openQuestion: join(root, 'open-question.json'),
      tags: join(root, 'tags.yaml'),
    },
  };
}

function makeTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'Echo',
    description: () => 'echo input',
    inputSchema: z.object({ text: z.string() }),
    async call(input) {
      return { data: input };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function makeSkill(): Skill {
  return {
    name: 'simplify',
    description: 'Review code for reuse and quality',
    whenToUse: 'User asks to simplify code',
    allowedTools: ['Read', 'Edit'],
    path: '/tmp/simplify.md',
    realpath: '/tmp/simplify.md',
    dir: dirname('/tmp/simplify.md'),
    source: 'project',
    trustTier: 'trusted',
    allowShellInterpolation: true,
    metadata: {
      harness: {
        requiresToolsets: [],
        requiresTools: [],
        fallbackForToolsets: [],
        fallbackForTools: [],
      },
    },
    guard: { action: 'allow', findings: [] },
    body: 'Simplify {{args}}.',
  };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-system-prompt-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildSystemSegments', () => {
  test('assembles static-to-dynamic segments with expected cache boundaries', async () => {
    await withTmp(async (dir) => {
      const home = join(dir, 'home');
      const cwd = join(home, 'project');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'AGENTS.md'), 'local project instructions');

      const segments = buildSystemSegments({
        bundle: makeBundle(dir),
        tools: [makeTool()],
        skills: [makeSkill()],
        cwd,
        homeDir: home,
        now: new Date('2026-04-25T12:00:00.000Z'),
        warn: () => {},
      });

      expect(segments.length).toBeGreaterThanOrEqual(6);
      expect(segments[0]?.cacheable).toBe(true);
      expect(segments.some((segment) => segment.text.includes('<available-tools>'))).toBe(true);
      expect(segments.some((segment) => segment.text.includes('<skills>'))).toBe(true);
      expect(segments.some((segment) => segment.text.includes('<bundle-context>'))).toBe(true);
      expect(segments.some((segment) => segment.text.includes('prefer concise answers'))).toBe(
        true,
      );
      expect(
        segments.some((segment) =>
          segment.text.includes('prefer direct tool writes or small targeted'),
        ),
      ).toBe(true);
      expect(segments.some((segment) => segment.text.includes('node --check file.js'))).toBe(true);
      expect(segments.some((segment) => segment.text.includes('bun run typecheck'))).toBe(true);
      expect(segments.some((segment) => segment.text.includes('StaticSiteValidate'))).toBe(true);
      expect(segments.some((segment) => segment.text.includes('If no suitable validator'))).toBe(
        true,
      );

      const runtime = segments.find((segment) => segment.text.includes('<runtime-context>'));
      expect(runtime?.cacheable).toBe(false);
      expect(runtime?.text).toContain('date: 2026-04-25T12:00:00.000Z');

      const user = segments.find((segment) => segment.text.includes('<user-context>'));
      expect(user?.cacheable).toBe(false);
      expect(user?.text).toContain('local project instructions');
    });
  });

  test('includes a vendor-neutral harness-self-doc segment with settings paths and schema', async () => {
    await withTmp(async (dir) => {
      const segments = buildSystemSegments({
        tools: [makeTool()],
        cwd: dir,
        homeDir: dir,
        warn: () => {},
      });
      const selfDoc = segments.find((s) => s.text.includes('<harness-self-doc>'));
      expect(selfDoc).toBeDefined();
      expect(selfDoc?.cacheable).toBe(true);
      // Settings layer paths (vendor-neutral — uses <harness-home>, not ~/.harness).
      expect(selfDoc?.text).toContain('.harness/settings.local.json');
      expect(selfDoc?.text).toContain('.harness/settings.json');
      expect(selfDoc?.text).toContain('<harness-home>/settings.json');
      // Schema keys + the trap (config.json holds provider/theme, not mcpServers).
      expect(selfDoc?.text).toContain('mcpServers');
      expect(selfDoc?.text).toContain('PreToolUse');
      expect(selfDoc?.text).toContain('config.json');
      // Mcp permission rule grammar including the server-prefix form.
      expect(selfDoc?.text).toContain('mcp__<server>');
      // No vendor branding leaks into a white-label runtime prompt.
      expect(selfDoc?.text).not.toContain('Sovereign');
    });
  });

  test('--no-cache disables every cache marker', async () => {
    await withTmp(async (dir) => {
      const segments = buildSystemSegments({
        bundle: makeBundle(dir),
        tools: [makeTool()],
        cwd: dir,
        homeDir: dir,
        cacheEnabled: false,
        warn: () => {},
      });
      expect(segments.every((segment) => segment.cacheable === false)).toBe(true);
    });
  });

  test('omits bundle segments when no bundle is supplied (generic-agent mode)', async () => {
    await withTmp(async (dir) => {
      const segments = buildSystemSegments({
        tools: [makeTool()],
        skills: [makeSkill()],
        cwd: dir,
        homeDir: dir,
        now: new Date('2026-04-25T12:00:00.000Z'),
        warn: () => {},
      });

      // Generic base prompt + tools + skills + runtime context, no bundle
      // segments and no Sovereign-specific identity language baked in.
      expect(segments.some((s) => s.text.includes('<bundle-context>'))).toBe(false);
      expect(segments.some((s) => s.text.includes('<bundle-preferences>'))).toBe(false);
      expect(segments.some((s) => s.text.includes('canonical AI entity'))).toBe(false);
      expect(segments.some((s) => s.text.includes('<runtime-context>'))).toBe(true);
      expect(segments.some((s) => s.text.includes('<available-tools>'))).toBe(true);
    });
  });

  // Phase 13.4 follow-up (Item 19) — memory-scope segment.
  test('memory-scope segment in harness mode (no project) describes general-purpose contract', async () => {
    await withTmp(async (dir) => {
      const segments = buildSystemSegments({
        cwd: dir,
        homeDir: dir,
        warn: () => {},
      });
      const all = segments.map((s) => s.text).join('\n\n');
      expect(all).toContain('<memory-scope>');
      expect(all).toContain('no project context');
      expect(all).toContain("scope='project'");
      // Cacheable: scope is stable for the session.
      const scopeSeg = segments.find((s) => s.text.includes('<memory-scope>'));
      expect(scopeSeg?.cacheable).toBe(true);
    });
  });

  test('memory-scope segment in project mode names the project + describes the routing default', async () => {
    await withTmp(async (dir) => {
      const segments = buildSystemSegments({
        cwd: dir,
        homeDir: dir,
        warn: () => {},
        projectScope: { kind: 'project', id: 'sov-docs', name: 'sovereign-ai-docs' },
      });
      const all = segments.map((s) => s.text).join('\n\n');
      expect(all).toContain('sovereign-ai-docs');
      expect(all).toContain('sov-docs');
      expect(all).toContain("defaults to scope='project'");
      expect(all).toContain('USER.md is always global');
      const scopeSeg = segments.find((s) => s.text.includes('<memory-scope>'));
      expect(scopeSeg?.cacheable).toBe(true);
    });
  });

  test('memory-scope segment with kind=none uses harness-mode wording', async () => {
    await withTmp(async (dir) => {
      const segments = buildSystemSegments({
        cwd: dir,
        homeDir: dir,
        warn: () => {},
        projectScope: { kind: 'none' },
      });
      const all = segments.map((s) => s.text).join('\n\n');
      expect(all).toContain('no project context');
      expect(all).not.toContain("defaults to scope='project'");
    });
  });

  test('memory-scope segment respects cacheEnabled=false', async () => {
    await withTmp(async (dir) => {
      const segments = buildSystemSegments({
        cwd: dir,
        homeDir: dir,
        cacheEnabled: false,
        warn: () => {},
        projectScope: { kind: 'project', id: 'p1', name: 'project-one' },
      });
      const scopeSeg = segments.find((s) => s.text.includes('<memory-scope>'));
      expect(scopeSeg).toBeDefined();
      expect(scopeSeg?.cacheable).toBe(false);
    });
  });
});

describe('formatTools', () => {
  test('renders stable tool names and descriptions', () => {
    expect(formatTools([makeTool()])).toContain('- Echo: echo input');
  });
});

describe('formatSkillsIndex', () => {
  test('renders progressive disclosure reminder without skill names', () => {
    const text = formatSkillsIndex([makeSkill()]);
    expect(text).toContain('Use skills_list at the start of each task');
    expect(text).not.toContain('simplify');
  });
});
