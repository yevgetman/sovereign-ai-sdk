import { describe, expect, test } from 'bun:test';

// Test the EventRenderer in isolation by capturing stdout writes.

describe('drive EventRenderer — delegator events', () => {
  test('delegator_plan renders plain-text line', async () => {
    const { EventRenderer } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    const renderer = new EventRenderer(false, 'http://localhost:3000', (s: string) => {
      writes.push(s);
    });
    renderer.handle({
      type: 'delegator_plan',
      seq: 1,
      sessionId: 'root',
    } as never);
    expect(writes.join('')).toContain('[delegator_plan]');
    expect(writes.join('')).toContain('dispatching');
  });

  test('delegator_atom_started renders with index, lane, and preview', async () => {
    const { EventRenderer } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    const renderer = new EventRenderer(false, 'http://localhost:3000', (s: string) => {
      writes.push(s);
    });
    renderer.handle({
      type: 'delegator_atom_started',
      seq: 2,
      sessionId: 'root',
      atomIndex: 0,
      laneName: 'cheap-task',
      promptPreview: 'list files',
    } as never);
    const out = writes.join('');
    expect(out).toContain('[delegator_atom');
    expect(out).toContain('cheap-task');
    expect(out).toContain('list files');
  });

  test('delegator_atom_complete success renders ok marker', async () => {
    const { EventRenderer } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    const renderer = new EventRenderer(false, 'http://localhost:3000', (s: string) => {
      writes.push(s);
    });
    renderer.handle({
      type: 'delegator_atom_complete',
      seq: 3,
      sessionId: 'root',
      atomIndex: 0,
      laneName: 'cheap-task',
      success: true,
      durationMs: 123,
    } as never);
    const out = writes.join('');
    expect(out).toContain('[delegator_atom');
    expect(out).toContain('cheap-task');
    expect(out).toContain('123ms');
    expect(out).toContain('ok');
  });

  test('delegator_atom_complete failure renders failed marker', async () => {
    const { EventRenderer } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    const renderer = new EventRenderer(false, 'http://localhost:3000', (s: string) => {
      writes.push(s);
    });
    renderer.handle({
      type: 'delegator_atom_complete',
      seq: 3,
      sessionId: 'root',
      atomIndex: 1,
      laneName: 'moderate-task',
      success: false,
      durationMs: 456,
    } as never);
    const out = writes.join('');
    expect(out).toContain('failed');
  });

  test('delegator_complete renders total + lane distribution', async () => {
    const { EventRenderer } = await import('../../src/cli/driveCommand.js');
    const writes: string[] = [];
    const renderer = new EventRenderer(false, 'http://localhost:3000', (s: string) => {
      writes.push(s);
    });
    renderer.handle({
      type: 'delegator_complete',
      seq: 4,
      sessionId: 'root',
      totalAtomCount: 3,
      laneDistribution: { 'cheap-task': 2, 'moderate-task': 1 },
    } as never);
    const out = writes.join('');
    expect(out).toContain('[delegator_complete]');
    expect(out).toContain('3 atoms');
    expect(out).toContain('cheap-task=2');
    expect(out).toContain('moderate-task=1');
  });
});
