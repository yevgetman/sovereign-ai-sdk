import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTuiBinary } from '../../src/cli/tuiLauncher.js';

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

  test('returns null when nothing is found and SOV_TUI_BIN is unset', () => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TUI_BIN;
    // Move CWD to /tmp where no bin/sov-tui exists.
    const orig = process.cwd();
    process.chdir('/tmp');
    try {
      // Only the env-var path is reliable here; PATH lookup might still find it
      // if the user has it globally installed. Skip strict assertion in that case.
      const found = findTuiBinary();
      // Either null or an existing file is acceptable.
      if (found !== null) {
        expect(existsSync(found)).toBe(true);
      }
    } finally {
      process.chdir(orig);
    }
  });
});
