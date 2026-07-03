// Read/write helper for ~/.harness/config.json. Wraps the existing zod
// schema (src/config/schema.ts) with dot-path get/set/unset, atomic
// writes, value-literal parsing for CLI args, and secret redaction for
// display. Used by `sov config ...` and the `/config` slash.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secureWriteFileAtomic } from '../util/secureFs.js';
import { resolveHarnessHome } from './paths.js';
import { type Settings, SettingsSchema } from './schema.js';

const SECRET_KEYS = new Set([
  'apiKey',
  'token',
  // Channel secrets (gateway.channels.*) — schema-valid config that must not
  // print in clear from `sov config show` or any dump (audit 2026-06-10).
  'botToken',
  'signingSecret',
  'authToken',
  'secret',
  // Twilio SMS creds — schema.ts documents accountSid/authToken/fromNumber as
  // secrets. `authToken` was already redacted; `accountSid` and `fromNumber`
  // leaked in clear, an inconsistency with the schema's stated intent.
  'accountSid',
  'fromNumber',
]);
const SECRET_LIST_KEYS = new Set(['apiKeys']);

/** Dotpath segments that would traverse into the prototype chain. Rejected
 *  before any walk so `set __proto__.x` / `unset constructor.y` can't pollute
 *  Object.prototype (audit 2026-06-10). */
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Resolve the config file path. Precedence: an explicit `envOverride` path →
 * `HARNESS_CONFIG` env → `<harnessHome>/config.json`.
 *
 * `harnessHome` (backlog #55) lets a caller that already resolved its own
 * state root (e.g. `buildRuntime`, which accepts a `harnessHome` option) point
 * the FALLBACK at THAT home rather than the process-global `resolveHarnessHome()`
 * (which reads `$HARNESS_HOME` / `homedir()`). When omitted the fallback is the
 * global home — byte-identical to the prior behavior. The two explicit
 * overrides still win, so this only changes where an otherwise-default lookup
 * lands.
 */
export function resolveConfigPath(envOverride?: string, harnessHome?: string): string {
  return (
    envOverride ??
    process.env.HARNESS_CONFIG ??
    join(harnessHome ?? resolveHarnessHome(), 'config.json')
  );
}

export interface ReadConfigOptions {
  /** Explicit config file path. Highest precedence (matches the historical
   *  positional `path` argument). */
  path?: string;
  /** Backlog #55 — fall back to `<harnessHome>/config.json` instead of the
   *  process-global home when neither an explicit path nor `HARNESS_CONFIG`
   *  is set. */
  harnessHome?: string;
}

/**
 * Read + validate the config file. Accepts either the legacy positional
 * `path` string or a {@link ReadConfigOptions} object (which adds the
 * `harnessHome` fallback for #55). Returns `{}` when the resolved file is
 * absent.
 */
export function readConfig(pathOrOpts?: string | ReadConfigOptions): Settings {
  const opts: ReadConfigOptions =
    typeof pathOrOpts === 'string' ? { path: pathOrOpts } : (pathOrOpts ?? {});
  const file = resolveConfigPath(opts.path, opts.harnessHome);
  // No config file → the empty settings object. Every field is optional on
  // the output `Settings`, so `{}` IS a valid Settings; consumers that need a
  // default read it defensively (`settings.thinking?.effort ?? 'off'`).
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return SettingsSchema.parse(raw);
}

/**
 * Read the config file WITHOUT validating it. Returns the raw parsed JSON (or
 * `{}` when the file is absent). The gateway uses this to inject env-sourced
 * secrets into `gateway.channels` BEFORE {@link SettingsSchema} validates the
 * merged object (the schema requires channel secrets in config and stays
 * env-free; see `src/channels/listeners.ts`). Most callers want the validated
 * {@link readConfig}.
 */
export function readRawConfig(path?: string): Record<string, unknown> {
  const file = resolveConfigPath(path);
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    // Defer the precise structural complaint to SettingsSchema.parse; here we
    // only need an object to merge env into.
    return {};
  }
  return raw as Record<string, unknown>;
}

export function writeConfig(settings: Settings, path?: string): void {
  // Re-validate before writing so a programmatic error can't corrupt disk.
  const validated = SettingsSchema.parse(settings);
  const file = resolveConfigPath(path);
  // config.json is the secret-densest state file — apiKey / token / botToken /
  // signingSecret / Twilio authToken live here IN CLEARTEXT (they're only masked
  // for display). The earlier F10/F16 perms sweep missed it (audit C6), leaving
  // it world-readable 0644 in a 0755 dir. Write it 0600 in a 0700 dir via the
  // shared atomic secure writer, matching every sibling state sink.
  secureWriteFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
}

function splitPath(dotPath: string): string[] {
  const trimmed = dotPath.trim();
  if (!trimmed) throw new Error('config path must not be empty');
  const keys = trimmed.split('.');
  for (const key of keys) {
    if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
      throw new Error(`config path segment "${key}" is not allowed`);
    }
  }
  return keys;
}

// Accepts the broad object type as well as Settings — getAt only walks the
// shape generically (it never depends on Settings' field set), and several
// callers pass a redacted / raw `Record<string, unknown>` projection
// (`redactSecrets(settings)` in main.ts, the `as Record<string, unknown>`
// casts in configOps.ts). Keeping the param wide avoids a forest of casts at
// those call sites.
export function getAt(settings: Settings | Record<string, unknown>, dotPath: string): unknown {
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
