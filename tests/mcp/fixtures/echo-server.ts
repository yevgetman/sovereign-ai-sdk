// Tiny MCP server fixture used by client.test.ts. Speaks the SDK's stdio
// transport. Exposes:
//   - `echo`: returns whatever string was passed in.
//   - `boom`: always returns an isError result (used to verify error path).
//   - `slow`: sleeps for ms before returning (used to verify abort path).
//   - `shot`: returns a text block AND a real image block (the vision path).
//   - `huge`: returns an image over the size cap (verifies the drop notice).
//
// Run via `bun tests/mcp/fixtures/echo-server.ts` — the spawned subprocess
// the test pool connects to.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'echo-fixture', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Return the input text verbatim',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'boom',
      description: 'Always fails',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'slow',
      description: 'Sleeps before returning',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'number' } },
        required: ['ms'],
      },
    },
    {
      name: 'shot',
      description: 'Returns a text block and an image block',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'huge',
      description: 'Returns an image past the size cap',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

// A 1x1 PNG — the smallest thing that is unambiguously a real image.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'echo') {
    const text = (args as { text?: string } | undefined)?.text ?? '';
    return { content: [{ type: 'text', text }] };
  }
  if (name === 'boom') {
    return {
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    };
  }
  if (name === 'shot') {
    return {
      content: [
        { type: 'text', text: 'rendered' },
        { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
      ],
    };
  }
  if (name === 'huge') {
    // Comfortably past any sane per-image cap.
    return {
      content: [{ type: 'image', data: 'A'.repeat(12_000_000), mimeType: 'image/png' }],
    };
  }
  if (name === 'slow') {
    const ms = (args as { ms?: number } | undefined)?.ms ?? 100;
    await new Promise((r) => setTimeout(r, ms));
    return { content: [{ type: 'text', text: `slept ${ms}ms` }] };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
