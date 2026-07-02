// Unit tests for the shared crash-safe description resolver
// (safeStaticToolDescription). This is the single helper that four static
// tool-schema assembly sites route through; it must handle every corner of the
// `(input) => string | Promise<string>` description contract uniformly and never
// leave a process-killing unhandled rejection.

import { describe, expect, test } from 'bun:test';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { safeStaticToolDescription } from '@yevgetman/sov-sdk/tool/staticDescription';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';
import {
  asyncRejectingDescriptionTool,
  asyncResolvingDescriptionTool,
  collectUnhandledRejections,
} from '../helpers/asyncDescription.js';

function tool(name: string, description: unknown): Tool<unknown, unknown> {
  return buildTool({
    name,
    // biome-ignore lint/suspicious/noExplicitAny: exercising off-contract descriptions
    description: description as any,
    inputSchema: z.object({ msg: z.string() }),
    async call(input) {
      return { data: input };
    },
  }) as unknown as Tool<unknown, unknown>;
}

describe('safeStaticToolDescription', () => {
  test('plain string description is returned verbatim', () => {
    expect(safeStaticToolDescription(tool('T', () => 'hello world'))).toBe('hello world');
  });

  test('synchronous throw degrades to the tool name', () => {
    expect(
      safeStaticToolDescription(
        // biome-ignore lint/suspicious/noExplicitAny: input-dependent description throws on undefined
        tool('SyncThrow', (i: any) => `Search ${i.mode}`),
      ),
    ).toBe('SyncThrow');
  });

  test('non-string (number) return fails closed to the tool name', () => {
    expect(safeStaticToolDescription(tool('NumberDesc', () => 42))).toBe('NumberDesc');
  });

  test('non-string (object) return fails closed to the tool name', () => {
    expect(safeStaticToolDescription(tool('ObjectDesc', () => ({ evil: true })))).toBe(
      'ObjectDesc',
    );
  });

  test('non-string (null) return fails closed to the tool name', () => {
    expect(safeStaticToolDescription(tool('NullDesc', () => null))).toBe('NullDesc');
  });

  test('resolving async description degrades to the tool name', () => {
    expect(safeStaticToolDescription(asyncResolvingDescriptionTool('AsyncOk'))).toBe('AsyncOk');
  });

  test('rejecting async description degrades to the tool name', () => {
    expect(safeStaticToolDescription(asyncRejectingDescriptionTool('AsyncBad'))).toBe('AsyncBad');
  });

  test('the return type is always a string', () => {
    for (const t of [
      tool('A', () => 'x'),
      tool('B', () => 7),
      tool('C', () => null),
      asyncResolvingDescriptionTool('D'),
      asyncRejectingDescriptionTool('E'),
    ]) {
      expect(typeof safeStaticToolDescription(t)).toBe('string');
    }
  });

  test('a rejecting async description leaves NO unhandled process rejection', async () => {
    const rejections = await collectUnhandledRejections(() => {
      safeStaticToolDescription(asyncRejectingDescriptionTool());
    });
    expect(rejections).toEqual([]);
  });
});
