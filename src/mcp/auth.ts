// Auth + redaction helpers for remote MCP transports (HTTP / SSE).
//
// `resolveMcpHeaders` builds the outbound header set for a remote server,
// applying env-first precedence (env > config) for the bearer token and
// API key. The `env` map is injected (not read from `process.env`
// directly) so the resolver is pure and tests never mutate the process
// environment.
//
// SECURITY: tokens and resolved headers are NEVER logged. The status +
// error surfaces use `redactUrlAuth` / `serializeMcpServerConfig`, which
// emit only the origin — never headers, query strings, or userinfo.

import type { McpServerConfig } from './types.js';

/** Normalize an MCP alias into the env-var fragment: uppercase, with every
 *  non-alphanumeric character replaced by `_`. `github-remote` →
 *  `GITHUB_REMOTE`, so the lookup keys are `SOV_MCP_GITHUB_REMOTE_TOKEN`
 *  and `SOV_MCP_GITHUB_REMOTE_API_KEY`. */
export function normalizeAliasForEnv(alias: string): string {
  return alias.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Read an env value with config fallback. Both are trimmed; an empty
 *  string (after trim) is treated as absent. Precedence: env > config. */
function resolveSecret(
  envValue: string | undefined,
  configValue: string | undefined,
): string | undefined {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = configValue?.trim();
  if (fromConfig) return fromConfig;
  return undefined;
}

/** Case-insensitive check for whether a header is already present. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/** Build the outbound HTTP headers for a remote MCP server.
 *
 *  - Starts from `cfg.headers` (copied, never mutated).
 *  - `SOV_MCP_<ALIAS>_TOKEN` (else `cfg.bearerToken`) → `Authorization:
 *    Bearer <token>`, only when no `Authorization` header is already set.
 *  - `SOV_MCP_<ALIAS>_API_KEY` (else `cfg.apiKey`) → `X-API-Key: <key>`,
 *    only when no `X-API-Key` header is already set.
 *
 *  Stdio configs carry no auth fields, so an empty header set is returned
 *  (the stdio transport never consumes it). */
export function resolveMcpHeaders(
  alias: string,
  cfg: McpServerConfig,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (cfg.type === 'stdio') return {};

  const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
  const prefix = `SOV_MCP_${normalizeAliasForEnv(alias)}`;

  const token = resolveSecret(env[`${prefix}_TOKEN`], cfg.bearerToken);
  if (token !== undefined && !hasHeader(headers, 'Authorization')) {
    headers.Authorization = `Bearer ${token}`;
  }

  const apiKey = resolveSecret(env[`${prefix}_API_KEY`], cfg.apiKey);
  if (apiKey !== undefined && !hasHeader(headers, 'X-API-Key')) {
    headers['X-API-Key'] = apiKey;
  }

  return headers;
}

/** Reduce a URL to its origin (scheme + host + port), dropping the path,
 *  query string, and any embedded userinfo. Used on every status + error
 *  surface so a remote MCP endpoint never leaks a token-bearing query or
 *  `user:pass@` segment. Returns a placeholder for an unparseable URL. */
export function redactUrlAuth(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<invalid-url>';
  }
}

/** Transport-specific projection of a server config for the HarnessInfo
 *  status snapshot. Remote servers expose only `{ transport, url }` (the
 *  url redacted to its origin — never headers); stdio servers expose
 *  `{ transport, command, args }`. */
export type SerializedMcpServerConfig =
  | { transport: 'stdio'; command: string; args: string[] }
  | { transport: 'http' | 'sse'; url: string };

export function serializeMcpServerConfig(cfg: McpServerConfig): SerializedMcpServerConfig {
  if (cfg.type === 'stdio') {
    return { transport: 'stdio', command: cfg.command, args: cfg.args ?? [] };
  }
  return { transport: cfg.type, url: redactUrlAuth(cfg.url) };
}
