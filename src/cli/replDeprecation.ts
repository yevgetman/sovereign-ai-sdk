// M12 — readline REPL deprecation warning helper.
//
// Per ADR M11-03, M11 deliberately left `--ui repl` silent so users had
// a clear escape hatch during the default-flip soak. M11.5 closed the
// remaining feature gaps that made the TUI usable (#41 + #43). M12
// starts the deprecation clock so users on REPL learn it's going away
// before M13 removes the surface entirely.
//
// The helper is pure (takes resolved source + env, returns string or
// null) so the message-content + suppression behavior can be exercised
// without spinning up Commander or a full Runtime.
//
// Predicate semantics — see ADR M12-01:
//   - Fires when source ∈ {'cli', 'env', 'config'} (user explicitly opted
//     into REPL) and SOV_NO_DEPRECATION_WARNING ≠ '1'.
//   - Stays silent on source='default' (defense against a future shift
//     back to default-REPL; today unreachable because M11 defaults to
//     'tui').
//   - Stays silent on missing-binary fallback because that path doesn't
//     touch source at all — the caller in src/main.ts checks
//     `resolution.surface`, not `effectiveSurface`, before invoking
//     this helper.

import type { SurfaceResolution } from './surfaceResolver.js';

export type SurfaceSource = SurfaceResolution['source'];

export interface FormatReplDeprecationInput {
  readonly source: SurfaceSource;
  readonly env: NodeJS.ProcessEnv;
}

/** Returns the deprecation warning text (with trailing newline) when
 *  one should be emitted, or null when it should be suppressed. M12. */
export function formatReplDeprecationMessage(input: FormatReplDeprecationInput): string | null {
  if (input.env.SOV_NO_DEPRECATION_WARNING === '1') return null;
  if (input.source === 'default') return null;
  const sourceLabel = sourceToLabel(input.source);
  return `sov: the readline REPL is deprecated and will be removed in M13.
     (you opted in via ${sourceLabel} — the TUI is the default and now feature-complete).
     set SOV_NO_DEPRECATION_WARNING=1 to silence this warning.
`;
}

function sourceToLabel(source: SurfaceSource): string {
  switch (source) {
    case 'cli':
      return '--ui repl';
    case 'env':
      return 'SOV_UI=repl';
    case 'config':
      return 'ui.surface=repl';
    case 'default':
      // Unreachable per the M11 default; preserved for type exhaustion.
      return 'default';
  }
}
