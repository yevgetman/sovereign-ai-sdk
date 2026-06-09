// Settings loader. Phase 5 reads ~/.harness/config.json (or HARNESS_CONFIG)
// and validates it with Zod. Project/local layering lands later with Phase 6.
//
// Source of pattern: Claude Code src/schemas/ + settings layer convention.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from './paths.js';
import { type Settings, SettingsSchema } from './schema.js';

export type LoadSettingsOpts = {
  path?: string;
  env?: NodeJS.ProcessEnv;
};

export function loadSettings(opts: LoadSettingsOpts = {}): Settings {
  const env = opts.env ?? process.env;
  const path = opts.path ?? env.HARNESS_CONFIG ?? join(resolveHarnessHome(env), 'config.json');
  // No config file → empty settings. `thinking` is a defaulted (output-
  // required) field, so the bare `{}` needs an assertion; the missing-file
  // contract is unchanged. Consumers that need the default read it defensively
  // (`settings.thinking?.effort ?? 'off'`) because this path skips the parse.
  if (!existsSync(path)) return {} as Settings;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return SettingsSchema.parse(raw);
}
