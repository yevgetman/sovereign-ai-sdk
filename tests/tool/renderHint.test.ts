// Phase 16.1 M3.1 — Tools may declare a renderHint for non-readline surfaces.
// The field is optional and falls through `buildTool()` to the returned `Tool`.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { buildTool } from '../../src/tool/buildTool.js';
import type { RenderHint } from '../../src/tool/types.js';

describe('renderHint', () => {
  test('Tool carries the renderHint declared on its ToolDef', () => {
    const hint: RenderHint = { kind: 'code', language: 'typescript' };
    const t = buildTool<{ x: number }, string>({
      name: 'TestTool',
      description: () => 'test',
      inputSchema: z.object({ x: z.number() }),
      call: async (input) => ({ data: String(input.x) }),
      renderHint: hint,
    });
    expect(t.renderHint).toEqual(hint);
  });

  test('Tool with no renderHint has it as undefined', () => {
    const t = buildTool<{ x: number }, string>({
      name: 'TestTool2',
      description: () => 'test',
      inputSchema: z.object({ x: z.number() }),
      call: async () => ({ data: 'ok' }),
    });
    expect(t.renderHint).toBeUndefined();
  });
});
