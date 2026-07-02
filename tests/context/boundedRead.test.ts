// Bounded context-file reads (F12). readBoundedUtf8 caps the number of bytes
// pulled off disk so a multi-GB hint/context file in an untrusted repo can
// never be slurped whole (OOM) before screening truncates the output.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CONTEXT_BYTES, readBoundedUtf8 } from '@yevgetman/sov-sdk/context/boundedRead';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sov-bounded-read-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readBoundedUtf8', () => {
  test('caps allocation at MAX_CONTEXT_BYTES for an oversize file', () => {
    withTmp((dir) => {
      const path = join(dir, 'big.md');
      const fileBytes = MAX_CONTEXT_BYTES + 64 * 1024;
      writeFileSync(path, 'a'.repeat(fileBytes));

      const out = readBoundedUtf8(path);
      // The returned string — BEFORE any screenContextFile truncation — is
      // already bounded, proving the READ itself is capped (statSync-gated),
      // not merely the downstream output.
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(fileBytes);
    });
  });

  test('returns the exact content unchanged for a file under the cap', () => {
    withTmp((dir) => {
      const path = join(dir, 'small.md');
      const content = 'small hint body\nline two\n';
      writeFileSync(path, content);
      expect(readBoundedUtf8(path)).toBe(content);
    });
  });

  test('reads exactly up to the cap when the file is right at the boundary', () => {
    withTmp((dir) => {
      const path = join(dir, 'exact.md');
      writeFileSync(path, 'b'.repeat(MAX_CONTEXT_BYTES));
      const out = readBoundedUtf8(path);
      expect(Buffer.byteLength(out, 'utf8')).toBe(MAX_CONTEXT_BYTES);
    });
  });
});
