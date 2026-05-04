// Phase 12.6 — context budget audit. Validates token estimation,
// threshold flagging, classification, and report formatting.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  DEFAULT_BUDGET_THRESHOLDS,
  auditContextBudget,
  formatBudgetReport,
} from '../../src/context/budget.js';
import type { Skill } from '../../src/skills/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool } from '../../src/tool/types.js';

function makeTool(
  name: string,
  opts: { defer?: boolean; description?: string } = {},
): Tool<unknown, unknown> {
  return buildTool({
    name,
    description: () => opts.description ?? `${name} tool`,
    inputSchema: z.object({}),
    ...(opts.defer ? { shouldDefer: true as const } : {}),
    async call() {
      return { data: {} };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function makeSkill(name: string, body: string, requires: string[] = []): Skill {
  return {
    name,
    description: `${name} description`,
    whenToUse: 'User asks for it',
    allowedTools: [],
    path: `/tmp/${name}.md`,
    realpath: `/tmp/${name}.md`,
    dir: '/tmp',
    source: 'project',
    trustTier: 'trusted',
    metadata: {
      harness: {
        requiresToolsets: [],
        requiresTools: requires,
        fallbackForToolsets: [],
        fallbackForTools: [],
      },
    },
    guard: { action: 'allow', findings: [] },
    body,
  };
}

describe('auditContextBudget', () => {
  test('reports zero components on an empty audit', () => {
    const r = auditContextBudget({});
    expect(r.components).toEqual([]);
    expect(r.totals.estimated).toBe(0);
  });

  test('counts system-prompt segments and applies the heavy threshold', () => {
    // 12000 chars / 4 chars-per-token ≈ 3000 tokens — clearly above extreme (2000).
    const segment = { text: 'a'.repeat(12000), cacheable: true };
    const r = auditContextBudget({ systemSegments: [segment] });
    expect(r.components.length).toBe(1);
    const c = r.components[0];
    expect(c?.kind).toBe('system-segment');
    expect(c?.tokens).toBeGreaterThan(DEFAULT_BUDGET_THRESHOLDS.systemSegment.heavy);
    expect(c?.bloat).toBe('extreme');
  });

  test('counts tool schemas and classifies deferred tools as sometimes', () => {
    const native = makeTool('Bash');
    const deferred = makeTool('mcp__github__create_issue', { defer: true });
    const r = auditContextBudget({ tools: [native, deferred] });
    const bash = r.components.find((c) => c.name === 'Bash');
    const mcp = r.components.find((c) => c.name === 'mcp__github__create_issue');
    expect(bash?.classification).toBe('always');
    expect(mcp?.classification).toBe('sometimes');
  });

  test('classifies skills with requires_tools that match active toolset as always', () => {
    const matching = makeSkill('git-active', 'body', ['Bash']);
    const missing = makeSkill('git-inactive', 'body', ['DoesNotExist']);
    const r = auditContextBudget({
      skills: [matching, missing],
      activeToolNames: ['Bash'],
    });
    expect(r.components.find((c) => c.name === 'git-active')?.classification).toBe('always');
    expect(r.components.find((c) => c.name === 'git-inactive')?.classification).toBe('rarely');
  });

  test('emits utilization ratio when contextWindow is provided', () => {
    const segment = { text: 'a'.repeat(4000), cacheable: true };
    const r = auditContextBudget({ systemSegments: [segment], contextWindow: 200_000 });
    expect(r.totals.window).toBe(200_000);
    expect(r.totals.utilization).toBeDefined();
    expect(r.totals.utilization).toBeLessThan(0.01);
  });

  test('counts memory files based on chars/4 estimate', () => {
    const r = auditContextBudget({
      memory: [{ name: 'MEMORY.md', path: '/x/MEMORY.md', chars: 8000 }],
    });
    const m = r.components.find((c) => c.kind === 'memory');
    expect(m?.tokens).toBe(2000);
    expect(m?.bloat).toBe('heavy');
  });

  test('respects threshold overrides', () => {
    const tool = makeTool('Big');
    const r = auditContextBudget({
      tools: [tool],
      thresholds: { toolSchema: { heavy: 50, extreme: 100 } },
    });
    const c = r.components.find((c) => c.kind === 'tool-schema');
    // Native heuristic adds 200 tokens; overridden thresholds flag it extreme.
    expect(c?.bloat).toBe('extreme');
  });
});

describe('formatBudgetReport', () => {
  test('includes a total estimate header', () => {
    const r = auditContextBudget({});
    expect(formatBudgetReport(r)).toContain('total estimate');
  });

  test('includes utilization percentage when window is set', () => {
    const segment = { text: 'short', cacheable: true };
    const r = auditContextBudget({ systemSegments: [segment], contextWindow: 1000 });
    expect(formatBudgetReport(r)).toMatch(/total estimate.*\(.*%\)/);
  });

  test('groups components by kind', () => {
    const r = auditContextBudget({
      systemSegments: [{ text: 'sys', cacheable: true }],
      tools: [makeTool('Bash')],
      skills: [makeSkill('s', 'b')],
    });
    const out = formatBudgetReport(r);
    expect(out).toContain('system prompt');
    expect(out).toContain('tool schemas');
    expect(out).toContain('skills');
  });
});
