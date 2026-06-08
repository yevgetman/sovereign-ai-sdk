// In-process legacy-SSE MCP echo server for the remote-transport tests.
//
// The SDK's `SSEServerTransport` is built around Node's `http`
// `IncomingMessage` / `ServerResponse` (not the Web-standard Request/
// Response that `Bun.serve` uses), so this fixture runs a real `node:http`
// server in-process and lets the SDK transport drive the SSE protocol
// faithfully — a genuine round-trip, not a mock.
//
// Protocol (legacy SSE): the client GETs the SSE endpoint to open the
// stream; the server replies with an `event: endpoint` frame naming the
// POST URL; the client POSTs JSON-RPC messages there; responses are pushed
// back over the held SSE stream.
//
// It records every header seen on the inbound GET (the SSE stream) so a
// test can assert the SDK's `Accept: text/event-stream` survived our header
// merge AND our resolved `Authorization` was injected.
//
// Tools: echo (returns the input text) and boom (always isError).

import { type IncomingMessage, type Server, createServer } from 'node:http';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export type SseEchoServer = {
  /** SSE stream URL the client connects to (GET). */
  url: string;
  /** Headers seen on the inbound GET that opened the SSE stream. */
  seenStreamHeaders: Record<string, string>;
  close: () => Promise<void>;
};

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'sse-echo-fixture', version: '0.0.1' },
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'echo') {
      const text = (args as { text?: string } | undefined)?.text ?? '';
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'boom') {
      return { content: [{ type: 'text', text: 'something went wrong' }], isError: true };
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  });

  return server;
}

function recordHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
  }
  return out;
}

/** Start an in-process SSE MCP echo server on an ephemeral port. */
export async function startSseEchoServer(): Promise<SseEchoServer> {
  let seenStreamHeaders: Record<string, string> = {};
  // One live transport at a time is enough for the single-client tests.
  let transport: SSEServerTransport | undefined;

  const httpServer: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/sse') {
        seenStreamHeaders = recordHeaders(req);
        // The SDK transport directs the client to POST to this endpoint.
        transport = new SSEServerTransport('/messages', res);
        const mcp = buildMcpServer();
        await mcp.connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        if (!transport) {
          res.writeHead(409).end('no active SSE stream');
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : 'error');
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/sse`,
    get seenStreamHeaders() {
      return seenStreamHeaders;
    },
    async close() {
      try {
        await transport?.close();
      } catch {
        // best-effort
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
