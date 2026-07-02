import { describe, expect, test } from 'bun:test';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { buildToolSearchTool, matchTools } from '@yevgetman/sov-sdk/tools/ToolSearchTool';
import { z } from 'zod';

function deferredTool(
  name: string,
  description: string,
  searchHint?: string,
): Tool<unknown, unknown> {
  return buildTool({
    name,
    description: () => description,
    inputSchema: z.unknown(),
    inputJSONSchema: { type: 'object', properties: { x: { type: 'string' } } },
    shouldDefer: true,
    ...(searchHint ? { searchHint } : {}),
    async call() {
      return { data: 'ok' };
    },
  }) as unknown as Tool<unknown, unknown>;
}

// A deferred tool whose description is input-dependent — valid per the public
// `(input) => string` contract — so it throws when describeStatic calls it with
// the `undefined` publication sentinel.
function throwingDescriptionTool(name: string): Tool<unknown, unknown> {
  return buildTool({
    name,
    // biome-ignore lint/suspicious/noExplicitAny: input-dependent description under test
    description: (i: any) => `Search ${i.mode}`,
    inputSchema: z.unknown(),
    inputJSONSchema: { type: 'object', properties: { x: { type: 'string' } } },
    shouldDefer: true,
    async call() {
      return { data: 'ok' };
    },
  }) as unknown as Tool<unknown, unknown>;
}

const ctx = {
  cwd: process.cwd(),
  sessionId: 'test',
};

describe('ToolSearchTool', () => {
  test('keyword search matches by name', () => {
    const tools = [
      deferredTool('mcp__github__create_issue', 'Open a GitHub issue', 'github issue'),
      deferredTool('mcp__fs__read_file', 'Read a filesystem file', 'read file'),
    ];
    const matched = matchTools('github', tools);
    expect(matched.map((t) => t.name)).toEqual(['mcp__github__create_issue']);
  });

  test('keyword search matches by searchHint', () => {
    const tools = [
      deferredTool('mcp__a__x', 'no match here', 'find files quickly'),
      deferredTool('mcp__b__y', 'totally different', 'something else'),
    ];
    const matched = matchTools('files', tools);
    expect(matched.map((t) => t.name)).toEqual(['mcp__a__x']);
  });

  test('keyword search is case-insensitive', () => {
    const tools = [deferredTool('mcp__GitHub__create', 'Open Issue', 'GitHub')];
    expect(matchTools('github', tools).map((t) => t.name)).toEqual(['mcp__GitHub__create']);
    expect(matchTools('GITHUB', tools).map((t) => t.name)).toEqual(['mcp__GitHub__create']);
  });

  test('empty query returns every deferred tool', () => {
    const tools = [deferredTool('a', 'A'), deferredTool('b', 'B')];
    expect(matchTools('', tools).map((t) => t.name)).toEqual(['a', 'b']);
  });

  test('no match returns empty', () => {
    const tools = [deferredTool('a', 'A', 'alpha')];
    expect(matchTools('zzzzz', tools)).toEqual([]);
  });

  test('select:name1,name2 returns named tools verbatim', () => {
    const tools = [
      deferredTool('mcp__a__x', 'A', 'a hint'),
      deferredTool('mcp__b__y', 'B', 'b hint'),
      deferredTool('mcp__c__z', 'C', 'c hint'),
    ];
    const matched = matchTools('select:mcp__a__x,mcp__c__z', tools);
    expect(matched.map((t) => t.name)).toEqual(['mcp__a__x', 'mcp__c__z']);
  });

  test('select: skips unknown names rather than throwing', () => {
    const tools = [deferredTool('a', 'A')];
    const matched = matchTools('select:a,does-not-exist', tools);
    expect(matched.map((t) => t.name)).toEqual(['a']);
  });

  test('matched entries carry the verbatim inputJSONSchema', () => {
    const tools = [deferredTool('a', 'A')];
    const matched = matchTools('a', tools);
    expect(matched[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    });
  });

  test('throwing input-dependent description degrades to the tool name instead of crashing', () => {
    const tools = [
      throwingDescriptionTool('mcp__throws__search'),
      deferredTool('mcp__ok__read', 'reads a file', 'read'),
    ];
    expect(() => matchTools('', tools)).not.toThrow();
    const matched = matchTools('', tools);
    expect(matched.map((t) => t.name)).toEqual(['mcp__throws__search', 'mcp__ok__read']);
    // Throwing tool falls back to its name; the other serializes normally.
    expect(matched[0]?.description).toBe('mcp__throws__search');
    expect(matched[1]?.description).toBe('reads a file');
  });

  test('Tool wrapper: call() routes through the live getter', async () => {
    let pool = [deferredTool('a', 'first', 'first tool')];
    const tool = buildToolSearchTool(() => pool);
    const r1 = await tool.call({ query: 'first' }, ctx);
    expect(r1.data.matched.map((t) => t.name)).toEqual(['a']);

    // Mutate the pool — getter sees the new state on the next call.
    pool = [deferredTool('b', 'second', 'second tool')];
    const r2 = await tool.call({ query: 'first' }, ctx);
    expect(r2.data.matched).toEqual([]);
  });

  test('renderResult formats matched tools with name + description + JSON schema block', () => {
    const tools = [deferredTool('mcp__x__y', 'desc')];
    const tool = buildToolSearchTool(() => tools);
    const out = {
      matched: [{ name: 'mcp__x__y', description: 'desc', inputSchema: { type: 'object' } }],
    };
    const rendered = tool.renderResult?.(out);
    expect(rendered?.content).toContain('mcp__x__y');
    expect(rendered?.content).toContain('desc');
    expect(rendered?.content).toContain('"type": "object"');
  });

  test('renderResult returns helpful empty-message when nothing matched', () => {
    const tool = buildToolSearchTool(() => []);
    const rendered = tool.renderResult?.({ matched: [] });
    expect(rendered?.content).toContain('No matching deferred tools');
  });
});
