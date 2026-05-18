// Phase 16.1 M11 — foreground-surface resolver.
//
// Resolves the desired UI surface (`tui` or `repl`) for a bare `sov`
// invocation using the precedence:
//
//   1. CLI flag (`--ui tui|repl`)
//   2. Env var (`SOV_UI=tui|repl`)
//   3. Config field (`ui.surface: 'tui' | 'repl'` in ~/.harness/config.json)
//   4. Default (`'tui'` after M11)
//
// Pure function — the caller passes the config and env explicitly so the
// resolver itself does no I/O and is trivially testable.
//
// Invalid CLI values print a one-line stderr warning so users notice
// typos and fall through to env/config. Invalid env values fall through
// silently (env typos shouldn't spam stderr on every boot). Invalid
// config values cannot reach here — `SettingsSchema` rejects them at
// `readConfig()` time.

import type { Settings } from '../config/schema.js';

export type Surface = 'tui' | 'repl';

export interface SurfaceResolution {
  readonly surface: Surface;
  readonly source: 'cli' | 'env' | 'config' | 'default';
}

export interface SurfaceResolverInput {
  /** Raw `opts.ui` value from Commander. Undefined when the user
   *  passed no `--ui` flag. */
  readonly cliFlag?: string | undefined;
  /** Process env to read SOV_UI from. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Loaded settings (caller should pass `readConfig()`). May be
   *  undefined if config-load fails — resolver treats it as empty. */
  readonly config?: Settings | undefined;
  /** Injectable stderr writer for tests; defaults to
   *  `process.stderr.write`. */
  readonly stderr?: ((message: string) => void) | undefined;
}

const VALID: ReadonlySet<Surface> = new Set(['tui', 'repl']);

function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && VALID.has(value as Surface);
}

export function resolveSurface(input: SurfaceResolverInput): SurfaceResolution {
  const stderr = input.stderr ?? ((m: string) => process.stderr.write(m));

  // 1. CLI flag
  if (input.cliFlag !== undefined) {
    if (isSurface(input.cliFlag)) {
      return { surface: input.cliFlag, source: 'cli' };
    }
    stderr(
      `sov: unknown --ui value '${input.cliFlag}' (expected 'tui' or 'repl'); falling back to env/config.\n`,
    );
  }

  // 2. Env var
  const envValue = (input.env ?? process.env).SOV_UI;
  if (isSurface(envValue)) {
    return { surface: envValue, source: 'env' };
  }

  // 3. Config field
  const configSurface = input.config?.ui?.surface;
  if (isSurface(configSurface)) {
    return { surface: configSurface, source: 'config' };
  }

  // 4. Default
  return { surface: 'tui', source: 'default' };
}
