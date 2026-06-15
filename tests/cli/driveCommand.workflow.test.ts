import { describe, expect, test } from 'bun:test';

// Multi-agent workflows (2026-06-15) — `sov drive` surfaces workflow_* SSE
// events as plain text via the shared formatWorkflowEvent. These events are
// NOT part of ServerEventSchema (the main session-event union), so they fall
// through parseEventBlock to the workflow parse path; tested here through the
// exported parseWorkflowEventBlock / renderWorkflowEventBlock helpers.
//
// NOTE (central-integration seam): drive only renders these if the server's
// /workflow run path forwards the engine's WorkflowEventSink events onto the
// per-session bus. Until that server-emit seam is wired (owner C), this branch
// is a safe no-op at runtime — but the parse + render contract is pinned here.

function sseBlock(payload: Record<string, unknown>): string {
  return `event: message\ndata: ${JSON.stringify(payload)}`;
}

describe('drive — workflow event block parsing', () => {
  test('parseWorkflowEventBlock recognizes each workflow_* type', async () => {
    const { parseWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    const types = [
      'workflow_started',
      'workflow_phase_started',
      'workflow_task_started',
      'workflow_task_complete',
      'workflow_complete',
    ] as const;
    for (const type of types) {
      const ev = parseWorkflowEventBlock(sseBlock({ type, seq: 1, sessionId: 's' }));
      expect(ev).not.toBeNull();
      expect(ev?.type).toBe(type);
    }
  });

  test('parseWorkflowEventBlock returns null for a non-workflow event', async () => {
    const { parseWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    expect(parseWorkflowEventBlock(sseBlock({ type: 'text_delta', text: 'hi' }))).toBeNull();
  });

  test('parseWorkflowEventBlock returns null for a malformed block', async () => {
    const { parseWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    expect(parseWorkflowEventBlock('event: message\ndata: not-json')).toBeNull();
    expect(parseWorkflowEventBlock('no data line here')).toBeNull();
  });
});

describe('drive — workflow event rendering (formatWorkflowEvent contract)', () => {
  test('workflow_started renders the name + phase count', async () => {
    const { renderWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    renderWorkflowEventBlock(
      sseBlock({
        type: 'workflow_started',
        seq: 1,
        sessionId: 's',
        workflow: 'review-changes',
        phaseCount: 3,
      }),
      (s) => writes.push(s),
    );
    const out = writes.join('');
    expect(out).toContain('[workflow]');
    expect(out).toContain('review-changes');
    expect(out).toContain('3 phase(s)');
  });

  test('workflow_phase_started renders 1-based phase index + task count', async () => {
    const { renderWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    renderWorkflowEventBlock(
      sseBlock({
        type: 'workflow_phase_started',
        seq: 2,
        sessionId: 's',
        phaseId: 'find',
        index: 0,
        taskCount: 3,
      }),
      (s) => writes.push(s),
    );
    const out = writes.join('');
    expect(out).toContain('phase 1: find');
    expect(out).toContain('3 task(s)');
  });

  test('workflow_task_started renders phaseId/label + lane', async () => {
    const { renderWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    renderWorkflowEventBlock(
      sseBlock({
        type: 'workflow_task_started',
        seq: 3,
        sessionId: 's',
        phaseId: 'find',
        index: 1,
        label: 'security',
        lane: 'frontier',
      }),
      (s) => writes.push(s),
    );
    const out = writes.join('');
    expect(out).toContain('find/security');
    expect(out).toContain('(frontier)');
  });

  test('workflow_task_complete renders the success/failure glyph', async () => {
    const { renderWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    const okWrites: string[] = [];
    renderWorkflowEventBlock(
      sseBlock({
        type: 'workflow_task_complete',
        seq: 4,
        sessionId: 's',
        phaseId: 'find',
        index: 0,
        label: 'bugs',
        ok: true,
      }),
      (s) => okWrites.push(s),
    );
    expect(okWrites.join('')).toContain('✓ find/bugs');

    const failWrites: string[] = [];
    renderWorkflowEventBlock(
      sseBlock({
        type: 'workflow_task_complete',
        seq: 5,
        sessionId: 's',
        phaseId: 'verify',
        index: 2,
        label: 'finding-2',
        ok: false,
      }),
      (s) => failWrites.push(s),
    );
    expect(failWrites.join('')).toContain('✗ verify/finding-2');
  });

  test('workflow_complete renders the summary with failed tally + duration', async () => {
    const { renderWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    renderWorkflowEventBlock(
      sseBlock({
        type: 'workflow_complete',
        seq: 99,
        sessionId: 's',
        workflow: 'review-changes',
        ok: false,
        durationMs: 1234,
        phases: [
          { phaseId: 'find', total: 3, failed: 1 },
          { phaseId: 'verify', total: 2, failed: 1 },
        ],
      }),
      (s) => writes.push(s),
    );
    const out = writes.join('');
    expect(out).toContain('completed with errors');
    expect(out).toContain('2 failed task(s)');
    expect(out).toContain('1234ms');
  });

  test('renderWorkflowEventBlock is a no-op for a non-workflow block', async () => {
    const { renderWorkflowEventBlock } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    renderWorkflowEventBlock(sseBlock({ type: 'turn_complete', finishReason: 'stop' }), (s) =>
      writes.push(s),
    );
    expect(writes.join('')).toBe('');
  });
});
