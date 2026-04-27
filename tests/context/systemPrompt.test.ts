// System-prompt assembly tests for Phase 6 segmentation and cache controls.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Bundle } from '../../src/bundle/types.js';
import {
  buildSystemSegments,
  formatSkillsIndex,
  formatTools,
} from '../../src/context/systemPrompt.js';
import type { Skill } from '../../src/skills/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool } from '../../src/tool/types.js';

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
