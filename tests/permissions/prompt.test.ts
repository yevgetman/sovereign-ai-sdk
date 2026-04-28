// parseAskResponse tests — pure string→enum parser. The readline wrapper is
// thin and exercised by the canUseTool tests via a scripted asker.

import { describe, expect, test } from 'bun:test';
import {
  buildReadlineAsker,
  parseAskResponse,
  previewToolInput,
  serializeAskUser,
} from '../../src/permissions/prompt.js';

describe('parseAskResponse', () => {
  test('y/yes → allow', () => {
    expect(parseAskResponse('y')).toBe('allow');
    expect(parseAskResponse('yes')).toBe('allow');
    expect(parseAskResponse(' Y ')).toBe('allow');
    expect(parseAskResponse('YES')).toBe('allow');
  });

  test('n/no → deny', () => {
    expect(parseAskResponse('n')).toBe('deny');
    expect(parseAskResponse('no')).toBe('deny');
    expect(parseAskResponse(' N ')).toBe('deny');
  });

  test('a/always → always', () => {
    expect(parseAskResponse('a')).toBe('always');
    expect(parseAskResponse('always')).toBe('always');
    expect(parseAskResponse(' ALWAYS ')).toBe('always');
  });

  test('empty line defaults to deny (safe default)', () => {
    expect(parseAskResponse('')).toBe('deny');
    expect(parseAskResponse('   ')).toBe('deny');
  });

  test('unrecognised input returns undefined so the caller re-prompts', () => {
    expect(parseAskResponse('maybe')).toBeUndefined();
    expect(parseAskResponse('1')).toBeUndefined();
    expect(parseAskResponse('yeah')).toBeUndefined();
  });
});

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

describe('buildReadlineAsker', () => {
  test('emits prompt and answer hooks', async () => {
    const events: unknown[] = [];
    const ask = buildReadlineAsker(async () => 'y', {
      onPrompt: (event) => events.push({ type: 'prompt', ...event }),
      onAnswer: (event) => events.push({ type: 'answer', ...event }),
    });

    const answer = await ask({
      toolName: 'Bash',
      preview: 'git status',
      reason: 'needs approval',
    });

    expect(answer).toBe('allow');
    expect(events).toEqual([
      {
        type: 'prompt',
        toolName: 'Bash',
        preview: 'git status',
        reason: 'needs approval',
      },
      {
        type: 'answer',
        toolName: 'Bash',
        preview: 'git status',
        reason: 'needs approval',
        answer: 'allow',
      },
    ]);
  });
});
