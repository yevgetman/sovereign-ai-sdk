// Settings loader. Phase 5 reads ~/.harness/config.json (or HARNESS_CONFIG)
// and validates it with Zod. Project/local layering lands later with Phase 6.
//
// Source of pattern: Claude Code src/schemas/ + settings layer convention.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Settings, SettingsSchema } from './schema.js';

export type LoadSettingsOpts = {
  path?: string;
  env?: NodeJS.ProcessEnv;
};

export function loadSettings(opts: LoadSettingsOpts = {}): Settings {
  const env = opts.env ?? process.env;
  const path = opts.path ?? env.HARNESS_CONFIG ?? join(homedir(), '.harness', 'config.json');
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return SettingsSchema.parse(raw);
}
