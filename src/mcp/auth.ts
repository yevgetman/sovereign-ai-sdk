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

/** Trim an env value; an empty string (after trim) is treated as absent. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Case-insensitive check for whether a header is already present. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/** Set `name: value`, replacing any existing case-variant key in place (so
 *  an env override doesn't leave a stale lowercase `authorization` alongside
 *  a new `Authorization` — HTTP would otherwise send both). Returns a NEW
 *  object; never mutates the input. */
function setHeaderReplacing(
  headers: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const lower = name.toLowerCase();
  const next: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) next[key] = val;
  }
  next[name] = value;
  return next;
}

/** Build the outbound HTTP headers for a remote MCP server.
 *
 *  Precedence per auth header is env > committed-header > field, so an
 *  operator can rotate a secret via the env var even when a (possibly
 *  stale) header is committed in config:
 *  - Starts from `cfg.headers` (copied, never mutated).
 *  - `Authorization`: `SOV_MCP_<ALIAS>_TOKEN` wins over any committed
 *    `Authorization` header, which wins over `cfg.bearerToken`. The env
 *    token is emitted as `Authorization: Bearer <token>`.
 *  - `X-API-Key`: `SOV_MCP_<ALIAS>_API_KEY` wins over any committed
 *    `X-API-Key` header, which wins over `cfg.apiKey`.
 *
 *  Stdio configs carry no auth fields, so an empty header set is returned
 *  (the stdio transport never consumes it). */
export function resolveMcpHeaders(
  alias: string,
  cfg: McpServerConfig,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (cfg.type === 'stdio') return {};

  let headers: Record<string, string> = { ...(cfg.headers ?? {}) };
  const prefix = `SOV_MCP_${normalizeAliasForEnv(alias)}`;

  // Authorization: env wins outright; else keep a committed header; else
  // fall back to the convenience `bearerToken` field.
  const envToken = trimmedOrUndefined(env[`${prefix}_TOKEN`]);
  if (envToken !== undefined) {
    headers = setHeaderReplacing(headers, 'Authorization', `Bearer ${envToken}`);
  } else if (!hasHeader(headers, 'Authorization')) {
    const cfgToken = trimmedOrUndefined(cfg.bearerToken);
    if (cfgToken !== undefined) headers.Authorization = `Bearer ${cfgToken}`;
  }

  // X-API-Key: same precedence.
  const envApiKey = trimmedOrUndefined(env[`${prefix}_API_KEY`]);
  if (envApiKey !== undefined) {
    headers = setHeaderReplacing(headers, 'X-API-Key', envApiKey);
  } else if (!hasHeader(headers, 'X-API-Key')) {
    const cfgApiKey = trimmedOrUndefined(cfg.apiKey);
    if (cfgApiKey !== undefined) headers['X-API-Key'] = cfgApiKey;
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
