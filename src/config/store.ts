// Read/write helper for ~/.harness/config.json. Wraps the existing zod
// schema (src/config/schema.ts) with dot-path get/set/unset, atomic
// writes, value-literal parsing for CLI args, and secret redaction for
// display. Used by `sovereign config ...` and the `/config` slash.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Settings, SettingsSchema } from './schema.js';

const SECRET_KEYS = new Set(['apiKey', 'token']);
const SECRET_LIST_KEYS = new Set(['apiKeys']);

export function resolveConfigPath(envOverride?: string): string {
  return envOverride ?? process.env.HARNESS_CONFIG ?? join(homedir(), '.harness', 'config.json');
}

export function readConfig(path?: string): Settings {
  const file = resolveConfigPath(path);
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return SettingsSchema.parse(raw);
}

export function writeConfig(settings: Settings, path?: string): void {
  // Re-validate before writing so a programmatic error can't corrupt disk.
  const validated = SettingsSchema.parse(settings);
  const file = resolveConfigPath(path);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function splitPath(dotPath: string): string[] {
  const trimmed = dotPath.trim();
  if (!trimmed) throw new Error('config path must not be empty');
  return trimmed.split('.');
}

export function getAt(settings: Settings, dotPath: string): unknown {
  const keys = splitPath(dotPath);
  let cur: unknown = settings;
  for (const key of keys) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function setAt(settings: Settings, dotPath: string, value: unknown): Settings {
  const keys = splitPath(dotPath);
  const next = structuredClone(settings) as Record<string, unknown>;
  let cur: Record<string, unknown> = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] ?? '';
    const existing = cur[key];
    if (Array.isArray(existing)) {
      throw new Error(`refusing to traverse into array at "${keys.slice(0, i + 1).join('.')}"`);
    }
    if (existing === undefined || existing === null || typeof existing !== 'object') {
      const fresh: Record<string, unknown> = {};
      cur[key] = fresh;
      cur = fresh;
    } else {
      cur = existing as Record<string, unknown>;
    }
  }
  const last = keys[keys.length - 1] ?? '';
  cur[last] = value;
  return SettingsSchema.parse(next);
}

export function unsetAt(settings: Settings, dotPath: string): Settings {
  const keys = splitPath(dotPath);
  const next = structuredClone(settings) as Record<string, unknown>;
  const trail: Array<{ obj: Record<string, unknown>; key: string }> = [];
  let cur: Record<string, unknown> = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] ?? '';
    const existing = cur[key];
    if (existing === undefined || existing === null || typeof existing !== 'object') {
      return SettingsSchema.parse(next);
    }
    if (Array.isArray(existing)) {
      throw new Error(`refusing to traverse into array at "${keys.slice(0, i + 1).join('.')}"`);
    }
    trail.push({ obj: cur, key });
    cur = existing as Record<string, unknown>;
  }
  delete cur[keys[keys.length - 1] ?? ''];
  // Prune now-empty parents so the JSON stays tidy.
  for (let i = trail.length - 1; i >= 0; i--) {
    const { obj, key } = trail[i] ?? { obj: {}, key: '' };
    const child = obj[key] as Record<string, unknown>;
    if (Object.keys(child).length === 0) delete obj[key];
    else break;
  }
  return SettingsSchema.parse(next);
}

export function parseValueLiteral(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('{') || raw.startsWith('[') || raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall through to string.
    }
  }
  return raw;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k) && typeof v === 'string') {
      out[k] = '***';
    } else if (SECRET_LIST_KEYS.has(k) && Array.isArray(v)) {
      out[k] = v.map(() => '***');
    } else if (k === 'credentials' && Array.isArray(v)) {
      out[k] = v.map((entry) => redactSecrets(entry));
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out as T;
}

export function formatValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
