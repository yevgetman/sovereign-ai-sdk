// Runtime permission settings. This is separate from provider config
// (~/.harness/config.json): Phase 7 settings are layered across user,
// project, and project-local files with strict precedence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { HookConfig, HookEventName } from '../hooks/types.js';
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

export const RuntimeSettingsSchema = z
  .object({
    permissionMode: PermissionModeSchema.optional(),
    permissions: PermissionRuleSetSchema.optional(),
    hooks: HooksSettingsSchema.optional(),
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
