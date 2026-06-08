// Runtime permission settings. This is separate from provider config
// (~/.harness/config.json): Phase 7 settings are layered across user,
// project, and project-local files with strict precedence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { HookConfig, HookEventName } from '../hooks/types.js';
import { normalizeAliasForEnv } from '../mcp/auth.js';
import { type McpServerConfig, isRemoteMcpConfig } from '../mcp/types.js';
import { type PermissionRule, type PermissionRuleLayer, parsePermissionRules } from './rules.js';

export const PermissionModeSchema = z.enum(['default', 'ask', 'bypass']);
export type RuntimePermissionMode = z.infer<typeof PermissionModeSchema>;

const PermissionRuleSetSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
  })
  .strict()
  .default({});

const HookCommandSpecSchema = z
  .object({
    type: z.literal('command'),
    command: z.string(),
    timeout: z.number().int().positive().optional(),
  })
  .strict();

const HookConfigSchema = z
  .object({
    matcher: z.string().optional(),
    hooks: z.array(HookCommandSpecSchema),
  })
  .strict();

const HooksSettingsSchema = z
  .object({
    PreToolUse: z.array(HookConfigSchema).optional(),
    PostToolUse: z.array(HookConfigSchema).optional(),
    UserPromptSubmit: z.array(HookConfigSchema).optional(),
    Stop: z.array(HookConfigSchema).optional(),
  })
  .strict();

// One MCP server config. A backward-compatible discriminated union over the
// `type` discriminant across three transports: stdio (the original — legacy
// `{command,...}` configs with no `type` still parse and round-trip as
// `type:'stdio'`), plus remote `http` (Streamable HTTP — the current MCP
// standard) and legacy `sse`.
//
// A `z.discriminatedUnion` gives native, single, per-member errors (no
// double-error, and a missing/required field is reported against that field
// by path). To preserve back-compat for legacy stdio configs that predate
// the `type` discriminant, a `z.preprocess` injects `type:'stdio'` for a
// `{command,...}` object with no `type` — and ONLY that case (it returns a
// new object, never mutating the input, and never adds an issue). Everything
// else (a remote `{url}` with no `type`, a `{command,url}` mix, an unknown
// key) flows straight to the discriminated union and gets its native error.
const McpRemoteFieldsSchema = {
  url: z.string().url(),
  /** Static headers merged onto every request to the server. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Convenience: becomes `Authorization: Bearer <token>` unless an
   *  explicit `Authorization` header is already set. Prefer the
   *  `SOV_MCP_<ALIAS>_TOKEN` env var in shared repos — never commit. */
  bearerToken: z.string().optional(),
  /** Convenience: becomes `X-API-Key: <apiKey>` unless already set.
   *  Prefer `SOV_MCP_<ALIAS>_API_KEY` in shared repos. */
  apiKey: z.string().optional(),
} as const;

const McpHttpConfigSchema = z
  .object({ type: z.literal('http'), ...McpRemoteFieldsSchema })
  .strict();

const McpSseConfigSchema = z.object({ type: z.literal('sse'), ...McpRemoteFieldsSchema }).strict();

// `type` is a plain literal (NOT `.default('stdio')`): the preprocess below
// supplies it for legacy `{command}` configs, so a default here is both
// redundant and would break the discriminator's required-key semantics.
const McpStdioConfigSchema = z
  .object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict();

const McpServerConfigUnion = z.discriminatedUnion('type', [
  McpStdioConfigSchema,
  McpHttpConfigSchema,
  McpSseConfigSchema,
]);

const McpServerConfigSchema = z.preprocess((raw) => {
  // Back-compat ONLY: a legacy stdio config is `{command,...}` with no
  // `type`. Inject the discriminant so it parses as stdio. Return a NEW
  // object (no mutation). Any other shape passes through untouched so the
  // discriminated union produces its own native, single error.
  if (typeof raw === 'object' && raw !== null && 'command' in raw && !('type' in raw)) {
    return { type: 'stdio', ...raw };
  }
  return raw;
}, McpServerConfigUnion);

export const RuntimeSettingsSchema = z
  .object({
    permissionMode: PermissionModeSchema.optional(),
    permissions: PermissionRuleSetSchema.optional(),
    hooks: HooksSettingsSchema.optional(),
    mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  })
  .strict();

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

export type PermissionSettingsLayerName = 'local' | 'project' | 'user';

export type LoadedPermissionSettings = {
  mode: RuntimePermissionMode;
  layers: PermissionRuleLayer[];
  sources: string[];
};

type LoadPermissionSettingsOpts = {
  cwd: string;
  harnessHome: string;
};

type SettingsPath = {
  name: PermissionSettingsLayerName;
  path: string;
};

export function getPermissionSettingsPaths(opts: LoadPermissionSettingsOpts): SettingsPath[] {
  const cwd = resolve(opts.cwd);
  return [
    { name: 'local', path: join(cwd, '.harness', 'settings.local.json') },
    { name: 'project', path: join(cwd, '.harness', 'settings.json') },
    { name: 'user', path: join(opts.harnessHome, 'settings.json') },
  ];
}

