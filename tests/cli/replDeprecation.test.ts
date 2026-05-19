// M12 T1 — unit tests for the REPL deprecation warning helper.
//
// Covers the predicate semantics from spec §4.1 + ADRs M12-01 / M12-02:
//   - Fires on 'cli', 'env', 'config' sources.
//   - Stays silent on 'default' source.
//   - Suppressed by SOV_NO_DEPRECATION_WARNING=1 regardless of source.
//   - Message content references M13 + the suppression env-var name.

import { describe, expect, test } from 'bun:test';
import { formatReplDeprecationMessage } from '../../src/cli/replDeprecation.js';

describe('formatReplDeprecationMessage (M12)', () => {
  test('source=cli fires with --ui repl label', () => {
    const msg = formatReplDeprecationMessage({ source: 'cli', env: {} });
    expect(msg).not.toBeNull();
    expect(msg).toContain('--ui repl');
    expect(msg).toContain('deprecated');
    expect(msg).toContain('M13');
    expect(msg).toContain('SOV_NO_DEPRECATION_WARNING=1');
  });

  test('source=env fires with SOV_UI=repl label', () => {
    const msg = formatReplDeprecationMessage({ source: 'env', env: {} });
    expect(msg).not.toBeNull();
    expect(msg).toContain('SOV_UI=repl');
  });

  test('source=config fires with ui.surface=repl label', () => {
    const msg = formatReplDeprecationMessage({ source: 'config', env: {} });
    expect(msg).not.toBeNull();
    expect(msg).toContain('ui.surface=repl');
  });

  test('source=default returns null (defense against future default shift)', () => {
    const msg = formatReplDeprecationMessage({ source: 'default', env: {} });
    expect(msg).toBeNull();
  });

  test('SOV_NO_DEPRECATION_WARNING=1 suppresses for all sources', () => {
    const env = { SOV_NO_DEPRECATION_WARNING: '1' };
    expect(formatReplDeprecationMessage({ source: 'cli', env })).toBeNull();
    expect(formatReplDeprecationMessage({ source: 'env', env })).toBeNull();
    expect(formatReplDeprecationMessage({ source: 'config', env })).toBeNull();
    expect(formatReplDeprecationMessage({ source: 'default', env })).toBeNull();
  });

  test('SOV_NO_DEPRECATION_WARNING set to a value other than "1" does NOT suppress', () => {
    // The env-var check is strict-equal to '1' — empty string, '0',
    // 'true', etc. all leave the warning enabled. Documented behavior.
    const variants = ['', '0', 'true', 'yes', 'on'];
    for (const value of variants) {
      const msg = formatReplDeprecationMessage({
        source: 'cli',
        env: { SOV_NO_DEPRECATION_WARNING: value },
      });
      expect(msg).not.toBeNull();
    }
  });

  test('message ends with newline so callers can write it directly to stderr', () => {
    const msg = formatReplDeprecationMessage({ source: 'cli', env: {} });
    expect(msg).not.toBeNull();
    expect(msg?.endsWith('\n')).toBe(true);
  });
});
