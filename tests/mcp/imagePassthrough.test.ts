// MCP IMAGE PASSTHROUGH — an agent must be able to SEE what a tool rendered.
//
// Until this landed, `flattenCallResult` replaced every image block with the
// literal "[mcp:image content omitted]", so vision through an MCP tool was
// impossible no matter what the tool returned or which model was driving. The
// appleo Theme Studio hit this concretely: it rasterises the résumé it just
// restyled, hands back a well-formed image block, and the harness dropped it —
// so the theme agent kept designing blind.
//
// The images ride `ToolResult.newMessages`, which the orchestrator merges into
// the user message that answers the tool_use. That channel already existed for
// exactly this ("an image the model must see"); tool_result.content stays a
// string, so no one-way-door type change was needed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildMcpClientPool } from '@yevgetman/sov-sdk/mcp/client';
import { wrapMcpTool } from '@yevgetman/sov-sdk/mcp/toolWrapper';
import type { McpClientPool } from '@yevgetman/sov-sdk/mcp/types';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';

const FIXTURE = join(__dirname, 'fixtures', 'echo-server.ts');
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pool: McpClientPool;

beforeAll(async () => {
  pool = await buildMcpClientPool({
    servers: { fixture: { type: 'stdio', command: 'bun', args: [FIXTURE] } },
    log: () => {},
  });
});

afterAll(async () => {
  await pool.shutdown();
});

const ctx = { signal: new AbortController().signal } as unknown as ToolContext;

function toolFor(toolName: string) {
  return wrapMcpTool({ serverName: 'fixture', toolName, inputSchema: { type: 'object' } }, pool);
}

describe('MCP image passthrough', () => {
  test('an image block survives the call and is carried as an image the model sees', async () => {
    const result = await pool.call('fixture', 'shot', {}, ctx.signal);

    expect(result.text).toContain('rendered');
    expect(result.images).toBeDefined();
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]).toEqual({ mimeType: 'image/png', data: TINY_PNG });
    // The placeholder was the bug. It must not come back for a carried image.
    expect(result.text).not.toContain('[mcp:image content omitted]');
  });

  test('the wrapped tool returns the image as a user-role newMessage block', async () => {
    const tool = toolFor('shot');
    const out = await tool.call({}, ctx);

    expect(out.newMessages).toBeDefined();
    const blocks = out.newMessages?.flatMap((m) => m.content) ?? [];
    const image = blocks.find((b) => b.type === 'image');
    expect(image).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG },
    });
    // The orchestrator throws on a non-user role; every injected message must be user.
    for (const m of out.newMessages ?? []) expect(m.role).toBe('user');
  });

  test('an oversized image is DROPPED with a notice the model can act on', async () => {
    // Silent truncation is the failure mode that matters here: an agent told
    // nothing assumes it saw the render and describes it anyway.
    const result = await pool.call('fixture', 'huge', {}, ctx.signal);

    expect(result.images ?? []).toHaveLength(0);
    expect(result.text).toMatch(/mcp:image too large/i);
  });

  test('a text-only result is unchanged — no images key, same text', async () => {
    const result = await pool.call('fixture', 'echo', { text: 'plain' }, ctx.signal);
    expect(result.text).toBe('plain');
    expect(result.images ?? []).toHaveLength(0);
  });

  test('a text-only tool returns no newMessages, exactly as before', async () => {
    const tool = toolFor('echo');
    const out = await tool.call({ text: 'plain' }, ctx);
    expect(out.newMessages).toBeUndefined();
  });
});
