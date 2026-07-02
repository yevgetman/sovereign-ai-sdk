// Tests for surviving prompt.ts exports (post-M13 readline-asker removal):
// serializeAskUser + previewToolInput. canUseTool.ts is their only consumer.

import { describe, expect, test } from 'bun:test';
import { previewToolInput, serializeAskUser } from '@yevgetman/sov-sdk/permissions/prompt';

describe('previewToolInput', () => {
  test('renders Bash commands directly', () => {
    expect(previewToolInput({ command: 'ls src/' })).toBe('ls src/');
  });

  test('truncates long commands with ellipsis', () => {
    const long = 'echo '.repeat(30);
    const out = previewToolInput({ command: long });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('...')).toBe(true);
  });

  test('falls back to JSON for non-Bash inputs', () => {
    const out = previewToolInput({ path: '/tmp/x', depth: 3 });
    expect(out).toContain('path');
    expect(out).toContain('/tmp/x');
  });

  test('returns empty string for null/undefined', () => {
    expect(previewToolInput(null)).toBe('');
    expect(previewToolInput(undefined)).toBe('');
  });
});

describe('serializeAskUser', () => {
  test('queues concurrent asks so only one prompt runs at a time', async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const ask = serializeAskUser(async ({ toolName }) => {
      order.push(`start:${toolName}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`end:${toolName}`);
      return 'allow';
    });

    const first = ask({ toolName: 'A', preview: '' });
    const second = ask({ toolName: 'B', preview: '' });

    await Promise.resolve();
    expect(order).toEqual(['start:A']);

    releases[0]?.();
    await expect(first).resolves.toBe('allow');
    await Promise.resolve();
    expect(order).toEqual(['start:A', 'end:A', 'start:B']);

    releases[1]?.();
    await expect(second).resolves.toBe('allow');
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });
});
