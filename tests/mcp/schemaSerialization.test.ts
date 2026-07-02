import { describe, expect, test } from 'bun:test';
import { toToolSchemas } from '@yevgetman/sov-sdk/mcp/schemaSerialization';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';
import {
  asyncRejectingDescriptionTool,
  collectUnhandledRejections,
} from '../helpers/asyncDescription.js';

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

// A consumer tool whose description is input-dependent — valid per the public
// `(input) => string` Tool contract — and therefore throws when the provider
// tool-schema path calls it with the `undefined` publication sentinel.
function throwingDescriptionTool(): Tool<unknown, unknown> {
  return buildTool({
    // biome-ignore lint/suspicious/noExplicitAny: input-dependent description under test
    description: (i: any) => `Search ${i.mode}`,
    name: 'ThrowingDesc',
    inputSchema: z.object({ mode: z.string() }),
    async call(input) {
      return { data: input };
    },
  }) as unknown as Tool<unknown, unknown>;
}

// A misbehaving tool whose description returns a NON-string (violates the
// `(input) => string` contract on purpose). Without a fail-closed guard the
// raw value leaks into the provider `tools[].description`, which the model
// request then rejects at the API boundary (400) — the exact class the guard
// closes. `value` lets one factory cover number/object/null variants.
function nonStringDescriptionTool(name: string, value: unknown): Tool<unknown, unknown> {
  return buildTool({
    name,
    // biome-ignore lint/suspicious/noExplicitAny: non-string description under test
    description: (() => value) as any,
    inputSchema: z.object({ msg: z.string() }),
    async call(input) {
      return { data: input };
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

  test('throwing input-dependent description degrades to the tool name instead of crashing', () => {
    expect(() => toToolSchemas([throwingDescriptionTool()])).not.toThrow();
    const out = toToolSchemas([throwingDescriptionTool()]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('ThrowingDesc');
    expect(out[0]?.description).toBe('ThrowingDesc');
    // The input schema still serializes normally.
    expect(out[0]?.input_schema).toEqual({
      type: 'object',
      properties: { mode: { type: 'string' } },
      required: ['mode'],
    });
  });

  test('one throwing tool in a mixed pool does not stop the others from serializing', () => {
    const out = toToolSchemas([
      nativeTool(),
      throwingDescriptionTool(),
      jsonSchemaButNotDeferredTool(),
    ]);
    expect(out.map((t) => t.name)).toEqual(['NativeFoo', 'ThrowingDesc', 'CustomJSONSchemaTool']);
    expect(out[0]?.description).toBe('native foo description');
    expect(out[1]?.description).toBe('ThrowingDesc'); // fell back to name
    expect(out[2]?.description).toBe('custom');
  });

  test('regression: normal input-independent function descriptions still serialize', () => {
    const out = toToolSchemas([nativeTool()]);
    expect(out[0]?.description).toBe('native foo description');
  });

  // C7: describeToStatic must fail CLOSED (to the tool name) on a non-string
  // description return, mirroring its three sibling guards — otherwise the raw
  // number/object/null leaks through toToolSchemas → provider.stream({tools})
  // into every request and the API rejects the turn (400).
  test('non-string (number) description fails closed to the tool name', () => {
    const out = toToolSchemas([nonStringDescriptionTool('NumberDesc', 42)]);
    expect(out[0]?.description).toBe('NumberDesc');
    expect(typeof out[0]?.description).toBe('string');
  });

  test('non-string (object) description fails closed to the tool name', () => {
    const out = toToolSchemas([nonStringDescriptionTool('ObjectDesc', { evil: true })]);
    expect(out[0]?.description).toBe('ObjectDesc');
    expect(typeof out[0]?.description).toBe('string');
  });

  test('non-string (null) description fails closed to the tool name', () => {
    const out = toToolSchemas([nonStringDescriptionTool('NullDesc', null)]);
    expect(out[0]?.description).toBe('NullDesc');
    expect(typeof out[0]?.description).toBe('string');
  });

  test('a non-string description in a mixed pool does not corrupt its siblings', () => {
    const out = toToolSchemas([
      nativeTool(),
      nonStringDescriptionTool('NumberDesc', 42),
      jsonSchemaButNotDeferredTool(),
    ]);
    expect(out.map((t) => t.name)).toEqual(['NativeFoo', 'NumberDesc', 'CustomJSONSchemaTool']);
    expect(out[0]?.description).toBe('native foo description');
    expect(out[1]?.description).toBe('NumberDesc'); // fell back to name
    expect(out[2]?.description).toBe('custom');
  });

  // G2: an async description that REJECTS must not leave a process-killing
  // unhandled rejection. describeToStatic degrades it to the tool name and
  // swallows the rejection via the shared safeStaticToolDescription helper.
  test('async-rejecting description degrades to the name without an unhandled rejection', async () => {
    const rejections = await collectUnhandledRejections(() => {
      const out = toToolSchemas([asyncRejectingDescriptionTool('evil_tool')]);
      expect(out).toHaveLength(1);
      expect(out[0]?.name).toBe('evil_tool');
      expect(out[0]?.description).toBe('evil_tool');
    });
    expect(rejections).toEqual([]);
  });
});
