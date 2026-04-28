import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { renderSessionSummary } from '../../src/ui/sessionSummary.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

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
