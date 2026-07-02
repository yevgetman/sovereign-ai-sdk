// `/workflow` slash command (W4) — dispatch, listing, running, arg parsing,
// and the "not wired" degradation. The runtime-bearing `workflows` capability
// is stubbed so the command logic is tested without a live engine.

import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '@yevgetman/sov-sdk/commands/types';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import type { WorkflowCommandCapability, WorkflowSummary } from '../../src/commands/workflowOps.js';
import { dispatchWorkflowCommand, parseArgPairs } from '../../src/commands/workflowOps.js';
import type { WorkflowResult } from '../../src/workflows/engine.js';
import { makeCtx } from './_makeCtx.js';

function makeResult(overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  return {
    ok: true,
    phases: {},
    finalText: 'synthesized report',
    runSummary: { phases: [], durationMs: 12 },
    ...overrides,
  };
}

function ctxWithWorkflows(capability: WorkflowCommandCapability): CommandContext {
  return makeCtx({ ...({ workflows: capability } as Partial<CommandContext>) });
}

const SAMPLE_SUMMARIES: WorkflowSummary[] = [
  { name: 'review-changes', description: 'Review a diff', source: 'bundle', phaseCount: 3 },
  { name: 'audit', description: 'Audit the tree', source: 'project', phaseCount: 1 },
];

describe('/workflow dispatch', () => {
  test('the command is registered in the slash registry', async () => {
    // No capability wired → degrades gracefully through the full dispatcher.
    const result = await dispatchSlashCommand('/workflow list', makeCtx());
    expect(result.kind).toBe('local');
    if (result.kind === 'local') {
      expect(result.output).toMatch(/not wired/i);
    }
  });

  test('"not wired" when the surface omits the workflows capability', async () => {
    const out = await dispatchWorkflowCommand('list', makeCtx());
    expect(out).toMatch(/not wired/i);
  });

  test('bare /workflow lists workflows', async () => {
    const out = await dispatchWorkflowCommand(
      '',
      ctxWithWorkflows({ list: async () => SAMPLE_SUMMARIES, run: async () => makeResult() }),
    );
    expect(out).toContain('review-changes');
    expect(out).toContain('audit');
    expect(out).toContain('bundle');
    expect(out).toContain('project');
  });

  test('/workflow list with no workflows says so', async () => {
    const out = await dispatchWorkflowCommand(
      'list',
      ctxWithWorkflows({ list: async () => [], run: async () => makeResult() }),
    );
    expect(out).toMatch(/no workflows/i);
  });

  test('/workflow <name> runs the workflow and relays finalText', async () => {
    let ran: { name: string; args: Record<string, unknown> } | null = null;
    const out = await dispatchWorkflowCommand(
      'review-changes diff=abc dimensions=bugs',
      ctxWithWorkflows({
        list: async () => SAMPLE_SUMMARIES,
        run: async (name, args) => {
          ran = { name, args };
          return makeResult({ finalText: 'all clear' });
        },
      }),
    );
    expect(out).toBe('all clear');
    expect(ran).not.toBeNull();
    expect(ran as { name: string; args: Record<string, unknown> } | null).toEqual({
      name: 'review-changes',
      args: { diff: 'abc', dimensions: 'bugs' },
    });
  });

  // 2026-06-15 review fix M9 — a quoted multi-word value survives the slash
  // surface (the `review` workflow's `diff` arg) instead of shattering on
  // whitespace into an "invalid argument" error.
  test('/workflow <name> parses a quoted multi-word arg value', async () => {
    let ran: { name: string; args: Record<string, unknown> } | null = null;
    const out = await dispatchWorkflowCommand(
      'review-changes diff="the broken parser" dimensions=bugs,perf',
      ctxWithWorkflows({
        list: async () => SAMPLE_SUMMARIES,
        run: async (name, args) => {
          ran = { name, args };
          return makeResult({ finalText: 'ok' });
        },
      }),
    );
    expect(out).toBe('ok');
    expect(ran as { name: string; args: Record<string, unknown> } | null).toEqual({
      name: 'review-changes',
      args: { diff: 'the broken parser', dimensions: 'bugs,perf' },
    });
  });

  test('an empty finalText falls back to a status line', async () => {
    const out = await dispatchWorkflowCommand(
      'review-changes',
      ctxWithWorkflows({
        list: async () => SAMPLE_SUMMARIES,
        run: async () => makeResult({ finalText: '', ok: true }),
      }),
    );
    expect(out).toMatch(/review-changes completed/i);
  });

  test('a thrown run surfaces a friendly error', async () => {
    const out = await dispatchWorkflowCommand(
      'review-changes',
      ctxWithWorkflows({
        list: async () => SAMPLE_SUMMARIES,
        run: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(out).toMatch(/review-changes failed: boom/i);
  });

  test('an invalid k=v arg is rejected before running', async () => {
    let runCalled = false;
    const out = await dispatchWorkflowCommand(
      'review-changes notapair',
      ctxWithWorkflows({
        list: async () => SAMPLE_SUMMARIES,
        run: async () => {
          runCalled = true;
          return makeResult();
        },
      }),
    );
    expect(out).toMatch(/invalid argument/i);
    expect(runCalled).toBe(false);
  });
});

describe('parseArgPairs', () => {
  test('parses key=value tokens', () => {
    expect(parseArgPairs(['a=1', 'b=two'])).toEqual({ a: '1', b: 'two' });
  });

  test('keeps the value verbatim past the first =', () => {
    expect(parseArgPairs(['url=https://x?y=z'])).toEqual({ url: 'https://x?y=z' });
  });

  test('rejects a token with no =', () => {
    expect(() => parseArgPairs(['oops'])).toThrow(/expected key=value/);
  });

  test('rejects a leading-= token (empty key)', () => {
    expect(() => parseArgPairs(['=v'])).toThrow(/expected key=value/);
  });
});