export function loadPermissionSettings(opts: LoadPermissionSettingsOpts): LoadedPermissionSettings {
  const discovered: Array<{ source: string; settings: RuntimeSettings }> = [];
  for (const item of getPermissionSettingsPaths(opts)) {
    if (!existsSync(item.path)) continue;
    const raw = JSON.parse(readFileSync(item.path, 'utf8')) as unknown;
    discovered.push({ source: item.path, settings: RuntimeSettingsSchema.parse(raw) });
  }

  let mode: RuntimePermissionMode = 'default';
  const modeSource = discovered.find((entry) => entry.settings.permissionMode !== undefined);
  if (modeSource?.settings.permissionMode !== undefined) mode = modeSource.settings.permissionMode;

  const layers: PermissionRuleLayer[] = [];
  for (const entry of discovered) {
    const permissions = entry.settings.permissions ?? { allow: [], deny: [], ask: [] };
    const rules: PermissionRule[] = [
      ...parsePermissionRules('deny', permissions.deny),
      ...parsePermissionRules('allow', permissions.allow),
      ...parsePermissionRules('ask', permissions.ask),
    ];
    if (rules.length > 0) layers.push({ source: entry.source, rules });
  }

  return {
    mode,
    layers,
    sources: discovered.map((entry) => entry.source),
  };
}

export type LoadedHookSettings = {
  hooksByEvent: Record<HookEventName, HookConfig[]>;
  sources: string[];
};

/** Load hooks from the same layered settings.json files as permissions, in
 *  precedence order (local → project → user). All non-empty layers are
 *  *concatenated*; later layers do not shadow earlier ones (matches Claude
 *  Code semantics — multiple settings files contribute additively, and
 *  blanket denial is achieved per-event via a hook script that exits 2). */
export function loadHookSettings(opts: LoadPermissionSettingsOpts): LoadedHookSettings {
  const hooksByEvent: Record<HookEventName, HookConfig[]> = {
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    Stop: [],
  };
  const sources: string[] = [];
  for (const item of getPermissionSettingsPaths(opts)) {
    if (!existsSync(item.path)) continue;
    const raw = JSON.parse(readFileSync(item.path, 'utf8')) as unknown;
    const settings = RuntimeSettingsSchema.parse(raw);
    if (!settings.hooks) continue;
    sources.push(item.path);
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const) {
      const layer = settings.hooks[event];
      if (layer && layer.length > 0) hooksByEvent[event].push(...layer);
    }
  }
  return { hooksByEvent, sources };
}

export type LoadedMcpServerSettings = {
  servers: Record<string, McpServerConfig>;
  sources: string[];
};

/** Load MCP server configs from the layered settings.json files, in
 *  precedence order (local → project → user). Servers from multiple layers
 *  are concatenated by alias. Duplicate aliases across layers are an error
 *  — the user must rename one or pick a single source. */
export function loadMcpServerSettings(opts: LoadPermissionSettingsOpts): LoadedMcpServerSettings {
  const servers: Record<string, McpServerConfig> = {};
  const aliasOrigin: Record<string, string> = {};
  // Track which REMOTE alias claimed each normalized SOV_MCP_* env-var
  // fragment, so two remote aliases that collapse to the same env var (e.g.
  // `foo-bar` and `foo_bar` → SOV_MCP_FOO_BAR_*) are rejected — otherwise one
  // server's injected token would silently apply to the other host. Stdio
  // aliases never read SOV_MCP_* auth env (`resolveMcpHeaders` returns `{}`),
  // so they are excluded from this check: a benign stdio+remote fragment
  // collision must not hard-fail boot.
  const envFragmentOrigin: Record<string, string> = {};
  const sources: string[] = [];
  for (const item of getPermissionSettingsPaths(opts)) {
    if (!existsSync(item.path)) continue;
    const raw = JSON.parse(readFileSync(item.path, 'utf8')) as unknown;
    const settings = RuntimeSettingsSchema.parse(raw);
    if (!settings.mcpServers) continue;
    sources.push(item.path);
    for (const [alias, cfg] of Object.entries(settings.mcpServers)) {
      if (alias in servers) {
        throw new Error(
          `mcp server alias "${alias}" is defined in both ${aliasOrigin[alias]} and ${item.path}; rename one.`,
        );
      }
      // Only remote aliases consume SOV_MCP_<FRAG>_* auth env, so only they
      // can suffer a real env-fragment collision. Stdio aliases skip this.
      if (isRemoteMcpConfig(cfg)) {
        const fragment = normalizeAliasForEnv(alias);
        const collidingAlias = envFragmentOrigin[fragment];
        if (collidingAlias !== undefined && collidingAlias !== alias) {
          throw new Error(
            `mcp server aliases "${collidingAlias}" and "${alias}" both map to the ` +
              `SOV_MCP_${fragment}_* environment variables; rename one so their auth env vars don't collide.`,
          );
        }
        envFragmentOrigin[fragment] = alias;
      }
      servers[alias] = cfg;
      aliasOrigin[alias] = item.path;
    }
  }
  return { servers, sources };
}

export function appendProjectLocalPermissionRule(opts: {
  cwd: string;
  rule: string;
  behavior: 'allow';
}): void {
  const path = join(resolve(opts.cwd), '.harness', 'settings.local.json');
  const settings = readRuntimeSettingsIfPresent(path);
  const permissions = settings.permissions ?? { allow: [], deny: [], ask: [] };
  const nextAllow = permissions.allow.includes(opts.rule)
    ? permissions.allow
    : [...permissions.allow, opts.rule];
  const next: RuntimeSettings = {
    ...settings,
    permissions: {
      allow: nextAllow,
      deny: permissions.deny,
      ask: permissions.ask,
    },
  };
  mkdirSync(join(resolve(opts.cwd), '.harness'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function readRuntimeSettingsIfPresent(path: string): RuntimeSettings {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return RuntimeSettingsSchema.parse(raw);
}
