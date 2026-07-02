// System context snapshot tests. Git output may be unavailable in tmp dirs,
// but the stable runtime fields should still be present and formatted.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSystemContext, getSystemContext } from '@yevgetman/sov-sdk/context/system';

describe('getSystemContext', () => {
  test('captures date, cwd, shell, os, and git snapshot fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sovereign-system-context-'));
    try {
      const context = getSystemContext({
        cwd: dir,
        now: new Date('2026-04-25T12:00:00.000Z'),
        env: { SHELL: '/bin/zsh' },
      });
      expect(context.date).toBe('2026-04-25T12:00:00.000Z');
      expect(context.cwd).toBe(dir);
      expect(context.shell).toBe('/bin/zsh');
      expect(context.os.length).toBeGreaterThan(0);
      expect(context.gitStatus.length).toBeGreaterThan(0);
      expect(context.gitRecentCommits.length).toBeGreaterThan(0);
      expect(context.gitRecentBranches.length).toBeGreaterThan(0);

      const formatted = formatSystemContext(context);
      expect(formatted).toContain('<runtime-context>');
      expect(formatted).toContain('date: 2026-04-25T12:00:00.000Z');
      expect(formatted).toContain('git status:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
