import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWebsiteBuildEval, validateWebsiteArtifact } from '../../src/evals/websiteBuildEval.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-website-eval-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('website build eval', () => {
  test('fixture eval creates a workspace, validates artifacts, and records metadata', async () => {
    await withTmp(async (dir) => {
      const result = await runWebsiteBuildEval({
        workspace: dir,
        now: new Date('2026-04-27T12:00:00.000Z'),
      });

      expect(result.ok).toBe(true);
      expect(result.prompts[0]).toContain('make me a simple website');
      expect(result.transcript).toHaveLength(result.prompts.length);
      expect(result.metadata.commands).toContain('node --check estimator.js');
      expect(result.metadata.commands).toContain('local static server GET /');
      expect(result.metadata.session?.sessionId).toBe('fixture');
      expect(existsSync(join(dir, 'index.html'))).toBe(true);
      expect(existsSync(join(dir, 'style.css'))).toBe(true);
      expect(existsSync(join(dir, 'estimator.js'))).toBe(true);
      expect(existsSync(result.resultPath)).toBe(true);

      const recorded = JSON.parse(readFileSync(result.resultPath, 'utf8')) as typeof result;
      expect(recorded.ok).toBe(true);
      expect(recorded.metadata.createdAt).toBe('2026-04-27T12:00:00.000Z');
    });
  });

  test('validator catches missing references and incomplete late renames', async () => {
    await withTmp(async (dir) => {
      writeFileSync(
        join(dir, 'index.html'),
        '<!doctype html><title>Ironclad Bikes</title><link rel="stylesheet" href="missing.css"><script src="estimator.js"></script>',
      );
      writeFileSync(join(dir, 'style.css'), 'body { color: black; }');
      writeFileSync(join(dir, 'estimator.js'), 'const ok = true;\n');

      const validation = await validateWebsiteArtifact(dir);
      const references = validation.checks.find((check) => check.name === 'local references exist');
      const rename = validation.checks.find((check) => check.name === 'late rename complete');

      expect(references?.ok).toBe(false);
      expect(references?.details).toContain('missing.css');
      expect(rename?.ok).toBe(false);
    });
  });
});
