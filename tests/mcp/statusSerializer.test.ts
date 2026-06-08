// Tests for the HarnessInfo MCP status serializer's transport branch.
// Remote servers must serialize { transport, url } (origin-only, never
// headers); stdio servers keep { transport, command, args }.

import { describe, expect, test } from 'bun:test';
import { serializeMcpServerConfig } from '../../src/mcp/auth.js';

describe('serializeMcpServerConfig', () => {
  test('stdio serializes transport + command + args', () => {
    const out = serializeMcpServerConfig({
      type: 'stdio',
      command: 'fsd',
      args: ['--port', '5432'],
    });
    expect(out).toEqual({ transport: 'stdio', command: 'fsd', args: ['--port', '5432'] });
  });

  test('legacy stdio (no args) defaults args to []', () => {
    const out = serializeMcpServerConfig({ type: 'stdio', command: 'fsd' });
    expect(out).toEqual({ transport: 'stdio', command: 'fsd', args: [] });
  });

  test('http serializes transport + redacted url, never headers/command', () => {
    const out = serializeMcpServerConfig({
      type: 'http',
      url: 'https://user:pass@mcp.example.com/v1/tools?token=secret',
      headers: { Authorization: 'Bearer leak-me' },
      bearerToken: 'leak-me-too',
    });
    expect(out).toEqual({ transport: 'http', url: 'https://mcp.example.com' });
    expect(JSON.stringify(out)).not.toContain('leak-me');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect('command' in out).toBe(false);
  });

  test('sse serializes transport + redacted url', () => {
    const out = serializeMcpServerConfig({ type: 'sse', url: 'https://sse.example.com/v1' });
    expect(out).toEqual({ transport: 'sse', url: 'https://sse.example.com' });
  });
});
