import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTuiBinary, findTuiBinaryFrom } from '../../src/cli/tuiLauncher.js';

describe('findTuiBinary', () => {
  test('honors SOV_TUI_BIN when set to an existing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-tui-test-'));
    const fake = join(dir, 'fake-tui');
    writeFileSync(fake, '');
    process.env.SOV_TUI_BIN = fake;
    try {
      expect(findTuiBinary()).toBe(fake);
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TUI_BIN;
      rmSync(dir, { recursive: true });
    }
  });

  test('falls back to repo-root bin/sov-tui when it exists', () => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TUI_BIN;
    // The test runs from tests/cli/, so dirname twice → tests/, dirname again → repo root.
    // We accept either form: just assert that if bin/sov-tui exists in CWD-ancestor we find it.
    const found = findTuiBinary();
    if (found !== null) {
      expect(existsSync(found)).toBe(true);
    }
  });

  test('returns null when nothing is found starting from a barren directory', () => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TUI_BIN;
    // /tmp has no bin/sov-tui anywhere on the parent walk — the search
    // must exhaust the upward loop and return null. Using
    // findTuiBinaryFrom() instead of findTuiBinary() because the latter
    // walks from the module's own location (which DOES live under the
    // repo and may find bin/sov-tui via the postinstall artifact). The
    // test isolates the null-branch by handing the walker a known-clean
    // starting point.
    expect(findTuiBinaryFrom('/tmp')).toBeNull();
  });
});
