// Tiny MCP server fixture used by client.test.ts. Speaks the SDK's stdio
// transport. Exposes:
//   - `echo`: returns whatever string was passed in.
//   - `boom`: always returns an isError result (used to verify error path).
//   - `slow`: sleeps for ms before returning (used to verify abort path).
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
  ],
}));

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
  if (name === 'slow') {
    const ms = (args as { ms?: number } | undefined)?.ms ?? 100;
    await new Promise((r) => setTimeout(r, ms));
    return { content: [{ type: 'text', text: `slept ${ms}ms` }] };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
