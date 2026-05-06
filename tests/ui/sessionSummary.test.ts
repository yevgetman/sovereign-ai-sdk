import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { type SessionMetrics, renderSessionSummary } from '../../src/ui/sessionSummary.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

const baseMetrics: SessionMetrics = {
  sessionId: 'sess-1',
  startedAtMs: 0,
  endedAtMs: 1000,
  agentActiveMs: 1000,
  apiTimeMs: 800,
  toolTimeMs: 100,
  toolCalls: 5,
  toolOk: 5,
  toolErr: 0,
};

describe('renderSessionSummary', () => {
  test('renders all sections with formatted durations', () => {
    const out = strip(
      renderSessionSummary({
        sessionId: 'd2bb51f0-624d-494e-aa4c-f84b52ffb754',
        startedAtMs: 1_000,
        endedAtMs: 64_000,
        agentActiveMs: 12_000,
        apiTimeMs: 9_000,
        toolTimeMs: 3_000,
        toolCalls: 4,
        toolOk: 3,
        toolErr: 1,
      }),
    );
    expect(out).toContain('Agent powering down');
    expect(out).toContain('Interaction Summary');
    expect(out).toContain('Performance');
    expect(out).toContain('d2bb51f0-624d-494e-aa4c-f84b52ffb754');
    expect(out).toContain('Tool Calls:');
    expect(out).toContain('4');
    expect(out).toContain('✓ 3');
    expect(out).toContain('✗ 1');
    expect(out).toContain('Success Rate:');
    expect(out).toContain('75.0%');
    expect(out).toContain('Wall Time:');
    expect(out).toContain('1m 3s');
    expect(out).toContain('Agent Active:');
    expect(out).toContain('12s');
    expect(out).toContain('API Time:');
    expect(out).toContain('9s');
    expect(out).toContain('Tool Time:');
    expect(out).toContain('3s');
  });

  test('handles zero tool calls without dividing by zero', () => {
    const out = strip(
      renderSessionSummary({
        sessionId: 'abc',
        startedAtMs: 0,
        endedAtMs: 500,
        agentActiveMs: 0,
        apiTimeMs: 0,
        toolTimeMs: 0,
        toolCalls: 0,
        toolOk: 0,
        toolErr: 0,
      }),
    );
    expect(out).toContain('Success Rate:');
    expect(out).toContain('0.0%');
    expect(out).toContain('500ms');
  });
});

describe('renderSessionSummary reviews block (B3)', () => {
  test('omits Reviews section when reviews field is absent', () => {
    const out = strip(renderSessionSummary(baseMetrics));
    expect(out).not.toContain('Reviews');
  });

  test('omits Reviews section when totalDispatched === 0', () => {
    const out = strip(
      renderSessionSummary({
        ...baseMetrics,
        reviews: { totalDispatched: 0, byAgent: {} },
      }),
    );
    expect(out).not.toContain('Reviews');
  });

  test('renders Reviews section with dispatch count and breakdown', () => {
    const out = strip(
      renderSessionSummary({
        ...baseMetrics,
        reviews: {
          totalDispatched: 3,
          byAgent: { 'review-memory': 2, 'review-consolidate': 1 },
        },
      }),
    );
    expect(out).toContain('Reviews');
    expect(out).toContain('Dispatched:');
    expect(out).toMatch(/3\s+\(memory=2/);
    expect(out).toContain('consolidate=1');
  });

  test('strips review- prefix from agent names in breakdown', () => {
    const out = strip(
      renderSessionSummary({
        ...baseMetrics,
        reviews: {
          totalDispatched: 1,
          byAgent: { 'review-skill': 1 },
        },
      }),
    );
    expect(out).toContain('skill=1');
    expect(out).not.toContain('review-skill=1');
  });

  test('skips agents with zero count in breakdown', () => {
    const out = strip(
      renderSessionSummary({
        ...baseMetrics,
        reviews: {
          totalDispatched: 2,
          byAgent: { 'review-memory': 2, 'review-skill': 0 },
        },
      }),
    );
    expect(out).toContain('memory=2');
    expect(out).not.toContain('skill=0');
  });
});
