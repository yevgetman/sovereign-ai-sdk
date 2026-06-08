// In-process Streamable HTTP MCP echo server for the remote-transport tests.
//
// Mirrors the stdio `echo-server.ts` fixture but speaks the SDK's
// Streamable HTTP transport over a real `Bun.serve` listener, so the
// remote client tests exercise an actual HTTP round-trip (not a mock).
//
// It records every inbound `Authorization` / `X-API-Key` header it sees
// so a test can assert the env-first / config auth resolver wired the
// header through.
//
// Stateless mode (`sessionIdGenerator: undefined`) keeps the fixture
// simple — no session-id handshake. Per the SDK contract a stateless
// transport cannot be reused across requests, so a fresh Server +
// transport is built for every inbound request (the documented
// stateless pattern).
//
// Tools:
//   - echo: returns whatever string was passed in.
//   - boom: always returns an isError result.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export type HttpEchoServer = {
  /** Base URL the client should connect to (the MCP endpoint). */
  url: string;
  /** Every `Authorization` header value seen on an inbound request. */
  seenAuthHeaders: string[];
  /** Every `X-API-Key` header value seen on an inbound request. */
  seenApiKeyHeaders: string[];
  /** Stop the listener. */
  close: () => Promise<void>;
};

function buildServer(): Server {
  const server = new Server(
    { name: 'http-echo-fixture', version: '0.0.1' },
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
      return {
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  });

  return server;
}

/** Handle one inbound request with a fresh stateless Server + transport.
 *  `enableJsonResponse` makes each POST a self-contained request/response
 *  (no long-lived SSE stream), so the per-request server can be left to
 *  GC once the response settles. */
async function handleOnce(req: Request): Promise<Response> {
  const server = buildServer();
  // Omitting `sessionIdGenerator` selects stateless mode (no session-id
  // handshake). `enableJsonResponse` makes each POST a self-contained
  // request/response so the per-request server can be left to GC.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

/** Start an in-process Streamable HTTP MCP echo server on an ephemeral
 *  port. Returns the connect URL plus the recorded inbound auth headers. */
export async function startHttpEchoServer(): Promise<HttpEchoServer> {
  const seenAuthHeaders: string[] = [];
  const seenApiKeyHeaders: string[] = [];

  const listener = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get('authorization');
      if (auth !== null) seenAuthHeaders.push(auth);
      const apiKey = req.headers.get('x-api-key');
      if (apiKey !== null) seenApiKeyHeaders.push(apiKey);
      return handleOnce(req);
    },
  });

  return {
    url: `http://127.0.0.1:${listener.port}/mcp`,
    seenAuthHeaders,
    seenApiKeyHeaders,
    async close() {
      listener.stop(true);
    },
  };
}
