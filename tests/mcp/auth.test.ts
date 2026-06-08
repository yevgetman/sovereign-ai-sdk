// Tests for the MCP remote-auth resolver. Pure functions with an
// injectable `env` map so the real process.env is never touched.

import { describe, expect, test } from 'bun:test';
import { normalizeAliasForEnv, redactUrlAuth, resolveMcpHeaders } from '../../src/mcp/auth.js';
import type { McpServerConfig } from '../../src/mcp/types.js';

function httpCfg(extra: Partial<Extract<McpServerConfig, { type: 'http' }>> = {}): McpServerConfig {
  return { type: 'http', url: 'https://mcp.example.com/v1', ...extra };
}

describe('normalizeAliasForEnv', () => {
  test('uppercases and replaces non-alphanumerics with underscore', () => {
    expect(normalizeAliasForEnv('github-remote')).toBe('GITHUB_REMOTE');
    expect(normalizeAliasForEnv('my.fancy server')).toBe('MY_FANCY_SERVER');
    expect(normalizeAliasForEnv('plain')).toBe('PLAIN');
  });
});

describe('resolveMcpHeaders', () => {
  test('env token beats config bearerToken (Authorization: Bearer)', () => {
    const headers = resolveMcpHeaders('remote', httpCfg({ bearerToken: 'cfg-tok' }), {
      SOV_MCP_REMOTE_TOKEN: 'env-tok',
    });
    expect(headers.Authorization).toBe('Bearer env-tok');
  });

  test('falls back to config bearerToken when env absent', () => {
    const headers = resolveMcpHeaders('remote', httpCfg({ bearerToken: 'cfg-tok' }), {});
    expect(headers.Authorization).toBe('Bearer cfg-tok');
  });

  test('env api key beats config apiKey (X-API-Key)', () => {
    const headers = resolveMcpHeaders('remote', httpCfg({ apiKey: 'cfg-key' }), {
      SOV_MCP_REMOTE_API_KEY: 'env-key',
    });
    expect(headers['X-API-Key']).toBe('env-key');
  });

  test('falls back to config apiKey when env absent', () => {
    const headers = resolveMcpHeaders('remote', httpCfg({ apiKey: 'cfg-key' }), {});
    expect(headers['X-API-Key']).toBe('cfg-key');
  });

  test('trims whitespace and treats empty as absent', () => {
    const headers = resolveMcpHeaders('remote', httpCfg({ bearerToken: '   ' }), {
      SOV_MCP_REMOTE_TOKEN: '  spaced-tok  ',
    });
    expect(headers.Authorization).toBe('Bearer spaced-tok');

    const none = resolveMcpHeaders('remote', httpCfg({ bearerToken: '   ' }), {
      SOV_MCP_REMOTE_TOKEN: '   ',
    });
    expect(none.Authorization).toBeUndefined();
  });

  test('normalizes alias when reading env keys', () => {
    const headers = resolveMcpHeaders('github-remote', httpCfg(), {
      SOV_MCP_GITHUB_REMOTE_TOKEN: 'gh-tok',
    });
    expect(headers.Authorization).toBe('Bearer gh-tok');
  });

  test('does not overwrite an explicit Authorization header', () => {
    const headers = resolveMcpHeaders(
      'remote',
      httpCfg({ headers: { Authorization: 'Custom keep-me' }, bearerToken: 'cfg-tok' }),
      { SOV_MCP_REMOTE_TOKEN: 'env-tok' },
    );
    expect(headers.Authorization).toBe('Custom keep-me');
  });

  test('does not overwrite an explicit X-API-Key header', () => {
    const headers = resolveMcpHeaders(
      'remote',
      httpCfg({ headers: { 'X-API-Key': 'keep-me' }, apiKey: 'cfg-key' }),
      { SOV_MCP_REMOTE_API_KEY: 'env-key' },
    );
    expect(headers['X-API-Key']).toBe('keep-me');
  });

  test('passes through unrelated config headers', () => {
    const headers = resolveMcpHeaders('remote', httpCfg({ headers: { 'X-Tenant': 'acme' } }), {});
    expect(headers['X-Tenant']).toBe('acme');
  });

  test('returns no auth headers for a stdio config', () => {
    const headers = resolveMcpHeaders(
      'local',
      { type: 'stdio', command: 'fsd' },
      {
        SOV_MCP_LOCAL_TOKEN: 'env-tok',
      },
    );
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
  });
});

describe('redactUrlAuth', () => {
  test('keeps origin, strips path/query/userinfo', () => {
    expect(redactUrlAuth('https://user:pass@mcp.example.com:8443/v1/tools?token=secret')).toBe(
      'https://mcp.example.com:8443',
    );
  });

  test('keeps a plain origin intact', () => {
    expect(redactUrlAuth('https://mcp.example.com/v1')).toBe('https://mcp.example.com');
  });

  test('returns a placeholder for an unparseable url', () => {
    expect(redactUrlAuth('not a url')).toBe('<invalid-url>');
  });
});
