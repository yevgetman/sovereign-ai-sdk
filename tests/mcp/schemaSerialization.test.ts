import { describe, expect, test } from 'bun:test';
import { toToolSchemas } from '@yevgetman/sov-sdk/mcp/schemaSerialization';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

function nativeTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'NativeFoo',
    description: () => 'native foo description',
    inputSchema: z.object({ msg: z.string() }),
    async call(input) {
      return { data: input };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function deferredTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'mcp__github__create_issue',
    description: () => 'Create a GitHub issue with title and body',
    inputSchema: z.unknown(),
    inputJSONSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    searchHint: 'Open a new GitHub issue',
    shouldDefer: true,
    async call() {
      return { data: 'ok' };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function jsonSchemaButNotDeferredTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'CustomJSONSchemaTool',
    description: () => 'custom',
    inputSchema: z.unknown(),
    inputJSONSchema: {
      type: 'object',
      properties: { x: { type: 'number' } },
    },
    async call() {
      return { data: 'ok' };
    },
  }) as unknown as Tool<unknown, unknown>;
}

describe('toToolSchemas', () => {
  test('native tool: Zod input schema is converted', () => {
    const out = toToolSchemas([nativeTool()]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('NativeFoo');
    expect(out[0]?.description).toBe('native foo description');
    expect(out[0]?.input_schema).toEqual({
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
    });
  });

  test('deferred tool: searchHint becomes the description; schema is the minimal passthrough', () => {
    const out = toToolSchemas([deferredTool()]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('mcp__github__create_issue');
    expect(out[0]?.description).toContain('Open a new GitHub issue');
    expect(out[0]?.description).toContain('ToolSearch');
    expect(out[0]?.input_schema).toEqual({ type: 'object', additionalProperties: true });
  });

  test('inputJSONSchema (non-deferred) is emitted verbatim', () => {
    const out = toToolSchemas([jsonSchemaButNotDeferredTool()]);
    expect(out[0]?.input_schema).toEqual({
      type: 'object',
      properties: { x: { type: 'number' } },
    });
  });

  test('mixed pool preserves order and applies the right path per tool', () => {
    const out = toToolSchemas([nativeTool(), deferredTool(), jsonSchemaButNotDeferredTool()]);
    expect(out.map((t) => t.name)).toEqual([
      'NativeFoo',
      'mcp__github__create_issue',
      'CustomJSONSchemaTool',
    ]);
  });
});
